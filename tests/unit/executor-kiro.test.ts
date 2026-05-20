import test from "node:test";
import assert from "node:assert/strict";

import {
  KiroExecutor,
  parseKiroEventFrameForTest,
  resetKiroExecutorProtectionForTest,
} from "../../open-sse/executors/kiro.ts";

const textEncoder = new TextEncoder();

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatArrays(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function encodeHeader(name, value) {
  const nameBytes = textEncoder.encode(name);
  const valueBytes = textEncoder.encode(value);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset++] = nameBytes.length;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  header[offset++] = 7;
  header[offset++] = (valueBytes.length >> 8) & 0xff;
  header[offset++] = valueBytes.length & 0xff;
  header.set(valueBytes, offset);
  return header;
}

function buildEventFrame(eventType, payload) {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes =
    payload === null
      ? new Uint8Array()
      : typeof payload === "string"
        ? textEncoder.encode(payload)
        : textEncoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, crc32(frame.slice(0, 8)), false);
  frame.set(headers, 12);
  frame.set(payloadBytes, 12 + headers.length);
  view.setUint32(totalLength - 4, crc32(frame.slice(0, totalLength - 4)), false);
  return frame;
}

function buildEventStreamResponse(frames) {
  return buildEventStreamResponseFromChunks(frames);
}

function buildEventStreamResponseFromChunks(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    }
  );
}

function parseSSEJsonChunks(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

test("KiroExecutor.buildHeaders includes Kiro-specific auth and metadata", () => {
  const executor = new KiroExecutor();
  const headers = executor.buildHeaders({ accessToken: "kiro-token" }, true);

  assert.equal(headers.Authorization, "Bearer kiro-token");
  assert.equal(headers["anthropic-beta"], "prompt-caching-2024-07-31");
  assert.equal(headers["x-amzn-bedrock-cache-control"], "enable");
  assert.ok(headers["Amz-Sdk-Invocation-Id"]);
});

test("KiroExecutor.buildHeaders accepts apiKey tokens and strips duplicate bearer prefix", () => {
  const executor = new KiroExecutor();
  const headers = executor.buildHeaders(
    { accessToken: "", apiKey: "Bearer  kiro-api-token  " } as any,
    true
  );

  assert.equal(headers.Authorization, "Bearer kiro-api-token");
});

test("KiroExecutor.transformRequest removes the top-level model field", () => {
  const executor = new KiroExecutor();
  const body = {
    model: "kiro-model",
    conversationState: {
      currentMessage: {
        userInputMessage: {
          modelId: "kiro-model",
        },
      },
    },
  };

  const result = executor.transformRequest("kiro-model", body, true, {});
  assert.equal("model" in result, false);
  assert.equal(
    (result as any).conversationState.currentMessage.userInputMessage.modelId,
    "kiro-model"
  );
});

test("KiroExecutor.transformRequest strips unsupported fields in fallback mode", () => {
  const executor = new KiroExecutor();
  const body = {
    model: "kiro-model",
    thinking: { type: "enabled" },
    context_management: { clear_function_results: true },
    output_config: { format: "json" },
    tools: [{ type: "function" }],
    tool_choice: "auto",
    system: "rules",
    stream: true,
    prompt: "fallback body",
  };

  const result = executor.transformRequest("kiro-model", body, true, {});

  assert.equal("model" in result, false);
  assert.equal("thinking" in result, false);
  assert.equal("context_management" in result, false);
  assert.equal("output_config" in result, false);
  assert.equal("tools" in result, false);
  assert.equal("tool_choice" in result, false);
  assert.equal("system" in result, false);
  assert.equal("stream" in result, false);
  assert.equal((result as any).prompt, "fallback body");
});

test("KiroExecutor.transformEventStreamToSSE converts text, tool calls, usage and DONE", async () => {
  const executor = new KiroExecutor();
  const invalidPreludeFrame = buildEventFrame("assistantResponseEvent", { content: "skip me" });
  invalidPreludeFrame[8] ^= 0xff;

  const response = buildEventStreamResponse([
    invalidPreludeFrame,
    buildEventFrame("assistantResponseEvent", { content: "Hello " }),
    buildEventFrame("codeEvent", { content: "world" }),
    buildEventFrame("toolUseEvent", {
      toolUseId: "tool_1",
      name: "read_file",
      input: { path: "/tmp/a" },
    }),
    buildEventFrame("metricsEvent", { inputTokens: 4, outputTokens: 6 }),
    buildEventFrame("contextUsageEvent", { contextUsagePercentage: 10 }),
    buildEventFrame("meteringEvent", {}),
  ]);

  const transformed = executor.transformEventStreamToSSE(response, "kiro-model");
  const text = await transformed.text();

  assert.equal(transformed.status, 200);
  assert.equal(transformed.headers.get("Content-Type"), "text/event-stream");
  assert.match(text, /"content":"Hello "/);
  assert.match(text, /"content":"world"/);
  assert.match(text, /"name":"read_file"/);
  assert.match(text, /"arguments":"\{\\"path\\":\\"\/tmp\/a\\"\}"/);
  assert.match(text, /"prompt_tokens":4/);
  assert.match(text, /"completion_tokens":6/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /\[DONE\]/);
});

test("KiroExecutor.transformEventStreamToSSE parses fragmented frames and waits for post-stop usage", async () => {
  const executor = new KiroExecutor();
  const bytes = concatArrays(
    buildEventFrame("assistantResponseEvent", { content: "Hello fragmented" }),
    buildEventFrame("messageStopEvent", {}),
    buildEventFrame("metricsEvent", { inputTokens: 11, outputTokens: 13 }),
    buildEventFrame("contextUsageEvent", { contextUsagePercentage: 17 }),
    buildEventFrame("meteringEvent", {})
  );
  const response = buildEventStreamResponseFromChunks([
    bytes.subarray(0, 2),
    bytes.subarray(2, 9),
    bytes.subarray(9, 37),
    bytes.subarray(37, 91),
    bytes.subarray(91),
  ]);

  const transformed = executor.transformEventStreamToSSE(response, "kiro-model");
  const text = await transformed.text();
  const chunks = parseSSEJsonChunks(text);
  const finishChunks = chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason);

  assert.match(text, /"content":"Hello fragmented"/);
  assert.equal(finishChunks.length, 1);
  assert.equal(finishChunks[0].choices[0].finish_reason, "stop");
  assert.deepEqual(finishChunks[0].usage, {
    prompt_tokens: 11,
    completion_tokens: 13,
    total_tokens: 24,
  });
  assert.match(text, /\[DONE\]/);
});

