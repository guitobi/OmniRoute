/**
 * OpenAI/Claude-shaped request to Kiro native payload translator.
 *
 * This file intentionally keeps the mapping local and explicit. Kiro is strict
 * about both conversation nesting and tool schema shape, so every incoming body
 * is sanitized before any field is copied into the final payload.
 */
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";

import { FORMATS } from "../formats.ts";
import {
  buildKiroToolSpecsForClaudeCode,
  isClaudeExecutableKiroTool,
  normalizeClaudeToolUseForKiro,
  normalizeToolNameForKiro,
  shouldKeepToolResultAsText,
} from "../kiroToolBridge.ts";
import { register } from "../registry.ts";

const KIRO_USER_ORIGIN = "KIRO_CLI";
const KIRO_CHAT_TRIGGER_TYPE = "MANUAL";
const KIRO_CONVERSATION_NAMESPACE = "34f7193f-561d-4050-bc84-9547d953d6bf";

type JsonRecord = Record<string, unknown>;

type KiroToolResultContent = { text: string } | { json: unknown };

type KiroToolResult = {
  toolUseId: string;
  status?: "success" | "error";
  content: KiroToolResultContent[];
};

type KiroUserInputMessage = {
  content: string;
  modelId?: string;
  origin: string;
  images?: Array<{ format: string; source: { bytes: string } }>;
  userInputMessageContext?: {
    envState?: { operatingSystem: string; currentWorkingDirectory: string };
    tools?: JsonRecord[];
    toolResults?: KiroToolResult[];
  };
};

type KiroAssistantResponseMessage = {
  messageId?: string;
  content: string;
  toolUses?: Array<{ toolUseId: string; name: string; input: JsonRecord }>;
};

type KiroToolUse = { toolUseId: string; name: string; input: JsonRecord };

type KiroHistoryItem =
  | { userInputMessage: KiroUserInputMessage }
  | { assistantResponseMessage: KiroAssistantResponseMessage };

function getKiroOperatingSystem(): string {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function buildKiroEnvState(currentWorkingDirectory = process.cwd()): {
  operatingSystem: string;
  currentWorkingDirectory: string;
} {
  return {
    operatingSystem: getKiroOperatingSystem(),
    currentWorkingDirectory,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeForKiro(value: unknown): unknown {
  if (value === "[MaxDepth]" || value === undefined) return undefined;

  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeForKiro(item)).filter((item) => item !== undefined);
    return items;
  }

  if (isRecord(value)) {
    if (value._omniroute_truncated_array === true) return undefined;

    const result: JsonRecord = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key.startsWith("_omniroute") || nestedValue === "[MaxDepth]") continue;
      const sanitizedValue = sanitizeForKiro(nestedValue);
      if (sanitizedValue !== undefined) result[key] = sanitizedValue;
    }
    return result;
  }

  return value;
}

function stringifyKiroContent(value: unknown): string {
  const sanitized = sanitizeForKiro(value);
  if (sanitized == null) return "";
  if (typeof sanitized === "string") return sanitized;
  if (typeof sanitized === "number" || typeof sanitized === "boolean") return String(sanitized);

  if (Array.isArray(sanitized)) {
    return sanitized
      .map((item) => {
        if (isRecord(item)) {
          if (typeof item.text === "string") return item.text;
          if (typeof item.thinking === "string") return item.thinking;
          if (typeof item.content === "string") return item.content;
        }
        return stringifyKiroContent(item);
      })
      .filter(Boolean)
      .join("\n");
  }

  if (isRecord(sanitized)) {
    if (typeof sanitized.text === "string") return sanitized.text;
    if (typeof sanitized.content === "string") return sanitized.content;
  }

  return JSON.stringify(sanitized);
}

