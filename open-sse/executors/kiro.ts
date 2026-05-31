import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  type ExecuteInput,
  type ExecutorLog,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.ts";
import { normalizeKiroToolUseForClaude } from "../translator/kiroToolBridge.ts";

type JsonRecord = Record<string, unknown>;

type UsageSummary = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type KiroStreamState = {
  endDetected: boolean;
  finishEmitted: boolean;
  stopSeen: boolean;
  hasToolCalls: boolean;
  toolCallIndex: number;
  seenToolIds: Map<string, number>;
  totalContentLength?: number;
  contextUsagePercentage?: number;
  hasContextUsage?: boolean;
  hasMeteringEvent?: boolean;
  usage?: UsageSummary;
  estimatedInputTokens?: number;
};

type EventFrame = {
  headers: Record<string, string>;
  payload: JsonRecord | null;
};

type KiroRefreshResult = ProviderCredentials & {
  expiresIn?: number;
};

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private headOffset = 0;
  length = 0;

  push(chunk: Uint8Array) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peekUint32BE(offset = 0): number | null {
    if (this.length < offset + 4) return null;

    let value = 0;
    for (let i = 0; i < 4; i++) {
      value = (value << 8) | this.byteAt(offset + i);
    }
    return value >>> 0;
  }

  read(length: number): Uint8Array | null {
    if (length < 0 || this.length < length) return null;

    const output = new Uint8Array(length);
    let written = 0;

    while (written < length) {
      const head = this.chunks[0];
      const available = head.length - this.headOffset;
      const take = Math.min(available, length - written);
      output.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.length -= take;

      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }

    return output;
  }

  private byteAt(offset: number): number {
    let remaining = offset;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const start = i === 0 ? this.headOffset : 0;
      const available = chunk.length - start;
      if (remaining < available) {
        return chunk[start + remaining];
      }
      remaining -= available;
    }
    return 0;
  }
}

// ── CRC32 lookup table (IEEE polynomial, no dependency) ──
const CRC32_TABLE = new Uint32Array(256);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const KIRO_REFRESH_MAX_ATTEMPTS = 3;
const KIRO_REFRESH_RETRY_BASE_MS = 250;
const KIRO_AUTH_FAILURE_STATUSES = new Set([401, 403]);
const KIRO_DEDUPE_TTL_MS = 30_000;
const KIRO_BREAKER_FAILURE_THRESHOLD = 3;
const KIRO_BREAKER_COOLDOWN_MS = 60_000;

interface KiroDedupeSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

interface KiroDedupeEntry {
  expiresAt: number;
  promise: Promise<KiroDedupeSnapshot>;
}

interface KiroBreakerState {
  failures: number;
  openUntil: number;
  lastFailureAt: number;
}

