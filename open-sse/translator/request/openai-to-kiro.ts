/**
 * OpenAI to Kiro Request Translator
 * Converts OpenAI Chat Completions format to Kiro/AWS CodeWhisperer format
 */
import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { compressContext } from "../../services/contextManager.ts";

const KIRO_DEFAULT_CONTEXT_MAX_TOKENS = 16000;
const KIRO_DEFAULT_CONTEXT_RESERVE_TOKENS = 4096;
const KIRO_DEFAULT_TOOL_RESULT_MAX_CHARS = 2000;
const KIRO_DEFAULT_TOOL_DOC_MAX_CHARS = 6000;
const KIRO_USER_ORIGIN = "KIRO_CLI";

function getKiroOperatingSystem(): string {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function buildKiroEnvState(): { operatingSystem: string; currentWorkingDirectory: string } {
  return {
    operatingSystem: getKiroOperatingSystem(),
    currentWorkingDirectory: process.cwd(),
  };
}

function isKiroTranslatorCompressionEnabled(): boolean {
  return process.env.KIRO_TRANSLATOR_ENABLE_COMPRESSION === "1";
}

type KiroEconomyProfileName = "safe" | "balanced" | "aggressive";

interface KiroEconomyProfile {
  name: KiroEconomyProfileName;
  contextMaxTokens: number;
  reserveTokens: number;
  toolResultMaxChars: number;
  errorToolResultMaxChars: number;
  toolDocMaxChars: number;
  maxOutputTokens: number;
  preserveTailTurns: number;
  summaryTriggerTurns: number;
  summaryMaxChars: number;
}

const KIRO_ECONOMY_PROFILES: Record<KiroEconomyProfileName, KiroEconomyProfile> = {
  safe: {
    name: "safe",
    contextMaxTokens: KIRO_DEFAULT_CONTEXT_MAX_TOKENS,
    reserveTokens: KIRO_DEFAULT_CONTEXT_RESERVE_TOKENS,
    toolResultMaxChars: KIRO_DEFAULT_TOOL_RESULT_MAX_CHARS,
    errorToolResultMaxChars: 3200,
    toolDocMaxChars: KIRO_DEFAULT_TOOL_DOC_MAX_CHARS,
    maxOutputTokens: 1024,
    preserveTailTurns: 4,
    summaryTriggerTurns: 14,
    summaryMaxChars: 3000,
  },
  balanced: {
    name: "balanced",
    contextMaxTokens: 12000,
    reserveTokens: 3072,
    toolResultMaxChars: 1200,
    errorToolResultMaxChars: 2400,
    toolDocMaxChars: 4000,
    maxOutputTokens: 768,
    preserveTailTurns: 4,
    summaryTriggerTurns: 10,
    summaryMaxChars: 2200,
  },
  aggressive: {
    name: "aggressive",
    contextMaxTokens: 9000,
    reserveTokens: 2048,
    toolResultMaxChars: 800,
    errorToolResultMaxChars: 1800,
    toolDocMaxChars: 2500,
    maxOutputTokens: 512,
    preserveTailTurns: 3,
    summaryTriggerTurns: 8,
    summaryMaxChars: 1600,
  },
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringifyKiroContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return String(item ?? "");
        const block = item as Record<string, unknown>;
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        try {
          return JSON.stringify(block);
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readKiroEconomyProfile(): KiroEconomyProfile {
  const raw = (process.env.KIRO_ECONOMY_PROFILE || "balanced").toLowerCase();
  const name: KiroEconomyProfileName =
    raw === "safe" || raw === "balanced" || raw === "aggressive" ? raw : "balanced";
  const base = KIRO_ECONOMY_PROFILES[name];

  return {
    ...base,
    contextMaxTokens: readPositiveIntEnv("KIRO_CONTEXT_MAX_TOKENS", base.contextMaxTokens),
    reserveTokens: readPositiveIntEnv("KIRO_CONTEXT_RESERVE_TOKENS", base.reserveTokens),
    toolResultMaxChars: readPositiveIntEnv("KIRO_TOOL_RESULT_MAX_CHARS", base.toolResultMaxChars),
    errorToolResultMaxChars: readPositiveIntEnv(
      "KIRO_ERROR_TOOL_RESULT_MAX_CHARS",
      base.errorToolResultMaxChars
    ),
    toolDocMaxChars: readPositiveIntEnv("KIRO_TOOL_DESCRIPTION_MAX_CHARS", base.toolDocMaxChars),
    maxOutputTokens: readPositiveIntEnv("KIRO_MAX_OUTPUT_TOKENS", base.maxOutputTokens),
    preserveTailTurns: readPositiveIntEnv("KIRO_PRESERVE_TAIL_TURNS", base.preserveTailTurns),
    summaryTriggerTurns: readPositiveIntEnv("KIRO_SUMMARY_TRIGGER_TURNS", base.summaryTriggerTurns),
    summaryMaxChars: readPositiveIntEnv("KIRO_SUMMARY_MAX_CHARS", base.summaryMaxChars),
  };
}

function truncateKiroText(value: string, maxChars: number, label = "truncated"): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[${label}: ${value.length - maxChars} chars omitted]`;
}

function truncateKiroToolResult(value: string, maxChars: number, isError: boolean): string {
  if (value.length <= maxChars) return value;

  const lines = value.split(/\r?\n/);
  const importantLines = lines.filter((line) =>
    /(?:error|exception|failed|failure|traceback|stack|exit code|\b[a-zA-Z]:\\|\.tsx?:\d+|\.jsx?:\d+|\.py:\d+)/i.test(
      line
    )
  );
  const headBudget = Math.max(160, Math.floor(maxChars * (isError ? 0.35 : 0.3)));
  const tailBudget = Math.max(240, Math.floor(maxChars * (isError ? 0.45 : 0.55)));
  const importantBudget = Math.max(0, maxChars - headBudget - tailBudget - 160);
  const importantText = importantLines.join("\n").slice(0, importantBudget);
  const head = value.slice(0, headBudget);
  const tail = value.slice(Math.max(0, value.length - tailBudget));
  const middle = importantText ? `\n...[important lines]\n${importantText}` : "";

  return `${head}${middle}\n...[tool result truncated: ${value.length - maxChars} chars omitted]\n${tail}`;
}

function truncateKiroSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headBudget = Math.max(400, Math.floor(maxChars * 0.55));
  const tailBudget = Math.max(300, Math.floor(maxChars * 0.35));
  const head = value.slice(0, headBudget);
  const tail = value.slice(Math.max(0, value.length - tailBudget));
  return `${head}\n...[summary compacted: ${value.length - maxChars} chars omitted]\n${tail}`;
}

function getKiroHistoryText(item: unknown): { role: "user" | "assistant"; content: string } | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record.userInputMessage && typeof record.userInputMessage === "object") {
    const userRecord = record.userInputMessage as { content?: unknown };
    return { role: "user", content: stringifyKiroContent(userRecord.content) };
  }
  if (record.assistantResponseMessage && typeof record.assistantResponseMessage === "object") {
    const assistantRecord = record.assistantResponseMessage as { content?: unknown };
    return {
      role: "assistant",
      content: stringifyKiroContent(assistantRecord.content),
    };
  }
  return null;
}

function buildKiroHistorySummary(history: unknown[], economyProfile: KiroEconomyProfile): string {
  const importantLines: string[] = [];
  const turnSummaries: string[] = [];

  history.forEach((item, index) => {
    const text = getKiroHistoryText(item);
    if (!text || !text.content.trim()) return;
    const compact = text.content.replace(/\s+/g, " ").trim();
    turnSummaries.push(`${index + 1}. ${text.role}: ${compact.slice(0, 220)}`);

    const matches = text.content
      .split(/\r?\n/)
      .filter((line) =>
        /(?:error|exception|failed|failure|traceback|stack|exit code|\b[a-zA-Z]:\\|[\w./-]+\.(?:ts|tsx|js|jsx|py|json|md):\d+)/i.test(
          line
        )
      )
      .slice(0, 8);
    importantLines.push(...matches);
  });

  const important = importantLines.length
    ? `\nImportant preserved lines:\n${importantLines.slice(0, 24).join("\n")}`
    : "";
  const rawSummary = `Previous conversation compacted for Kiro account savings. Preserve current user intent and recent turns below.\n${turnSummaries.join("\n")}${important}`;

  return truncateKiroSummary(rawSummary, economyProfile.summaryMaxChars);
}

function compactKiroHistoryForSavings(
  history: unknown[],
  economyProfile: KiroEconomyProfile
): unknown[] {
  if (history.length < economyProfile.summaryTriggerTurns) return history;

  const preserveFrom = Math.max(0, history.length - economyProfile.preserveTailTurns);
  if (preserveFrom < 4) return history;

  const oldHistory = history.slice(0, preserveFrom);
  const recentHistory = history.slice(preserveFrom);
  const summaryTurn = {
    userInputMessage: {
      content: buildKiroHistorySummary(oldHistory, economyProfile),
      modelId: "",
      origin: KIRO_USER_ORIGIN,
    },
  };

  if (recentHistory[0] && (recentHistory[0] as Record<string, unknown>).userInputMessage) {
    const syntheticAssistantTurn = {
      assistantResponseMessage: { content: "(summary acknowledged)" },
    };
    Object.defineProperty(syntheticAssistantTurn, "__synthetic", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    return [summaryTurn, syntheticAssistantTurn, ...recentHistory];
  }

  return [summaryTurn, ...recentHistory];
}

function compressionStatsFromContext(stats: unknown): { original: number; final: number } | null {
  if (!stats || typeof stats !== "object") return null;
  const record = stats as Record<string, unknown>;
  const original = typeof record.original === "number" ? record.original : null;
  const final = typeof record.final === "number" ? record.final : null;
  if (original == null || final == null || final >= original) return null;
  return { original, final };
}

function parseToolInput(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Recursively sanitize JSON Schema for Kiro API.
 * Kiro returns 400 "Improperly formed request" if:
 * - `required` is an empty array []
 * - `additionalProperties` is present anywhere
 */
function normalizeKiroToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const result: Record<string, unknown> = {};
  const src = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(src)) {
    // Skip empty required arrays — Kiro rejects them
    if (key === "required" && Array.isArray(value) && value.length === 0) {
      continue;
    }
    // Skip additionalProperties — Kiro doesn't support it
    if (key === "additionalProperties") {
      continue;
    }
    // Recursively process nested objects
    if (
      key === "properties" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [propName, propValue] of Object.entries(value as Record<string, unknown>)) {
        sanitizedProps[propName] = normalizeKiroToolSchema(propValue);
      }
      result[key] = sanitizedProps;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = normalizeKiroToolSchema(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? normalizeKiroToolSchema(item)
          : item
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

type KiroToolFunction = {
  name?: string;
  description?: string;
  parameters?: unknown;
};

type KiroToolDefinition = {
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  function?: KiroToolFunction;
};

function buildKiroToolSpecification(tool: any) {
  // Extract function data whether it comes from OpenAI format (tool.function) or Anthropic format
  const toolData = tool.type === "function" && tool.function ? tool.function : tool;

  // Handle both Anthropic's input_schema and OpenAI's parameters
  const rawSchema = toolData.parameters ||
    toolData.input_schema || { type: "object", properties: {} };

  return {
    toolSpecification: {
      name: toolData.name,
      description: toolData.description || "",
      inputSchema: {
        json: {
          type: rawSchema.type || "object",
          properties: rawSchema.properties || {},
          ...(rawSchema.required &&
          Array.isArray(rawSchema.required) &&
          rawSchema.required.length > 0
            ? { required: rawSchema.required }
            : {}),
        },
      },
    },
  };
}

function stripUnsupportedKiroTopLevelFields(payload: Record<string, unknown>): void {
  delete payload.model;
  delete payload.stream;
  delete payload.tools;
  delete payload.tool_choice;
  delete payload.thinking;
  delete payload.context_management;
  delete payload.output_config;
  delete payload.system;
}

export function consumeKiroCompressionStats(payload: unknown): {
  originalTokens: number;
  compressedTokens: number;
  tokensCompressed: number;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const rawStats = record._omnirouteCompressionStats;
  delete record._omnirouteCompressionStats;
  if (!rawStats || typeof rawStats !== "object") return null;

  const stats = rawStats as Record<string, unknown>;
  const originalTokens = typeof stats.originalTokens === "number" ? stats.originalTokens : null;
  const compressedTokens =
    typeof stats.compressedTokens === "number" ? stats.compressedTokens : null;
  const tokensCompressed =
    typeof stats.tokensCompressed === "number" ? stats.tokensCompressed : null;
  if (
    originalTokens == null ||
    compressedTokens == null ||
    tokensCompressed == null ||
    tokensCompressed <= 0
  ) {
    return null;
  }

  return {
    originalTokens,
    compressedTokens,
    tokensCompressed,
  };
}

/**
 * Convert OpenAI messages to Kiro format
 * Rules: system/tool/user -> user role, merge consecutive same roles
 */
function convertMessages(messages, tools, model, economyProfile: KiroEconomyProfile) {
  let history = [];
  let currentMessage = null;

  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages: Array<{ format: string; source: { bytes: string } }> = [];
  let currentRole = null;
  let toolsAttached = false;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "(empty)";
      const userMsg: {
        userInputMessage: {
          content: string;
          modelId: string;
          images?: Array<{ format: string; source: { bytes: string } }>;
          origin: string;
          userInputMessageContext?: {
            toolResults?: Array<Record<string, unknown>>;
            tools?: Array<Record<string, unknown>>;
          };
        };
        _toolDocs?: string;
      } = {
        userInputMessage: {
          content: content,
          modelId: "",
          origin: KIRO_USER_ORIGIN,
        },
      };

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults,
        };
      }

      // Attach images to userInputMessage (NOT userInputMessageContext)
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }

      // Add tools to the first emitted user turn. We track a flag instead of
      // relying on `history.length === 0` because the first few messages may
      // be assistant turns (e.g. when role=undefined collapses to a prior
      // assistant turn), in which case the first user flush would already see
      // a non-empty history and lose the tools schema.
      if (tools && tools.length > 0 && !toolsAttached) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        // Kiro API rejects very large tool descriptions. Keep schema compact
        // and move bounded docs into prompt for account/context savings.
        const toolDescriptionMax = economyProfile.toolDocMaxChars;
        const toolDocs: string[] = [];
        userMsg.userInputMessage.userInputMessageContext.tools = tools.map(
          (tool: KiroToolDefinition) => {
            const name = tool.function?.name || tool.name;
            let description = tool.function?.description || tool.description || "";

            if (!description.trim()) {
              description = `Tool: ${name}`;
            }

            if (description.length > toolDescriptionMax) {
              toolDocs.push(
                `## Tool: ${name}\n\n${truncateKiroText(description, toolDescriptionMax, "tool docs truncated")}`
              );
              description = `[Full documentation in system prompt under '## Tool: ${name}']`;
            }

            return buildKiroToolSpecification(tool, description);
          }
        );
        // Attach tool docs to message so buildKiroPayload can prepend to content
        if (toolDocs.length > 0) {
          userMsg._toolDocs = toolDocs.join("\n\n---\n\n");
        }
        toolsAttached = true;
      }

      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "(empty)";
      const assistantMsg = {
        assistantResponseMessage: {
          content: content,
        },
      };
      history.push(assistantMsg);
      pendingAssistantContent = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let role = msg.role;

    // Normalize provider-specific instruction/tool turns into Kiro user turns.
    // Kiro does not have a separate developer/system lane like Claude does.
    if (role === "system" || role === "developer" || role === "tool") {
      role = "user";
    }

    // If role changes, flush pending
    if (role !== currentRole && currentRole !== null) {
      flushPending();
    }
    currentRole = role;

    if (role === "user") {
      // Extract content
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((c) => c.type === "text" || c.text)
          .map((c) => stringifyKiroContent(c.text || c.content || c));
        content = textParts.join("\n");

        // Extract images (OpenAI image_url and Anthropic image formats)
        for (const block of msg.content) {
          if (block.type === "image_url") {
            const url: string = block.image_url?.url || "";
            if (url.startsWith("data:")) {
              // data:image/jpeg;base64,<data>
              const [header, bytes] = url.split(",", 2);
              const mediaType = header.split(";")[0].replace("data:", ""); // e.g. "image/jpeg"
              const format = mediaType.split("/")[1] || "jpeg";
              if (bytes) pendingImages.push({ format, source: { bytes } });
            }
          } else if (block.type === "image" && block.source?.type === "base64") {
            const format = (block.source.media_type || "image/jpeg").split("/")[1] || "jpeg";
            if (block.source.data)
              pendingImages.push({ format, source: { bytes: block.source.data } });
          }
        }

        // Check for tool_result blocks
        const toolResultBlocks = msg.content.filter((c) => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach((block) => {
            const isError = Boolean(block.is_error);
            const text = truncateKiroToolResult(
              stringifyKiroContent(block.content),
              isError ? economyProfile.errorToolResultMaxChars : economyProfile.toolResultMaxChars,
              isError
            );

            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: isError ? "error" : "success",
              content: [{ text }],
            });
          });
        }
      }

      // Handle tool role (from normalized)
      if (msg.role === "tool") {
        const toolContent = truncateKiroToolResult(
          stringifyKiroContent(msg.content),
          economyProfile.toolResultMaxChars,
          false
        );
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: "success",
          content: [{ text: toolContent }],
        });
      } else if (content) {
        pendingUserContent.push(content);
      }
    } else if (role === "assistant") {
      // Extract text content and tool uses
      let textContent = "";
      let toolUses = [];

      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(
          (c) => c.type === "text" || c.type === "thinking" || c.type === "redacted_thinking"
        );
        textContent = textBlocks
          .map((b) =>
            b.type === "redacted_thinking" ? "" : stringifyKiroContent(b.text || b.thinking || b)
          )
          .filter(Boolean)
          .join("\n")
          .trim();

        const toolUseBlocks = msg.content.filter((c) => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls;
      }

      if (textContent) {
        pendingAssistantContent.push(textContent);
      }

      // Store tool uses in last assistant message
      if (toolUses.length > 0) {
        if (pendingAssistantContent.length === 0) {
          // pendingAssistantContent.push("Call tools");
        }

        // Flush to create assistant message with toolUses
        flushPending();

        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses.map((tc) => {
            if (tc.function) {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.function.name || "unknown_tool",
                input: parseToolInput(tc.function.arguments),
              };
            } else {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.name || "unknown_tool",
                input: parseToolInput(tc.input),
              };
            }
          });
        }

        currentRole = null;
      }
    }
  }

  // Flush remaining
  if (currentRole !== null) {
    flushPending();
  }

  // Kiro requires currentMessage to be a user turn. If the request ends with a
  // user turn, move that final turn into currentMessage. If it ends with an
  // assistant/tool turn, keep chronological history intact and ask Kiro to
  // continue instead of reordering prior turns.
  if (history.length > 0 && history[history.length - 1].userInputMessage) {
    currentMessage = history.pop();
  } else {
    currentMessage = {
      userInputMessage: {
        content: "Continue",
        modelId: model,
        origin: KIRO_USER_ORIGIN,
      },
    };
  }

  // Promote the tools schema to currentMessage. Tools may have been attached
  // to any user turn in history (e.g. when the first message was assistant or
  // had an undefined role, the first user flush lands further down). Scan the
  // whole history so we never lose the schema.
  if (!currentMessage?.userInputMessage?.userInputMessageContext?.tools) {
    const carrier = history.find((item) => item?.userInputMessage?.userInputMessageContext?.tools);
    if (carrier?.userInputMessage?.userInputMessageContext?.tools) {
      if (!currentMessage.userInputMessage.userInputMessageContext) {
        currentMessage.userInputMessage.userInputMessageContext = {};
      }
      currentMessage.userInputMessage.userInputMessageContext.tools =
        carrier.userInputMessage.userInputMessageContext.tools;
    }
  }

  // Fallback: if the schema was never attached to any user turn (e.g. the
  // input contained no user messages and currentMessage is a synthesized
  // "Continue" turn), attach the provided tools directly to currentMessage so
  // Kiro still sees the schema it needs to validate assistant.toolUses in
  // history.
  if (
    !toolsAttached &&
    tools &&
    tools.length > 0 &&
    !currentMessage?.userInputMessage?.userInputMessageContext?.tools
  ) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = tools.map(
      (tool: KiroToolDefinition) => {
        const name = tool.function?.name || tool.name || "tool";
        const description = tool.function?.description || tool.description || `Tool: ${name}`;
        return buildKiroToolSpecification(tool, description);
      }
    );
    toolsAttached = true;
  }

  // Clean up history for Kiro API compatibility
  history.forEach((item) => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }

    if (
      item.userInputMessage?.userInputMessageContext &&
      Object.keys(item.userInputMessage.userInputMessageContext).length === 0
    ) {
      delete item.userInputMessage.userInputMessageContext;
    }

    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }

    // Kiro API requires `origin` on every userInputMessage
    if (item.userInputMessage && !item.userInputMessage.origin) {
      item.userInputMessage.origin = KIRO_USER_ORIGIN;
    }
  });

  // Kiro expects history to alternate between user and assistant turns. After
  // normalizing `system`/`tool` roles into `userInputMessage`, the history can
  // contain adjacent user turns, which Kiro can reject. Merge consecutive
  // `userInputMessage` entries by concatenating their content and preserving
  // any attached `userInputMessageContext` (e.g. accumulated toolResults).
  //
  // Why this is not redundant with the `flushPending` grouping in the main
  // loop: the assistant branch resets `currentRole = null` after emitting
  // `toolUses`. Any following `tool` role (normalized to user) and a
  // subsequent `user` role therefore each open their own flush, producing
  // two adjacent `userInputMessage` entries in history. This pass collapses
  // those.
  const mergedHistory: typeof history = [];
  for (const item of history) {
    const previous = mergedHistory[mergedHistory.length - 1];
    if (item.userInputMessage && previous?.userInputMessage) {
      const previousContent = previous.userInputMessage.content || "";
      const currentContent = item.userInputMessage.content || "";
      previous.userInputMessage.content = previousContent
        ? `${previousContent}\n\n${currentContent}`
        : currentContent;

      if (item.userInputMessage.userInputMessageContext) {
        const previousContext = previous.userInputMessage.userInputMessageContext || {};
        const nextContext = item.userInputMessage.userInputMessageContext;
        const mergedContext: Record<string, unknown> = { ...previousContext };

        for (const [key, value] of Object.entries(nextContext)) {
          const existing = (previousContext as Record<string, unknown>)[key];
          if (Array.isArray(existing) && Array.isArray(value)) {
            mergedContext[key] = [...existing, ...value];
          } else {
            mergedContext[key] = value;
          }
        }

        previous.userInputMessage.userInputMessageContext = mergedContext;
      }
    } else if (item.assistantResponseMessage && previous?.assistantResponseMessage) {
      // Kiro API also rejects consecutive assistant messages. Merge them.
      const previousContent = previous.assistantResponseMessage.content || "";
      const currentContent = item.assistantResponseMessage.content || "";
      previous.assistantResponseMessage.content = previousContent
        ? `${previousContent}\n\n${currentContent}`
        : currentContent;

      if (item.assistantResponseMessage.toolUses) {
        const existingToolUses = previous.assistantResponseMessage.toolUses || [];
        previous.assistantResponseMessage.toolUses = [
          ...existingToolUses,
          ...item.assistantResponseMessage.toolUses,
        ];
      }
    } else {
      mergedHistory.push(item);
    }
  }

  // Ensure first message is user. Kiro API requires conversations to start
  // with a user message (fixes "Improperly formed request" for assistant-first).
  if (mergedHistory.length > 0 && mergedHistory[0].assistantResponseMessage) {
    const syntheticUserTurn = {
      userInputMessage: {
        content: "(empty)",
        modelId: model,
        origin: KIRO_USER_ORIGIN,
      },
    };
    // Mark as synthetic (non-enumerable so it doesn't leak to upstream JSON)
    // so conversationId derivation can skip it — otherwise every
    // assistant-first conversation collapses onto the same uuidv5(empty)
    // namespace and leaks AWS Builder ID context across unrelated sessions.
    Object.defineProperty(syntheticUserTurn, "__synthetic", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    mergedHistory.unshift(syntheticUserTurn);
  }

  // Ensure assistant exists before toolResults. Kiro API validates that every
  // toolResults array has a preceding assistantResponseMessage with toolUses.
  // When the assistant message is missing (truncated conversation), we strip
  // the orphaned toolResults and convert them to text to preserve context.
  for (let i = 0; i < mergedHistory.length; i++) {
    const item = mergedHistory[i];
    if (!item.userInputMessage?.userInputMessageContext?.toolResults) continue;

    const prev = mergedHistory[i - 1];
    const hasPrecedingAssistant =
      prev?.assistantResponseMessage?.toolUses && prev.assistantResponseMessage.toolUses.length > 0;

    if (!hasPrecedingAssistant) {
      const toolResults = item.userInputMessage.userInputMessageContext.toolResults as Array<{
        toolUseId?: string;
        content?: Array<{ text?: string }>;
      }>;
      const toolResultTexts = toolResults
        .map((tr) => {
          const id = tr.toolUseId || "";
          const text = tr.content?.map((c) => c.text || "").join("\n") || "";
          return id ? `[Tool Result (${id})]\n${text}` : `[Tool Result]\n${text}`;
        })
        .join("\n\n");

      const originalContent = item.userInputMessage.content || "";
      item.userInputMessage.content = originalContent
        ? `${originalContent}\n\n${toolResultTexts}`
        : toolResultTexts;
      delete item.userInputMessage.userInputMessageContext.toolResults;

      if (Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
        delete item.userInputMessage.userInputMessageContext;
      }
    }
  }

  // Also check currentMessage for orphaned toolResults (not in history)
  if (currentMessage?.userInputMessage?.userInputMessageContext?.toolResults) {
    const lastHistory = mergedHistory[mergedHistory.length - 1];
    const hasPrecedingAssistant =
      lastHistory?.assistantResponseMessage?.toolUses &&
      lastHistory.assistantResponseMessage.toolUses.length > 0;

    if (!hasPrecedingAssistant) {
      const toolResults = currentMessage.userInputMessage.userInputMessageContext
        .toolResults as Array<{ toolUseId?: string; content?: Array<{ text?: string }> }>;
      const toolResultTexts = toolResults
        .map((tr) => {
          const id = tr.toolUseId || "";
          const text = tr.content?.map((c) => c.text || "").join("\n") || "";
          return id ? `[Tool Result (${id})]\n${text}` : `[Tool Result]\n${text}`;
        })
        .join("\n\n");

      const originalContent = currentMessage.userInputMessage.content || "";
      currentMessage.userInputMessage.content = originalContent
        ? `${originalContent}\n\n${toolResultTexts}`
        : toolResultTexts;
      delete currentMessage.userInputMessage.userInputMessageContext.toolResults;

      if (Object.keys(currentMessage.userInputMessage.userInputMessageContext).length === 0) {
        delete currentMessage.userInputMessage.userInputMessageContext;
      }
    }
  }

  // Ensure alternating roles by inserting synthetic assistant messages
  // between consecutive user turns that couldn't be merged.
  const alternatingHistory: typeof mergedHistory = [];
  for (const item of mergedHistory) {
    const last = alternatingHistory[alternatingHistory.length - 1];
    if (item.userInputMessage && last?.userInputMessage) {
      const syntheticAssistantTurn = {
        assistantResponseMessage: { content: "(empty)" },
      };
      Object.defineProperty(syntheticAssistantTurn, "__synthetic", {
        value: true,
        enumerable: false,
        configurable: true,
      });
      alternatingHistory.push(syntheticAssistantTurn);
    }
    alternatingHistory.push(item);
  }

  return { history: alternatingHistory, currentMessage, toolsAttached };
}