function normalizeModel(model: string): string {
  return String(model || "auto")
    .replace(/^kiro\//, "")
    .replace(/^(claude-(?:opus|sonnet|haiku|3-\d+)-\d+)-(\d+)$/, "$1.$2");
}

function normalizeToolInput(value: unknown): JsonRecord {
  const source = typeof value === "string" ? (parseJsonString(value) ?? value) : value;
  const sanitized = sanitizeForKiro(source);
  if (isRecord(sanitized)) return sanitized;
  if (sanitized == null || sanitized === "") return {};
  return { value: sanitized };
}

function normalizeKiroToolUseInput(toolName: string, value: unknown): JsonRecord {
  return normalizeClaudeToolUseForKiro(toolName, normalizeToolInput(value));
}

function buildKiroTools(tools: unknown): JsonRecord[] {
  return Array.isArray(tools) && tools.length > 0 ? buildKiroToolSpecsForClaudeCode() : [];
}

function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return stringifyKiroContent(content).trim();
  return content
    .filter((block) => isRecord(block) && block.type !== "tool_use" && block.type !== "tool_result")
    .map((block) => stringifyKiroContent(block))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function imageBlocksFromContent(
  content: unknown
): Array<{ format: string; source: { bytes: string } }> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ format: string; source: { bytes: string } }> = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === "image_url" && isRecord(block.image_url)) {
      const url = typeof block.image_url.url === "string" ? block.image_url.url : "";
      const match = url.match(/^data:image\/([^;]+);base64,(.+)$/);
      if (match) images.push({ format: match[1], source: { bytes: match[2] } });
    }

    if (block.type === "image" && isRecord(block.source)) {
      const mediaType = typeof block.source.media_type === "string" ? block.source.media_type : "";
      const data = typeof block.source.data === "string" ? block.source.data : "";
      if (data) images.push({ format: mediaType.split("/")[1] || "jpeg", source: { bytes: data } });
    }
  }

  return images;
}

function aggregateExpandedToolUses(toolUses: KiroToolUse[]): KiroToolUse[] {
  const expandedCounts = new Map<string, number>();
  const plainIds = new Set<string>();
  for (const toolUse of toolUses) {
    const expanded = splitExpandedToolUseId(toolUse.toolUseId);
    if (!expanded) {
      plainIds.add(toolUse.toolUseId);
      continue;
    }
    expandedCounts.set(expanded.baseId, (expandedCounts.get(expanded.baseId) || 0) + 1);
  }

  const output: KiroToolUse[] = [];
  const grouped = new Map<string, KiroToolUse>();

  for (const toolUse of toolUses) {
    const expanded = splitExpandedToolUseId(toolUse.toolUseId);
    const shouldGroup =
      expanded &&
      (toolUse.name === "read" || toolUse.name === "glob") &&
      ((expandedCounts.get(expanded.baseId) || 0) > 1 || plainIds.has(expanded.baseId));
    if (!shouldGroup || !expanded) {
      output.push(toolUse);
      if (!expanded) grouped.set(toolUse.toolUseId, toolUse);
      continue;
    }

    const operations =
      toolUse.name === "read" && Array.isArray(toolUse.input.operations)
        ? toolUse.input.operations
        : toolUse.name === "glob"
          ? [
              {
                ...(typeof toolUse.input.path === "string" ? { path: toolUse.input.path } : {}),
                mode: "Directory",
              },
            ]
          : [];
    const existing = grouped.get(expanded.baseId);
    if (!existing) {
      const aggregate = {
        toolUseId: expanded.baseId,
        name: "read",
        input: { operations: [...operations] },
      };
      grouped.set(expanded.baseId, aggregate);
      output.push(aggregate);
      continue;
    }

    const existingOperations = Array.isArray(existing.input.operations)
      ? existing.input.operations
      : [];
    existing.input.operations = [...existingOperations, ...operations];
  }

  return output;
}

function toolUseBlocksFromAssistant(message: JsonRecord): KiroToolUse[] {
  const toolUses: KiroToolUse[] = [];

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const name = normalizeToolNameForKiro(block.name);
      if (!isClaudeExecutableKiroTool(name)) continue;
      toolUses.push({
        toolUseId: String(block.id || uuidv4()),
        name,
        input: normalizeKiroToolUseInput(name, block.input),
      });
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      const functionDef = isRecord(call.function) ? call.function : null;
      const name = normalizeToolNameForKiro(functionDef?.name ?? call.name);
      if (!isClaudeExecutableKiroTool(name)) continue;
      toolUses.push({
        toolUseId: String(call.id || uuidv4()),
        name,
        input: normalizeKiroToolUseInput(name, functionDef?.arguments ?? call.input),
      });
    }
  }

  return aggregateExpandedToolUses(toolUses);
}

function contentPartFromToolResultContent(
  content: unknown,
  keepStringAsText = false
): KiroToolResultContent[] {
  const sanitized = sanitizeForKiro(content);
  if (Array.isArray(sanitized)) {
    const parts = sanitized.flatMap((item) =>
      contentPartFromToolResultContent(item, keepStringAsText)
    );
    return parts.length > 0 ? parts : [{ text: "" }];
  }

  if (typeof sanitized === "string") {
    if (keepStringAsText) return [{ text: sanitized }];
    const parsed = parseJsonString(sanitized);
    if (parsed !== null && (Array.isArray(parsed) || isRecord(parsed))) return [{ json: parsed }];
    return [{ text: sanitized }];
  }

  if (sanitized == null) return [{ text: "" }];
  if (isRecord(sanitized) || Array.isArray(sanitized)) return [{ json: sanitized }];
  return [{ text: String(sanitized) }];
}