test("KiroExecutor.transformEventStreamToSSE parses one-byte fragmented frames", async () => {
  const executor = new KiroExecutor();
  const frame = buildEventFrame("assistantResponseEvent", { content: "split" });
  const chunks = Array.from(frame, (byte) => new Uint8Array([byte]));
  const response = buildEventStreamResponseFromChunks(chunks);

  const transformed = executor.transformEventStreamToSSE(response, "kiro-model");
  const text = await transformed.text();
  const chunksJson = parseSSEJsonChunks(text);

  assert.ok(chunksJson.some((chunk) => chunk.choices?.[0]?.delta?.content === "split"));
  assert.match(text, /data: \[DONE\]/);
});

test("KiroExecutor.transformEventStreamToSSE skips truncated and CRC-corrupted frames", async () => {
  const executor = new KiroExecutor();
  const goodFrame = buildEventFrame("assistantResponseEvent", { content: "good" });
  const truncatedFrame = goodFrame.slice(0, goodFrame.length - 5);
  const corruptedFrame = goodFrame.slice();
  corruptedFrame[corruptedFrame.length - 1] ^= 0xff;
  const response = buildEventStreamResponseFromChunks([truncatedFrame, corruptedFrame]);

  const transformed = executor.transformEventStreamToSSE(response, "kiro-model");
  const text = await transformed.text();
  const chunksJson = parseSSEJsonChunks(text);

  assert.equal(
    chunksJson.some((chunk) => chunk.choices?.[0]?.delta?.content === "good"),
    false
  );
  assert.ok(chunksJson.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop"));
  assert.match(text, /data: \[DONE\]/);
  assert.equal(parseKiroEventFrameForTest(truncatedFrame), null);
  assert.equal(parseKiroEventFrameForTest(corruptedFrame), null);
});

test("KiroExecutor.transformEventStreamToSSE deduplicates tool starts and handles malformed payload JSON", async () => {
  const executor = new KiroExecutor();
  const response = buildEventStreamResponse([
    buildEventFrame("toolUseEvent", {
      toolUseId: "tool_1",
      name: "read_file",
      input: { path: "/tmp/a" },
    }),
    buildEventFrame("toolUseEvent", {
      toolUseId: "tool_1",
      name: "read_file",
      input: '{"path":"/tmp/a","followUp":true}',
    }),
    buildEventFrame("assistantResponseEvent", "{not-json"),
    buildEventFrame("messageStopEvent", {}),
  ]);

  const transformed = executor.transformEventStreamToSSE(response, "kiro-model");
  const text = await transformed.text();
  const startMatches = text.match(/"id":"tool_1"/g) || [];

  assert.equal(startMatches.length, 1);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /\[DONE\]/);
});