/**
 * Build Kiro payload from OpenAI format
 */
export function buildKiroPayload(
  model,
  body,
  stream,
  credentials,
  options?: { enableCompression?: boolean }
) {
  // Normalize model name: Claude Code sends dashes (claude-sonnet-4-6),
  // Kiro API expects dots (claude-sonnet-4.6). Convert trailing version segment.
  const normalizedModel = model.replace(
    /^(claude-(?:opus|sonnet|haiku|3-\d+)-\d+)-(\d+)$/,
    "$1.$2"
  );

  // Normalize body.system (Claude-format array or string) into a leading system message
  // so it is not silently dropped when the caller arrives via the openai→kiro path
  // (i.e. sourceFormat was already "openai" but the body is actually Claude-shaped).
  let messages = body.messages || [];
  if (body.system && !messages.some((m) => m.role === "system")) {
    const systemText = Array.isArray(body.system)
      ? body.system
          .map((b) => (typeof b === "object" && b !== null ? b.text || "" : String(b)))
          .join("\n")
      : typeof body.system === "string"
        ? body.system
        : "";
    if (systemText) {
      messages = [{ role: "system", content: systemText }, ...messages];
    }
  }
  let tools = body.tools || [];
  const economyProfile = readKiroEconomyProfile();
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? 32000;
  const kiroContextMaxTokens = economyProfile.contextMaxTokens;
  const kiroContextReserveTokens = economyProfile.reserveTokens;
  const temperature = body.temperature;
  const topP = body.top_p;
  const enableTranslatorCompression =
    options?.enableCompression ?? isKiroTranslatorCompressionEnabled();

  // Kiro rejects history that references toolUses/toolResults without a tools
  // schema in userInputMessageContext. When callers omit body.tools but the
  // message history still contains assistant.tool_calls / role=tool turns,
  // synthesize a minimal tool schema from the tool names present in history
  // so Kiro accepts the request instead of returning `Improperly formed
  // request`. This preserves tool-call history and is a no-op when body.tools
  // is already populated.
  if (tools.length === 0) {
    const seen = new Set<string>();
    const synthesized: Array<Record<string, unknown>> = [];
    const pushName = (name: unknown) => {
      if (typeof name === "string" && name && !seen.has(name)) {
        seen.add(name);
        synthesized.push({
          type: "function",
          function: {
            name,
            description: `Tool: ${name}`,
            parameters: { type: "object", properties: {}, required: [] },
          },
        });
      }
    };
    for (const msg of messages) {
      if (msg?.role !== "assistant") continue;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          pushName(tc?.function?.name || tc?.name);
        }
      }
      // Anthropic-style assistant blocks: content:[{type:"tool_use", name, ...}]
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_use") {
            pushName(block.name);
          }
        }
      }
    }
    if (synthesized.length > 0) {
      tools = synthesized;
    }
  }

  const {
    history: rawHistory,
    currentMessage,
    toolsAttached,
  } = convertMessages(messages, tools, normalizedModel, economyProfile);
  const history = compactKiroHistoryForSavings(rawHistory, economyProfile);

  let finalContent = currentMessage?.userInputMessage?.content || "";
  let kiroCompressionStats: { original: number; final: number } | null = null;
  if (enableTranslatorCompression) {
    const timestamp = new Date().toISOString();
    // Apply compression to the assembled history + currentMessage where possible.
    try {
      const compressBody = {
        messages: [
          // Map merged history to simple messages for compression
          ...(history || []).map((item: unknown) => {
            const record = item as {
              userInputMessage?: { content?: string };
              assistantResponseMessage?: { content?: string };
            };
            return record.userInputMessage
              ? { role: "user", content: record.userInputMessage.content }
              : record.assistantResponseMessage
                ? { role: "assistant", content: record.assistantResponseMessage.content }
                : { role: "user", content: "" };
          }),
          // currentMessage (make sure it's last)
          currentMessage?.userInputMessage
            ? { role: "user", content: currentMessage.userInputMessage.content }
            : { role: "user", content: "" },
        ],
      };
      const compressed = compressContext(compressBody, {
        provider: "kiro",
        model: normalizedModel,
        maxTokens: kiroContextMaxTokens,
        reserveTokens: Math.min(kiroContextReserveTokens, Math.max(0, kiroContextMaxTokens - 1)),
      });
      if (compressed && compressed.compressed && Array.isArray(compressed.body.messages)) {
        kiroCompressionStats = compressionStatsFromContext(compressed.stats);
        const msgs = compressed.body.messages as Array<Record<string, unknown>>;
        const compressedHistory = msgs.slice(0, -1);
        const preserveHistoryFrom = Math.max(0, history.length - economyProfile.preserveTailTurns);
        for (let i = 0; i < compressedHistory.length && i < history.length; i++) {
          if (i >= preserveHistoryFrom) continue;
          const source = compressedHistory[i];
          const target = history[i] as Record<string, unknown>;
          if (typeof source.content !== "string") continue;
          if (target.userInputMessage && typeof target.userInputMessage === "object") {
            (target.userInputMessage as Record<string, unknown>).content = source.content;
          } else if (
            target.assistantResponseMessage &&
            typeof target.assistantResponseMessage === "object"
          ) {
            (target.assistantResponseMessage as Record<string, unknown>).content = source.content;
          }
        }

        // Use the last user message as final content after compression.
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        if (lastUser && typeof lastUser.content === "string") {
          finalContent = lastUser.content;
        }
      }
    } catch (_err) {
      // Compression is best-effort; fall back to uncompressed content.
    }
    finalContent = `[Context: Current time is ${timestamp}]\n\n${finalContent}`;
  }

  if (currentMessage?.userInputMessage) {
    const context = currentMessage.userInputMessage.userInputMessageContext || {};
    if (!("envState" in context)) {
      context.envState = buildKiroEnvState();
    }
    currentMessage.userInputMessage.userInputMessageContext = context;
  }

  // Prepend tool documentation for tools with long descriptions (moved from toolSpecification)
  const toolDocs = (currentMessage as { _toolDocs?: string } | null)?._toolDocs;
  if (toolDocs) {
    finalContent = `# Tool Documentation\n\n${toolDocs}\n\n---\n\n${finalContent}`;
  }

  // Build strictly-typed KiroAmazonQPayload
  // Sanitize history: only keep userInputMessage.content(+origin) and assistantResponseMessage.content
  // Ensure truncated tool docs are attached early so sanitized mapping can include them
  try {
    const toolDescriptionMax = economyProfile.toolDocMaxChars;
    const toolDocsForHistory: string[] = [];
    for (const t of (tools || []) as KiroToolDefinition[]) {
      const name = t.function?.name || t.name || "tool";
      const description = t.function?.description || t.description || "";
      if (description && description.length > toolDescriptionMax) {
        toolDocsForHistory.push(
          `## Tool: ${name}\n\n${truncateKiroText(description, toolDescriptionMax, "tool docs truncated")}`
        );
      }
    }
    if (toolDocsForHistory.length > 0) {
      const firstUser = history.find((h) => h?.userInputMessage);
      if (firstUser && firstUser.userInputMessage) {
        (firstUser.userInputMessage as any)._toolDocs = toolDocsForHistory.join("\n\n---\n\n");
      }
    }
  } catch (_err) {
    // best-effort only
  }
  const sanitizedHistory: Array<Record<string, unknown>> = (history || [])
    .map((item) => {
      if (item.userInputMessage) {
        const ui = item.userInputMessage as Record<string, unknown>;
        const content =
          typeof ui.content === "string" ? ui.content : stringifyKiroContent(ui.content);
        // If long tool docs were attached to this user message, preserve them in the
        // history content so tests and upstream reviewers can see truncated markers.
        const out: Record<string, unknown> = { userInputMessage: { content } };
        const toolDocs = (ui as any)._toolDocs;
        if (typeof toolDocs === "string" && toolDocs.length > 0) {
          out.userInputMessage.content = `${out.userInputMessage.content}\n\n${toolDocs}`;
        }
        // preserve modelId for compatibility with existing consumers/tests
        if (ui.modelId) out.userInputMessage.modelId = ui.modelId;
        if (ui.origin) out.userInputMessage.origin = ui.origin;
        // preserve toolResults if present on the user turn
        if (
          ui.userInputMessageContext &&
          (ui.userInputMessageContext as Record<string, unknown>).toolResults
        ) {
          out.userInputMessage.userInputMessageContext = {
            toolResults: (ui.userInputMessageContext as Record<string, unknown>).toolResults,
          };
        }
        return out;
      }
      if (item.assistantResponseMessage) {
        const ar = item.assistantResponseMessage as Record<string, unknown>;
        const content =
          typeof ar.content === "string" ? ar.content : stringifyKiroContent(ar.content);
        const res: Record<string, unknown> = { assistantResponseMessage: { content } };
        if (ar.toolUses) res.assistantResponseMessage.toolUses = ar.toolUses;
        return res;
      }
      return {};
    })
    .filter((i) => Object.keys(i).length > 0);

  // Sanitize currentMessage: only content + userInputMessageContext (envState + tools)
  const sanitizedCurrentUserContent = finalContent;

  // Build tools specification array (deeply nested under userInputMessageContext.tools)
  const incomingTools = Array.isArray(body.tools) && body.tools.length ? body.tools : tools || [];
  const toolsSpecArray = incomingTools.map((t: KiroToolDefinition) =>
    buildKiroToolSpecification(t)
  );

  // Start with any existing currentMessage context (preserves toolResults)
  const existingCurrentContext =
    currentMessage?.userInputMessage?.userInputMessageContext || ({} as Record<string, unknown>);
  const userInputMessageContext: Record<string, unknown> = { ...existingCurrentContext };
  // Ensure envState exists
  if (!userInputMessageContext.envState) {
    userInputMessageContext.envState = buildKiroEnvState();
  }
  // Attach tools spec to current context (deeply nested under userInputMessageContext.tools)
  if (Array.isArray(toolsSpecArray) && toolsSpecArray.length > 0) {
    userInputMessageContext.tools = toolsSpecArray;
  }

  // Deterministic session id (same logic as before)
  const NAMESPACE_KIRO = "34f7193f-561d-4050-bc84-9547d953d6bf";
  const preCompressionBody = credentials?._preCompressionBody as
    | Record<string, unknown>
    | null
    | undefined;
  const preCompressionMessages = Array.isArray(preCompressionBody?.messages)
    ? preCompressionBody.messages
    : null;
  const preCompressionFirstUser = preCompressionMessages?.find(
    (m: Record<string, unknown>) => m.role === "user"
  );
  const seedFromPreCompression = preCompressionFirstUser
    ? typeof preCompressionFirstUser.content === "string"
      ? preCompressionFirstUser.content
      : Array.isArray(preCompressionFirstUser.content)
        ? (preCompressionFirstUser.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text || "")
            .join(" ")
        : ""
    : "";
  const firstRealUserTurn = sanitizedHistory.find((h) =>
    Boolean((h as any).userInputMessage?.content)
  );
  const firstContent =
    seedFromPreCompression ||
    (firstRealUserTurn as any)?.userInputMessage?.content ||
    sanitizedCurrentUserContent;
  const conversationId = uuidv5((firstContent || "").substring(0, 4000), NAMESPACE_KIRO);

  const conversationState: Record<string, unknown> = {
    conversationId,
    history: sanitizedHistory,
    currentMessage: {
      userInputMessage: {
        content: sanitizedCurrentUserContent,
        modelId: normalizedModel,
        origin: KIRO_USER_ORIGIN,
        userInputMessageContext: userInputMessageContext,
      },
    },
    chatTriggerType: "MANUAL",
  };

  // agentTaskType may be carried in body (optional) — preserve if present
  if (body.agentTaskType) {
    conversationState.agentTaskType = body.agentTaskType;
  }

  const finalPayload: Record<string, unknown> = { conversationState };
  // Preserve optional profileArn at root if provided by caller
  if (typeof body.profileArn === "string" && body.profileArn.trim()) {
    finalPayload.profileArn = body.profileArn;
  }

  // Re-expose compression stats for logging/consumption by consumeKiroCompressionStats
  if (kiroCompressionStats) {
    finalPayload._omnirouteCompressionStats = {
      provider: "kiro",
      originalTokens: kiroCompressionStats.original,
      compressedTokens: kiroCompressionStats.final,
      tokensCompressed: kiroCompressionStats.original - kiroCompressionStats.final,
    };
  }

  // Strip unsupported top-level fields (still no-op here but kept for safety)
  stripUnsupportedKiroTopLevelFields(finalPayload as Record<string, unknown>);

  return finalPayload as unknown;
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload);