function splitExpandedToolUseId(toolUseId: string): { baseId: string; index: number } | null {
  const match = toolUseId.match(/^(.+)_([0-9]+)$/);
  if (!match) return null;
  return { baseId: match[1], index: Number(match[2]) };
}

function aggregateExpandedToolResults(results: KiroToolResult[]): KiroToolResult[] {
  const expandedCounts = new Map<string, number>();
  const plainIds = new Set<string>();
  for (const result of results) {
    const expanded = splitExpandedToolUseId(result.toolUseId);
    if (!expanded) {
      plainIds.add(result.toolUseId);
      continue;
    }
    expandedCounts.set(expanded.baseId, (expandedCounts.get(expanded.baseId) || 0) + 1);
  }

  const output: KiroToolResult[] = [];
  const grouped = new Map<string, KiroToolResult & { _order?: number }>();

  for (let order = 0; order < results.length; order++) {
    const result = results[order];
    const expanded = splitExpandedToolUseId(result.toolUseId);
    const shouldGroup =
      expanded && ((expandedCounts.get(expanded.baseId) || 0) > 1 || plainIds.has(expanded.baseId));
    if (!shouldGroup || !expanded) {
      output.push(result);
      if (!expanded) grouped.set(result.toolUseId, result);
      continue;
    }

    const existing = grouped.get(expanded.baseId);
    if (!existing) {
      const aggregate = {
        toolUseId: expanded.baseId,
        content: [...result.content],
        status: result.status,
        _order: order,
      };
      grouped.set(expanded.baseId, aggregate);
      output.push(aggregate);
      continue;
    }

    existing.content.push(...result.content);
    if (result.status === "error") existing.status = "error";
  }

  return output.map((result) => {
    if ("_order" in result) {
      const { _order: _ignored, ...clean } = result;
      return clean;
    }
    return result;
  });
}

function toolResultsFromMessage(message: JsonRecord): KiroToolResult[] {
  const results: KiroToolResult[] = [];

  if (message.role === "tool") {
    const toolUseId = String(message.tool_call_id || message.id || uuidv4());
    results.push({
      toolUseId,
      content: contentPartFromToolResultContent(
        message.content,
        shouldKeepToolResultAsText(toolUseId)
      ),
      status: "success",
    });
  }

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id || uuidv4());
      results.push({
        toolUseId,
        content: contentPartFromToolResultContent(
          block.content,
          shouldKeepToolResultAsText(toolUseId)
        ),
        status: block.is_error ? "error" : "success",
      });
    }
  }

  return aggregateExpandedToolResults(results);
}

function buildUserTurn(
  content: string,
  modelId: string,
  toolResults: KiroToolResult[] = [],
  tools: JsonRecord[] = [],
  includeEnvState = false,
  images: Array<{ format: string; source: { bytes: string } }> = [],
  includeModelId = false
): { userInputMessage: KiroUserInputMessage } {
  const context: KiroUserInputMessage["userInputMessageContext"] = {};
  if (includeEnvState) context.envState = buildKiroEnvState();
  if (toolResults.length > 0) context.toolResults = toolResults;
  if (tools.length > 0) context.tools = tools;

  const userInputMessage: KiroUserInputMessage = {
    content,
    origin: KIRO_USER_ORIGIN,
  };

  if (includeModelId) userInputMessage.modelId = modelId;
  if (images.length > 0) userInputMessage.images = images;
  if (Object.keys(context).length > 0) userInputMessage.userInputMessageContext = context;
  return { userInputMessage };
}