const kiroInFlightResponses = new Map<string, KiroDedupeEntry>();
const kiroAccountBreakers = new Map<string, KiroBreakerState>();
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildKiroFinishChunk(
  state: KiroStreamState,
  responseId: string,
  created: number,
  model: string,
  includeUsage: boolean
): JsonRecord {
  const finishChunk: JsonRecord = {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: state.hasToolCalls ? "tool_calls" : "stop",
      },
    ],
  };

  if (includeUsage && state.usage) {
    finishChunk.usage = state.usage;
  }

  return finishChunk;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readRefreshRetryBaseMs(): number {
  const raw = Number(process.env.KIRO_REFRESH_RETRY_BASE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : KIRO_REFRESH_RETRY_BASE_MS;
}

function isKiroAuthFailureResponse(status: number, bodyText: string): boolean {
  if (KIRO_AUTH_FAILURE_STATUSES.has(status)) return true;
  if (status !== 400) return false;

  const normalized = bodyText.toLowerCase();
  return (
    normalized.includes("missing bearer token") ||
    normalized.includes("authorization") ||
    normalized.includes("unauthorized") ||
    normalized.includes("expired token") ||
    normalized.includes("invalid token") ||
    normalized.includes("token expired")
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function getKiroAccountKey(credentials: ProviderCredentials): string {
  if (credentials.connectionId) return `connection:${credentials.connectionId}`;
  const token =
    credentials.accessToken || credentials.apiKey || credentials.refreshToken || "anonymous";
  return `token:${hashString(token)}`;
}

function getKiroDedupeKey(model: string, transformedBody: unknown, accountKey: string): string {
  return `${accountKey}:${model}:${hashString(stableStringify(transformedBody))}`;
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function readKiroDedupeTtlMs(): number {
  return readPositiveNumberEnv("KIRO_DEDUPE_TTL_MS", KIRO_DEDUPE_TTL_MS);
}

function readKiroBreakerThreshold(): number {
  return readPositiveNumberEnv("KIRO_BREAKER_FAILURE_THRESHOLD", KIRO_BREAKER_FAILURE_THRESHOLD);
}

function readKiroBreakerCooldownMs(): number {
  return readPositiveNumberEnv("KIRO_BREAKER_COOLDOWN_MS", KIRO_BREAKER_COOLDOWN_MS);
}

function pruneKiroDedupe(now = Date.now()): void {
  for (const [key, entry] of kiroInFlightResponses) {
    if (entry.expiresAt <= now) kiroInFlightResponses.delete(key);
  }
}

function buildKiroCircuitOpenResponse(accountKey: string, retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Kiro account circuit breaker is open",
        type: "server_error",
        code: "kiro_account_circuit_open",
        account: accountKey,
      },
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    }
  );
}

function getKiroCircuitOpenMs(accountKey: string, now = Date.now()): number {
  const state = kiroAccountBreakers.get(accountKey);
  if (!state || state.openUntil <= now) return 0;
  return state.openUntil - now;
}

function resetKiroCircuit(accountKey: string): void {
  kiroAccountBreakers.delete(accountKey);
}

function isKiroBreakerFailure(status: number, bodyText: string): boolean {
  if (status === 429 || status === 401 || status === 403) return true;
  if (status !== 400 && status !== 402 && status !== 409) return false;

  const normalized = bodyText.toLowerCase();
  return (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("credit") ||
    normalized.includes("insufficient") ||
    isKiroAuthFailureResponse(status, bodyText)
  );
}

function recordKiroBreakerFailure(accountKey: string, log?: ExecutorLog | null): void {
  const now = Date.now();
  const threshold = readKiroBreakerThreshold();
  const cooldownMs = readKiroBreakerCooldownMs();
  const current = kiroAccountBreakers.get(accountKey);
  const failures =
    (current?.openUntil && current.openUntil > now ? current.failures : current?.failures || 0) + 1;
  const openUntil = failures >= threshold ? now + cooldownMs : 0;

  kiroAccountBreakers.set(accountKey, { failures, openUntil, lastFailureAt: now });

  if (openUntil > now) {
    log?.warn?.(
      "KIRO_CIRCUIT",
      `Kiro account circuit opened: account=${accountKey} failures=${failures} cooldownMs=${cooldownMs}`
    );
  }
}

export function resetKiroExecutorProtectionForTest(): void {
  kiroInFlightResponses.clear();
  kiroAccountBreakers.clear();
}

function ensureKiroUsage(state: KiroStreamState) {
  if (state.usage && state.usage.prompt_tokens > 0) return;

  const estimatedOutputTokens =
    state.totalContentLength && state.totalContentLength > 0
      ? Math.max(1, Math.floor(state.totalContentLength / 4))
      : 0;

  const prompt_tokens = state.usage?.prompt_tokens || state.estimatedInputTokens || 0;
  const completion_tokens = state.usage?.completion_tokens || estimatedOutputTokens;

  state.usage = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor(providerId = "kiro") {
    super(providerId, PROVIDERS[providerId] || PROVIDERS.kiro);
  }

  buildHeaders(credentials: ProviderCredentials, stream = true) {
    void stream;
    const rawToken = credentials.apiKey || credentials.accessToken || "";
    const bearerToken =
      typeof rawToken === "string"
        ? rawToken
            .trim()
            .replace(/^Bearer\s+/i, "")
            .trim()
        : "";
    const headers: Record<string, string> = {
      ...this.config.headers,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4(),
      "x-amzn-bedrock-cache-control": "enable",
      "anthropic-beta": "prompt-caching-2024-07-31",
    };

    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    // Debug trace: optionally log presence of credentials and Authorization header
    try {
      if (process.env.DEBUG_KIRO_TRACE === "1") {
        const tokenPreview =
          typeof bearerToken === "string" && bearerToken.length > 8
            ? `${bearerToken.slice(0, 8)}...(${bearerToken.length})`
            : String(bearerToken);

        console.debug(
          `[Kiro][TRACE] buildHeaders: credentialsPresent=${!!credentials}, accessTokenPresent=${!!(credentials && (credentials as any).accessToken)}, apiKeyPresent=${!!(credentials && (credentials as any).apiKey)}, tokenPreview=${tokenPreview}, authorizationHeader=${headers["Authorization"] ? "present" : "missing"}`
        );
      }
    } catch (err) {
      /* swallow logging errors */
    }

    return headers;
  }

  transformRequest(model: string, body: unknown, stream: boolean, credentials: unknown): unknown {
    void stream;
    void credentials;
    const b = body as Record<string, unknown>;

    // Kiro API is strict and rejects any unknown top-level fields (like 'tools', 'stream', 'model', etc.)
    // We only preserve the fields specifically built by the openai-to-kiro translator.
    const kiroPayload: Record<string, unknown> = {};
    if (b.conversationState !== undefined) kiroPayload.conversationState = b.conversationState;
    if (b.profileArn !== undefined) kiroPayload.profileArn = b.profileArn;
    if (b.inferenceConfig !== undefined) kiroPayload.inferenceConfig = b.inferenceConfig;
    if (b._omnirouteCompressionStats !== undefined) {
      kiroPayload._omnirouteCompressionStats = b._omnirouteCompressionStats;
    }

    // Fallback: if somehow conversationState isn't there, return the rest without model
    // (for backward compatibility if something else bypasses the translator)
    if (!kiroPayload.conversationState) {
      const { model: _model, ...rest } = b;
      delete rest.thinking;
      delete rest.context_management;
      delete rest.output_config;
      delete rest.tools;
      delete rest.tool_choice;
      delete rest.system;
      delete rest.stream;
      return rest;
    }

    return kiroPayload;
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response
   */
  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    upstreamExtraHeaders,
    onCredentialsRefreshed,
  }: ExecuteInput) {
    let activeCredentials = credentials;

    // Persist refreshed Kiro credentials to DB so they survive restarts.
    // onCredentialsRefreshed is absent in combo paths — fall back to direct DB write.
    const persistRefreshed = async (refreshed: ProviderCredentials) => {
      if (onCredentialsRefreshed) {
        await onCredentialsRefreshed(refreshed);
        return;
      }
      const connectionId = credentials?.connectionId;
      if (!connectionId) return;
      try {
        const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
        const refreshedWithExpiry = refreshed as KiroRefreshResult;
        const expiresAt = refreshedWithExpiry.expiresIn
          ? new Date(Date.now() + refreshedWithExpiry.expiresIn * 1000).toISOString()
          : undefined;
        await updateProviderConnection(connectionId, {
          ...(refreshed.accessToken ? { accessToken: refreshed.accessToken } : {}),
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(expiresAt ? { expiresAt, tokenExpiresAt: expiresAt } : {}),
        });
      } catch (err) {
        log?.warn?.(
          "TOKEN",
          `Kiro DB persist failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    // Proactively refresh if token is near expiry
    if (this.needsRefresh(credentials)) {
      try {
        const refreshed = await this.refreshCredentials(credentials, log || null);
        if (refreshed) {
          activeCredentials = { ...credentials, ...refreshed };
          await persistRefreshed(refreshed);
        }
      } catch (err) {
        log?.warn?.("TOKEN", `Kiro proactive refresh failed: ${toError(err).message}`);
      }
    }

    const accountKey = getKiroAccountKey(credentials);
    const openMs = getKiroCircuitOpenMs(accountKey);
    if (openMs > 0) {
      const circuitResponse = buildKiroCircuitOpenResponse(accountKey, openMs);
      return { response: circuitResponse, url: this.buildUrl(model, stream, 0), headers: {} };
    }

    const doFetch = async (creds: ProviderCredentials) => {
      const url = this.buildUrl(model, stream, 0);
      const headers = this.buildHeaders(creds, stream);
      mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
      try {
        if (process.env.DEBUG_KIRO_TRACE === "1") {
          const auth = headers["Authorization"] as string | undefined;
          const authPreview =
            auth && auth.length > 12 ? `${auth.slice(0, 12)}...(${auth.length})` : String(auth);

          console.debug(
            `[Kiro][TRACE] execute: url=${url} credentialsPresent=${!!creds} authorization=${auth ? "present" : "missing"} authPreview=${authPreview}`
          );
        }
      } catch (_err) {
        /* swallow logging errors */
      }
      const transformedBody = await this.transformRequest(model, body, stream, creds);
      const bodyForAws = { ...(transformedBody as Record<string, unknown>) };
      delete bodyForAws._omnirouteCompressionStats;
      const serializedBody = JSON.stringify(bodyForAws);
      const estimatedInputTokens = Math.ceil(serializedBody.length / 4);
      const dedupeKey = getKiroDedupeKey(model, transformedBody, getKiroAccountKey(creds));
      const dedupeTtlMs = readKiroDedupeTtlMs();
      pruneKiroDedupe();

      const existing = kiroInFlightResponses.get(dedupeKey);
      if (existing && existing.expiresAt > Date.now()) {
        log?.info?.("KIRO_DEDUPE", `Kiro request deduped: model=${model}`);
        const snapshot = await existing.promise;
        const response = new Response(Buffer.from(snapshot.bodyBase64, "base64"), {
          status: snapshot.status,
          statusText: snapshot.statusText,
          headers: snapshot.headers,
        });
        return { response, url, headers, transformedBody, estimatedInputTokens };
      }

      const responsePromise = fetch(url, {
        method: "POST",
        headers,
        body: serializedBody,
        signal,
      });

      if (stream) {
        const promise = responsePromise
          .then(async (dedupeResponse): Promise<KiroDedupeSnapshot> => {
            if (!dedupeResponse.ok) {
              kiroInFlightResponses.delete(dedupeKey);
              return {
                status: dedupeResponse.status,
                statusText: dedupeResponse.statusText,
                headers: Object.fromEntries(dedupeResponse.headers.entries()),
                bodyBase64: "",
              };
            }

            const clone = dedupeResponse.clone();
            const buffer = await clone.arrayBuffer();
            return {
              status: dedupeResponse.status,
              statusText: dedupeResponse.statusText,
              headers: Object.fromEntries(dedupeResponse.headers.entries()),
              bodyBase64: Buffer.from(buffer).toString("base64"),
            };
          })
          .finally(() => {
            setTimeout(() => kiroInFlightResponses.delete(dedupeKey), dedupeTtlMs).unref?.();
          });

        kiroInFlightResponses.set(dedupeKey, { expiresAt: Date.now() + dedupeTtlMs, promise });
      }

      const response = await responsePromise;
      if (!response.ok) {
        kiroInFlightResponses.delete(dedupeKey);
      }

      return { response, url, headers, transformedBody, estimatedInputTokens };
    };

    // Retry loop: respect Retry-After and apply exponential backoff + jitter
    const retriableStatus = new Set([429, 502, 503, 504]);
    const maxAttempts = 4;
    let attempt = 0;
    let response: Response | undefined = undefined;
    let url = "";
    let headers: Record<string, string> = {};
    let transformedBody: unknown = undefined;
    let estimatedInputTokens = 0;

    while (attempt < maxAttempts) {
      attempt++;
      ({ response, url, headers, transformedBody, estimatedInputTokens } =
        await doFetch(activeCredentials));

      // On auth failures — token expired/revoked, attempt refresh once before returning error.
      if (credentials?.refreshToken) {
        const bodyText = await response
          .clone()
          .text()
          .catch(() => "");
        if (isKiroAuthFailureResponse(response.status, bodyText)) {
          log?.warn?.("TOKEN", `Kiro ${response.status} auth failure — attempting refresh`);
          try {
            const refreshed = await this.refreshCredentials(credentials, log || null);
            if (refreshed) {
              activeCredentials = { ...credentials, ...refreshed };
              await persistRefreshed(refreshed);
              ({ response, url, headers, transformedBody, estimatedInputTokens } =
                await doFetch(activeCredentials));
            }
          } catch (err) {
            log?.warn?.("TOKEN", `Kiro refresh on auth failure failed: ${toError(err).message}`);
          }
        }
      }

      // If successful, break
      if (response.ok) break;

      // If status is retriable, compute wait
      const status = response.status;
      if (retriableStatus.has(status) && attempt < maxAttempts) {
        let waitMs = 1000 * Math.pow(2, attempt - 1); // 1s,2s,4s...
        // Respect Retry-After header if present (in seconds or http-date)
        try {
          const ra = response.headers.get("retry-after");
          if (ra) {
            const raInt = parseInt(ra, 10);
            if (!Number.isNaN(raInt)) {
              waitMs = Math.max(waitMs, raInt * 1000);
            } else {
              const date = Date.parse(ra);
              if (!Number.isNaN(date)) {
                const delta = date - Date.now();
                if (delta > 0) waitMs = Math.max(waitMs, delta);
              }
            }
          }
        } catch (_e) {
          /* ignore header parse errors */
        }

        // Add jitter
        const jitter = Math.floor(Math.random() * Math.min(1000, Math.floor(waitMs / 2)));
        waitMs = waitMs + jitter;

        log?.info?.("RETRY", `Kiro retry attempt=${attempt} status=${status} waitMs=${waitMs}`);
        await new Promise((res) => setTimeout(res, waitMs));
        continue; // next attempt
      }

      // Non-retriable or max attempts reached
      break;
    }

    if (!response || !response.ok) {
      if (response) {
        const bodyText = await response
          .clone()
          .text()
          .catch(() => "");
        if (isKiroBreakerFailure(response.status, bodyText)) {
          recordKiroBreakerFailure(accountKey, log || null);
        }
      }
      return { response, url, headers, transformedBody };
    }

    resetKiroCircuit(accountKey);

    // Emit lightweight telemetry/logging for Kiro executions
    try {
      log?.info?.(
        "KIRO_EXECUTE",
        `Kiro execute succeeded: model=${model} status=${response.status} attempt=${attempt} url=${url}`
      );
    } catch (_e) {
      /* swallow telemetry errors */
    }

    // For Kiro, we need to transform the binary EventStream to SSE
    // Create a TransformStream to convert binary to SSE text
    const transformedResponse = this.transformEventStreamToSSE(
      response,
      model,
      transformedBody,
      estimatedInputTokens
    );

    return { response: transformedResponse, url, headers, transformedBody };
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout
   */
  transformEventStreamToSSE(
    response: Response,
    model: string,
    transformedBody?: unknown,
    estimatedInputTokens: number = 0
  ) {
    const buffer = new ByteQueue();
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const state: KiroStreamState = {
      endDetected: false,
      finishEmitted: false,
      stopSeen: false,
      hasToolCalls: false,
      toolCallIndex: 0,
      seenToolIds: new Map(),
      estimatedInputTokens,
    };

    const emitFinishChunk = (
      controller: TransformStreamDefaultController<Uint8Array>,
      includeUsage: boolean
    ) => {
      if (state.finishEmitted) return;
      state.finishEmitted = true;
      if (includeUsage) ensureKiroUsage(state);
      const finishChunk = buildKiroFinishChunk(state, responseId, created, model, includeUsage);
      controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
    };

    const emitDone = (controller: TransformStreamDefaultController<Uint8Array>) => {
      if (state.endDetected) return;
      state.endDetected = true;
      controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        buffer.push(chunk);

        // Parse events from buffer
        let iterations = 0;
        const maxIterations = 1000;
        while (buffer.length >= 16 && iterations < maxIterations) {
          iterations++;
          const totalLength = buffer.peekUint32BE(0);

          if (!totalLength || totalLength < 16 || totalLength > buffer.length) break;

          const eventData = buffer.read(totalLength);
          if (!eventData) break;

          const event = parseEventFrame(eventData);
          if (!event) continue;

          const eventType = event.headers[":event-type"] || "";
          if (state.endDetected) continue;

          // Track total content length for token estimation
          if (!state.totalContentLength) state.totalContentLength = 0;
          if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

          // Handle assistantResponseEvent
          if (eventType === "assistantResponseEvent") {
            const content = typeof event.payload?.content === "string" ? event.payload.content : "";
            if (!content) {
              continue;
            }
            state.totalContentLength += content.length;

            const chunk: JsonRecord = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: chunkIndex === 0 ? { role: "assistant", content } : { content },
                  finish_reason: null,
                },
              ],
            };
            chunkIndex++;
            controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle codeEvent
          if (eventType === "codeEvent" && event.payload?.content) {
            const chunk: JsonRecord = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: event.payload.content },
                  finish_reason: null,
                },
              ],
            };
            chunkIndex++;
            controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle toolUseEvent
          if (eventType === "toolUseEvent" && event.payload) {
            state.hasToolCalls = true;
            const toolUse = event.payload;
            const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

            for (const singleToolUse of toolUses) {
              const baseToolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
              const claudeToolCalls = normalizeKiroToolUseForClaude(
                baseToolCallId,
                typeof singleToolUse.name === "string" ? singleToolUse.name : "",
                singleToolUse.input
              );

              for (const claudeToolCall of claudeToolCalls) {
                const toolCallId = claudeToolCall.id;
                const toolName = claudeToolCall.name;
                const argumentsStr = JSON.stringify(claudeToolCall.input || {});

                let toolIndex;
                const isNewTool = !state.seenToolIds.has(toolCallId);

                if (isNewTool) {
                  toolIndex = state.toolCallIndex++;
                  state.seenToolIds.set(toolCallId, toolIndex);

                  const startChunk = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                          tool_calls: [
                            {
                              index: toolIndex,
                              id: toolCallId,
                              type: "function",
                              function: {
                                name: toolName,
                                arguments: argumentsStr,
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  chunkIndex++;
                  controller.enqueue(
                    TEXT_ENCODER.encode(`data: ${JSON.stringify(startChunk)}\n\n`)
                  );
                } else {
                  toolIndex = state.seenToolIds.get(toolCallId);

                  const argsChunk = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolIndex,
                              function: {
                                arguments: argumentsStr,
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  chunkIndex++;
                  controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
                }
              }
            }
          }

          // Handle messageStopEvent
          if (eventType === "messageStopEvent") {
            state.stopSeen = true;
            // Claude Code does not execute tool calls until it receives the
            // terminal tool_calls finish event. Kiro may keep the EventStream
            // open for metrics after messageStopEvent, so emit the finish as
            // soon as the assistant turn has stopped instead of waiting for
            // stream close/flush.
            if (state.hasToolCalls) {
              emitFinishChunk(controller, false);
              emitDone(controller);
            }
          }

          // Handle contextUsageEvent to extract contextUsagePercentage
          if (eventType === "contextUsageEvent") {
            const contextUsage =
              typeof event.payload?.contextUsagePercentage === "number"
                ? event.payload.contextUsagePercentage
                : 0;
            if (contextUsage <= 0) {
              continue;
            }
            state.contextUsagePercentage = contextUsage;
            // Mark that we received context usage event
            state.hasContextUsage = true;
          }

          // Handle meteringEvent - mark that we received it
          if (eventType === "meteringEvent") {
            state.hasMeteringEvent = true;
          }

          // Handle metricsEvent for token usage
          if (eventType === "metricsEvent") {
            // Extract usage data from metricsEvent payload
            const metrics = event.payload?.metricsEvent || event.payload;
            if (metrics && typeof metrics === "object") {
              const inputTokens =
                typeof (metrics as JsonRecord).inputTokens === "number"
                  ? ((metrics as JsonRecord).inputTokens as number)
                  : 0;
              const outputTokens =
                typeof (metrics as JsonRecord).outputTokens === "number"
                  ? ((metrics as JsonRecord).outputTokens as number)
                  : 0;

              const cacheReadTokens =
                typeof (metrics as JsonRecord).cacheReadTokens === "number"
                  ? ((metrics as JsonRecord).cacheReadTokens as number)
                  : 0;

              const cacheCreationTokens =
                typeof (metrics as JsonRecord).cacheCreationTokens === "number"
                  ? ((metrics as JsonRecord).cacheCreationTokens as number)
                  : 0;

              if (inputTokens > 0 || outputTokens > 0) {
                state.usage = {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                  ...(cacheReadTokens > 0 && { cache_read_input_tokens: cacheReadTokens }),
                  ...(cacheCreationTokens > 0 && {
                    cache_creation_input_tokens: cacheCreationTokens,
                  }),
                };
              }
            }
          }
        }

        if (iterations >= maxIterations) {
          console.warn("[Kiro] Max iterations reached in event parsing");
        }
      },

      async flush(controller) {
        // Emit finish chunk if not already sent
        emitFinishChunk(controller, true);

        // Send final done message
        emitDone(controller);
        // Best-effort: persist usage to DB for token accounting
        try {
          const { insertKiroUsageRow } = await import("../../src/lib/db/kiroUsage.ts");
          const transformedRecord =
            transformedBody && typeof transformedBody === "object"
              ? (transformedBody as Record<string, unknown>)
              : null;
          const conversationState =
            transformedRecord?.conversationState &&
            typeof transformedRecord.conversationState === "object"
              ? (transformedRecord.conversationState as Record<string, unknown>)
              : null;
          const conversationId =
            typeof conversationState?.conversationId === "string"
              ? conversationState.conversationId
              : null;
          insertKiroUsageRow({
            timestamp: new Date().toISOString(),
            connection_id: undefined,
            conversation_id: conversationId,
            provider: "kiro",
            model,
            prompt_tokens: state.usage?.prompt_tokens ?? null,
            completion_tokens: state.usage?.completion_tokens ?? null,
            total_tokens: state.usage?.total_tokens ?? null,
            raw: JSON.stringify({ metrics: state.usage }).substring(0, 4000),
          });
        } catch (_e) {
          /* best-effort telemetry; swallow errors */
        }
      },
    });

    // Pipe response body through transform stream
    const responseBody = response.body;
    if (!responseBody) {
      return response;
    }

    const transformedStream = responseBody.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async refreshCredentials(credentials: ProviderCredentials, log?: ExecutorLog | null) {
    if (!credentials.refreshToken) return null;

    const retryBaseMs = readRefreshRetryBaseMs();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= KIRO_REFRESH_MAX_ATTEMPTS; attempt++) {
      try {
        // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
        const result = await refreshKiroToken(
          credentials.refreshToken,
          credentials.providerSpecificData,
          log
        );

        if (result) {
          if (result.error) return result;

          // If client was re-registered (expired/invalid clientId/clientSecret after DB import,
          // TTL expiry, or browser conflict), update providerSpecificData with new credentials (#2524).
          if (result._newClientId) {
            const updatedPsd = {
              ...(credentials.providerSpecificData || {}),
              clientId: result._newClientId,
              clientSecret: result._newClientSecret,
              clientSecretExpiresAt: result._newClientSecretExpiresAt,
            };
            return {
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              expiresIn: result.expiresIn,
              providerSpecificData: updatedPsd,
            };
          }

          return result;
        }

        log?.warn?.("TOKEN", `Kiro refresh attempt ${attempt} returned no credentials`);
      } catch (error) {
        lastError = toError(error);
        log?.warn?.("TOKEN", `Kiro refresh attempt ${attempt} failed: ${lastError.message}`);
      }

      if (attempt < KIRO_REFRESH_MAX_ATTEMPTS && retryBaseMs > 0) {
        await delay(retryBaseMs * Math.pow(2, attempt - 1));
      }
    }

    if (lastError) {
      log?.error?.("TOKEN", `Kiro refresh error: ${lastError.message}`);
    }
    return null;
  }
}

/**
 * Parse AWS EventStream frame
 */
export function parseKiroEventFrameForTest(data: Uint8Array): EventFrame | null {
  return parseEventFrame(data);
}

function parseEventFrame(data: Uint8Array): EventFrame | null {
  try {
    if (data.length < 16) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);

    if (totalLength !== data.length || headersLength > totalLength - 16) {
      console.warn(
        `[Kiro] Invalid frame length: total=${totalLength}, headers=${headersLength}, bytes=${data.length}`
      );
      return null;
    }

    // ── CRC32 validation ──
    // Prelude CRC covers bytes [0..7] (totalLength + headersLength)
    const preludeCRC = view.getUint32(8, false);
    const computedPreludeCRC = crc32(data.slice(0, 8));
    if (preludeCRC !== computedPreludeCRC) {
      console.warn(
        `[Kiro] Prelude CRC mismatch: expected ${preludeCRC}, got ${computedPreludeCRC} — skipping corrupted frame`
      );
      return null;
    }

    // Message CRC covers bytes [0..totalLength-5] (everything except the CRC itself)
    const messageCRC = view.getUint32(data.length - 4, false);
    const computedMessageCRC = crc32(data.slice(0, data.length - 4));
    if (messageCRC !== computedMessageCRC) {
      console.warn(
        `[Kiro] Message CRC mismatch: expected ${messageCRC}, got ${computedMessageCRC} — skipping corrupted frame`
      );
      return null;
    }
    // Parse headers
    const headers: Record<string, string> = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = TEXT_DECODER.decode(data.subarray(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      if (headerType === 7) {
        // String type
        if (offset + 2 > data.length) break;
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        const value = TEXT_DECODER.decode(data.subarray(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else {
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload: JsonRecord | null = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = TEXT_DECODER.decode(data.subarray(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch (parseError) {
        const err = parseError instanceof Error ? parseError : new Error(String(parseError));
        // Log parse error for debugging
        console.warn(
          `[Kiro] Failed to parse payload: ${err.message} | payload: ${payloadStr.substring(0, 100)}`
        );
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[Kiro] Frame parse error: ${error.message}`);
    return null;
  }
}

export default KiroExecutor;