test("KiroExecutor.execute returns upstream errors directly and transforms successful streams", async () => {
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  const rawResponse = new Response("ok", { status: 200 });
  let transformed = null;
  executor.transformEventStreamToSSE = (response, model) => {
    transformed = { response, model };
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  globalThis.fetch = async () => new Response("upstream error", { status: 429 });
  try {
    const errorResult = await executor.execute({
      model: "kiro-model",
      body: { conversationState: {} },
      stream: true,
      credentials: { accessToken: "kiro-token" },
    });
    assert.equal(errorResult.response.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => rawResponse;
  try {
    const successResult = await executor.execute({
      model: "kiro-model",
      body: { conversationState: {} },
      stream: true,
      credentials: { accessToken: "kiro-token" },
    });

    assert.equal(successResult.response.status, 200);
    assert.equal(transformed.response, rawResponse);
    assert.equal(transformed.model, "kiro-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KiroExecutor.execute refreshes credentials on 401 and retries once", async () => {
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  const originalRetryBase = process.env.KIRO_REFRESH_RETRY_BASE_MS;
  process.env.KIRO_REFRESH_RETRY_BASE_MS = "0";
  let requestCount = 0;
  let refreshedTokenUsed = false;

  globalThis.fetch = async (url, init) => {
    const urlText = String(url);
    if (urlText.includes("oidc.us-east-1.amazonaws.com/token")) {
      return new Response(
        JSON.stringify({
          accessToken: "fresh-token",
          refreshToken: "fresh-refresh",
          expiresIn: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    requestCount++;
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") === "Bearer fresh-token") {
      refreshedTokenUsed = true;
      return buildEventStreamResponse([
        buildEventFrame("assistantResponseEvent", { content: "ok" }),
      ]);
    }
    return new Response("unauthorized", { status: 401 });
  };

  try {
    const result = await executor.execute({
      model: "kiro-model",
      body: { conversationState: {} },
      stream: true,
      credentials: {
        accessToken: "stale-token",
        refreshToken: "refresh",
        providerSpecificData: { clientId: "client", clientSecret: "secret" },
      },
    });

    const text = await result.response.text();
    assert.equal(result.response.status, 200);
    assert.equal(requestCount, 2);
    assert.equal(refreshedTokenUsed, true);
    assert.match(text, /ok/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRetryBase === undefined) delete process.env.KIRO_REFRESH_RETRY_BASE_MS;
    else process.env.KIRO_REFRESH_RETRY_BASE_MS = originalRetryBase;
  }
});

test("KiroExecutor.execute dedupes identical in-flight Kiro requests", async () => {
  resetKiroExecutorProtectionForTest();
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  const originalDedupeTtl = process.env.KIRO_DEDUPE_TTL_MS;
  process.env.KIRO_DEDUPE_TTL_MS = "1000";
  let requestCount = 0;
  let releaseFetch;
  const releasePromise = new Promise((resolve) => {
    releaseFetch = resolve;
  });

  globalThis.fetch = async () => {
    requestCount++;
    await releasePromise;
    return buildEventStreamResponse([
      buildEventFrame("assistantResponseEvent", { content: "deduped" }),
    ]);
  };

  try {
    const input = {
      model: "kiro-model",
      body: { conversationState: { conversationId: "same" } },
      stream: true,
      credentials: { accessToken: "kiro-token", connectionId: "conn-dedupe" },
    };

    const firstPromise = executor.execute(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPromise = executor.execute(input);
    releaseFetch();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const firstText = await first.response.text();
    const secondText = await second.response.text();

    assert.equal(requestCount, 1);
    assert.match(firstText, /deduped/);
    assert.match(secondText, /deduped/);
  } finally {
    globalThis.fetch = originalFetch;
    resetKiroExecutorProtectionForTest();
    if (originalDedupeTtl === undefined) delete process.env.KIRO_DEDUPE_TTL_MS;
    else process.env.KIRO_DEDUPE_TTL_MS = originalDedupeTtl;
  }
});

test("KiroExecutor.execute opens account circuit after repeated quota failures", async () => {
  resetKiroExecutorProtectionForTest();
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  const originalThreshold = process.env.KIRO_BREAKER_FAILURE_THRESHOLD;
  const originalCooldown = process.env.KIRO_BREAKER_COOLDOWN_MS;
  process.env.KIRO_BREAKER_FAILURE_THRESHOLD = "2";
  process.env.KIRO_BREAKER_COOLDOWN_MS = "60000";
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount++;
    return new Response("quota exceeded", { status: 429 });
  };

  try {
    const input = {
      model: "kiro-model",
      body: { conversationState: { conversationId: "breaker" } },
      stream: true,
      credentials: { accessToken: "kiro-token", connectionId: "conn-breaker" },
    };

    const first = await executor.execute(input);
    const second = await executor.execute(input);
    const third = await executor.execute(input);
    const thirdText = await third.response.text();

    assert.equal(first.response.status, 429);
    assert.equal(second.response.status, 429);
    assert.equal(third.response.status, 503);
    assert.equal(requestCount, 8);
    assert.match(thirdText, /kiro_account_circuit_open/);
  } finally {
    globalThis.fetch = originalFetch;
    resetKiroExecutorProtectionForTest();
    if (originalThreshold === undefined) delete process.env.KIRO_BREAKER_FAILURE_THRESHOLD;
    else process.env.KIRO_BREAKER_FAILURE_THRESHOLD = originalThreshold;
    if (originalCooldown === undefined) delete process.env.KIRO_BREAKER_COOLDOWN_MS;
    else process.env.KIRO_BREAKER_COOLDOWN_MS = originalCooldown;
  }
});

test("KiroExecutor.refreshCredentials handles missing and AWS-style refresh tokens", async () => {
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /oidc\.us-east-1\.amazonaws\.com\/token$/);
    return new Response(
      JSON.stringify({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresIn: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    assert.equal(await executor.refreshCredentials({}, null), null);
    const result = await executor.refreshCredentials(
      {
        refreshToken: "refresh",
        providerSpecificData: { clientId: "client", clientSecret: "secret" },
      },
      null
    );
    assert.deepEqual(result, {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KiroExecutor.refreshCredentials retries transient null refresh results", async () => {
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  const originalRetryBase = process.env.KIRO_REFRESH_RETRY_BASE_MS;
  process.env.KIRO_REFRESH_RETRY_BASE_MS = "0";
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) {
      return new Response("temporary", { status: 503 });
    }

    return new Response(
      JSON.stringify({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresIn: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const result = await executor.refreshCredentials(
      {
        refreshToken: "refresh",
        providerSpecificData: { clientId: "client", clientSecret: "secret" },
      },
      null
    );

    assert.equal(attempts, 3);
    assert.deepEqual(result, {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRetryBase === undefined) delete process.env.KIRO_REFRESH_RETRY_BASE_MS;
    else process.env.KIRO_REFRESH_RETRY_BASE_MS = originalRetryBase;
  }
});

test("KiroExecutor.refreshCredentials returns null when the token refresh fails", async () => {
  const executor = new KiroExecutor();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("refresh failed");
  };

  try {
    const result = await executor.refreshCredentials(
      {
        refreshToken: "refresh",
        providerSpecificData: { clientId: "client", clientSecret: "secret" },
      },
      null
    );
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