function mergeAdjacentHistory(history: KiroHistoryItem[]): KiroHistoryItem[] {
  const merged: KiroHistoryItem[] = [];
  for (const item of history) {
    const previous = merged[merged.length - 1];

    if ("userInputMessage" in item && previous && "userInputMessage" in previous) {
      const previousUser = previous.userInputMessage;
      const currentUser = item.userInputMessage;
      previousUser.content = [previousUser.content, currentUser.content]
        .filter(Boolean)
        .join("\n\n");
      const images = [...(previousUser.images || []), ...(currentUser.images || [])];
      if (images.length > 0) {
        previousUser.images = images;
      } else {
        delete previousUser.images;
      }

      const previousContext = previousUser.userInputMessageContext || {};
      const currentContext = currentUser.userInputMessageContext || {};
      const toolResults = aggregateExpandedToolResults([
        ...(previousContext.toolResults || []),
        ...(currentContext.toolResults || []),
      ]);
      const tools = [...(previousContext.tools || []), ...(currentContext.tools || [])];
      previousUser.userInputMessageContext = {
        ...(previousContext.envState || currentContext.envState
          ? { envState: previousContext.envState || currentContext.envState }
          : {}),
        ...(toolResults.length > 0 ? { toolResults } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      };
      if (Object.keys(previousUser.userInputMessageContext).length === 0) {
        delete previousUser.userInputMessageContext;
      }
      continue;
    }

    if ("assistantResponseMessage" in item && previous && "assistantResponseMessage" in previous) {
      const previousAssistant = previous.assistantResponseMessage;
      const currentAssistant = item.assistantResponseMessage;
      previousAssistant.content = [previousAssistant.content, currentAssistant.content]
        .filter(Boolean)
        .join("\n\n");
      previousAssistant.toolUses = aggregateExpandedToolUses([
        ...(previousAssistant.toolUses || []),
        ...(currentAssistant.toolUses || []),
      ]);
      if (!previousAssistant.toolUses || previousAssistant.toolUses.length === 0) {
        delete previousAssistant.toolUses;
      }
      continue;
    }

    merged.push(item);
  }
  return merged;
}

function convertMessagesToKiro(
  messages: unknown,
  modelId: string,
  tools: JsonRecord[]
): { history: KiroHistoryItem[]; currentMessage: { userInputMessage: KiroUserInputMessage } } {
  const history: KiroHistoryItem[] = [];
  const inputMessages = Array.isArray(messages) ? messages : [];

  for (const rawMessage of inputMessages) {
    if (!isRecord(rawMessage)) continue;
    const message = sanitizeForKiro(rawMessage) as JsonRecord;
    const role = String(message.role || "user");

    if (role === "assistant") {
      const content = textFromContentBlocks(message.content);
      const toolUses = toolUseBlocksFromAssistant(message);
      const assistantResponseMessage: KiroAssistantResponseMessage = {
        content,
      };
      if (typeof message.id === "string") assistantResponseMessage.messageId = message.id;
      if (toolUses.length > 0) {
        assistantResponseMessage.messageId = assistantResponseMessage.messageId || uuidv4();
        assistantResponseMessage.toolUses = toolUses;
      }
      history.push({ assistantResponseMessage });
      continue;
    }

    const toolResults = toolResultsFromMessage(message);
    const content = toolResults.length > 0 ? "" : textFromContentBlocks(message.content);
    const images = imageBlocksFromContent(message.content);
    history.push(buildUserTurn(content, modelId, toolResults, [], false, images));
  }

  const mergedHistory = mergeAdjacentHistory(history);
  let currentMessage: { userInputMessage: KiroUserInputMessage };
  if (mergedHistory.length > 0 && "userInputMessage" in mergedHistory[mergedHistory.length - 1]) {
    currentMessage = mergedHistory.pop() as { userInputMessage: KiroUserInputMessage };
  } else {
    currentMessage = buildUserTurn("", modelId);
  }

  const currentContext = currentMessage.userInputMessage.userInputMessageContext || {};
  currentContext.envState = currentContext.envState || buildKiroEnvState();
  if (tools.length > 0) currentContext.tools = tools;
  currentMessage.userInputMessage.userInputMessageContext = currentContext;
  currentMessage.userInputMessage.modelId = modelId;
  currentMessage.userInputMessage.origin = KIRO_USER_ORIGIN;

  return { history: mergedHistory, currentMessage };
}

function prependSystemMessage(body: JsonRecord): unknown[] {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (!body.system) return messages;
  if (messages.some((message) => isRecord(message) && message.role === "system")) return messages;

  const systemContent = stringifyKiroContent(body.system).trim();
  if (!systemContent) return messages;
  return [{ role: "system", content: systemContent }, ...messages];
}

function messageListHasToolContract(messages: unknown[]): boolean {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
    if (message.role === "tool") return true;
    if (
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && (block.type === "tool_use" || block.type === "tool_result")
      )
    ) {
      return true;
    }
  }
  return false;
}

function deriveWorkspaceDirectory(body: JsonRecord, messages: unknown[]): string {
  const metadata = isRecord(body.metadata) ? body.metadata : null;
  const explicit =
    metadata?.currentWorkingDirectory || metadata?.cwd || body.currentWorkingDirectory || body.cwd;
  if (typeof explicit === "string" && explicit.trim()) return explicit;

  const serialized = JSON.stringify(messages);
  const windowsPath = serialized.match(/[A-Za-z]:\\(?:[^\\\"\n\r]+\\)+[^\\\"\n\r]*/)?.[0];
  if (windowsPath) {
    const trimmed = windowsPath.replace(/^\\\\\?\\/, "");
    const lastSlash = trimmed.lastIndexOf("\\");
    return lastSlash > 2 ? trimmed.slice(0, lastSlash) : trimmed;
  }

  const posixPath = serialized.match(/\/(?:[^/\"\n\r]+\/)+[^/\"\n\r]*/)?.[0];
  if (posixPath) {
    const lastSlash = posixPath.lastIndexOf("/");
    return lastSlash > 0 ? posixPath.slice(0, lastSlash) : posixPath;
  }

  return process.cwd();
}

function deriveConversationId(history: KiroHistoryItem[], currentContent: string): string {
  const firstUser = history.find((item) => "userInputMessage" in item) as
    | { userInputMessage: KiroUserInputMessage }
    | undefined;
  const seed = firstUser?.userInputMessage.content || currentContent || "";
  return uuidv5(seed.slice(0, 4000), KIRO_CONVERSATION_NAMESPACE);
}

function sanitizeFinalPayload(payload: JsonRecord): JsonRecord {
  return sanitizeForKiro(payload) as JsonRecord;
}

export function consumeKiroCompressionStats(payload: unknown): {
  originalTokens: number;
  compressedTokens: number;
  tokensCompressed: number;
} | null {
  if (!isRecord(payload) || !isRecord(payload._omnirouteCompressionStats)) return null;
  const stats = payload._omnirouteCompressionStats;
  const originalTokens = stats.originalTokens;
  const compressedTokens = stats.compressedTokens;
  const tokensCompressed = stats.tokensCompressed;
  if (
    typeof originalTokens !== "number" ||
    typeof compressedTokens !== "number" ||
    typeof tokensCompressed !== "number"
  ) {
    return null;
  }
  return { originalTokens, compressedTokens, tokensCompressed };
}

export function buildKiroPayload(
  model,
  body,
  _stream,
  credentials,
  _options?: { enableCompression?: boolean }
) {
  const bodyCopy = sanitizeForKiro(deepClone(body || {})) as JsonRecord;
  const modelId = normalizeModel(model || bodyCopy.model || "auto");
  const messages = prependSystemMessage(bodyCopy);
  const currentWorkingDirectory = deriveWorkspaceDirectory(bodyCopy, messages);
  const tools =
    Array.isArray(bodyCopy.tools) && bodyCopy.tools.length > 0
      ? buildKiroTools(bodyCopy.tools)
      : messageListHasToolContract(messages)
        ? buildKiroToolSpecsForClaudeCode()
        : [];
  const { history, currentMessage } = convertMessagesToKiro(messages, modelId, tools);
  if (!currentMessage.userInputMessage.userInputMessageContext) {
    currentMessage.userInputMessage.userInputMessageContext = {};
  }
  currentMessage.userInputMessage.userInputMessageContext.envState =
    buildKiroEnvState(currentWorkingDirectory);

  const conversationState: JsonRecord = {
    conversationId:
      typeof bodyCopy.conversationId === "string"
        ? bodyCopy.conversationId
        : deriveConversationId(history, currentMessage.userInputMessage.content),
    history,
    currentMessage,
    chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
    agentTaskType: "vibe",
  };

  const payload: JsonRecord = { conversationState };
  const credentialRecord = isRecord(credentials) ? credentials : null;
  const providerSpecificData = isRecord(credentialRecord?.providerSpecificData)
    ? credentialRecord.providerSpecificData
    : null;
  const profileArn =
    typeof bodyCopy.profileArn === "string"
      ? bodyCopy.profileArn
      : typeof providerSpecificData?.profileArn === "string"
        ? providerSpecificData.profileArn
        : undefined;

  if (typeof profileArn === "string" && profileArn.trim()) {
    payload.profileArn = profileArn;
  }
  if (isRecord(bodyCopy._omnirouteCompressionStats)) {
    payload._omnirouteCompressionStats = bodyCopy._omnirouteCompressionStats;
  }

  return sanitizeFinalPayload(payload);
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload);
