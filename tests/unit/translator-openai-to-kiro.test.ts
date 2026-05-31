import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { buildKiroPayload, consumeKiroCompressionStats } =
  await import("../../open-sse/translator/request/openai-to-kiro.ts");

const nativeToolNames = [
  "code",
  "glob",
  "grep",
  "introspect",
  "knowledge",
  "read",
  "shell",
  "subagent",
  "todo_list",
  "use_aws",
  "web_fetch",
  "web_search",
  "write",
];

function buildClaudeCodePayload() {
  return {
    model: "kiro/claude-sonnet-4.5",
    messages: [
      { role: "user", content: [{ type: "text", text: "System context" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect files." },
          { type: "tool_use", id: "glob_1", name: "Glob", input: { pattern: "**/*.ts" } },
          {
            type: "tool_use",
            id: "read_1",
            name: "Read",
            input: { file_path: "src/index.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "glob_1", content: "src/index.ts" },
          { type: "tool_result", tool_use_id: "read_1", content: "export {};" },
        ],
      },
    ],
    tools: [
      { _omniroute_truncated_array: true, originalLength: 99 },
      {
        name: "Glob",
        description: "Glob files",
        input_schema: { type: "object", properties: { pattern: { type: "string" } } },
      },
      {
        name: "Read",
        description: "Read files",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" }, broken: "[MaxDepth]" },
        },
      },
      { name: "EnterPlanMode", description: "Proxy-only", input_schema: { type: "object" } },
    ],
    stream: true,
  };
}

test("OpenAI -> Kiro emits strict native Kiro envelope", () => {
  const result = buildKiroPayload("kiro/claude-sonnet-4.5", buildClaudeCodePayload(), true, {
    providerSpecificData: { profileArn: "arn:test" },
  });

  assert.deepEqual(Object.keys(result), ["conversationState", "profileArn"]);
  assert.equal(result.profileArn, "arn:test");
  assert.equal(result.conversationState.chatTriggerType, "MANUAL");
  assert.equal(result.conversationState.agentTaskType, "vibe");
  assert.match(result.conversationState.conversationId, /^[0-9a-f-]{36}$/);
});

test("OpenAI -> Kiro keeps modelId only on currentMessage", () => {
  const result = buildKiroPayload("kiro/claude-sonnet-4.5", buildClaudeCodePayload(), true, null);

  assert.equal(
    result.conversationState.currentMessage.userInputMessage.modelId,
    "claude-sonnet-4.5"
  );
  assert.equal(
    result.conversationState.history.some(
      (item) => item.userInputMessage && "modelId" in item.userInputMessage
    ),
    false
  );
});

test("OpenAI -> Kiro exposes only native Kiro tools", () => {
  const result = buildKiroPayload("kiro/claude-sonnet-4.5", buildClaudeCodePayload(), true, null);
  const tools =
    result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;

  assert.deepEqual(
    tools.map((tool) => tool.toolSpecification.name),
    nativeToolNames
  );
  assert.equal(JSON.stringify(tools).includes("EnterPlanMode"), false);
  assert.equal(JSON.stringify(tools).includes("_omniroute_truncated_array"), false);
  assert.equal(JSON.stringify(tools).includes("[MaxDepth]"), false);
});

test("OpenAI -> Kiro replays supplied Claude payload without dirty proxy artifacts", () => {
  const claudePayload = JSON.parse(readFileSync("tests/fixtures/kiro/claude-payload.json", "utf8"));
  const expectedKiroPayload = JSON.parse(
    readFileSync("tests/fixtures/kiro/kiro-payload.json", "utf8")
  );

  const result = buildKiroPayload("kiro/claude-sonnet-4.5", claudePayload, true, null);
  const serialized = JSON.stringify(result);
  const current = result.conversationState.currentMessage.userInputMessage;
  const toolNames = current.userInputMessageContext.tools.map(
    (tool) => tool.toolSpecification.name
  );

  assert.equal(serialized.includes("_omniroute_truncated_array"), false);
  assert.equal(serialized.includes("[MaxDepth]"), false);
  assert.deepEqual(toolNames, nativeToolNames);
  assert.equal(current.content, "");
  assert.ok(Array.isArray(current.userInputMessageContext.toolResults));
  assert.ok(current.userInputMessageContext.toolResults.length > 0);
  assert.deepEqual(
    Object.keys(result.conversationState).sort(),
    Object.keys(expectedKiroPayload.conversationState).sort()
  );
});

test("OpenAI -> Kiro restores tool schema when follow-up omits tools", () => {
  const result = buildKiroPayload(
    "kiro/claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Read file" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "read_1",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "D:\\repo\\a.ts" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "read_1", content: "export {};" },
      ],
    },
    true,
    null
  );

  assert.deepEqual(
    result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map(
      (tool) => tool.toolSpecification.name
    ),
    nativeToolNames
  );
});

test("OpenAI -> Kiro maps assistant tool uses to native tool inputs", () => {
  const result = buildKiroPayload("kiro/claude-sonnet-4.5", buildClaudeCodePayload(), true, null);
  const assistant = result.conversationState.history.find((item) => item.assistantResponseMessage);

  assert.ok(assistant.assistantResponseMessage.messageId);
  assert.deepEqual(assistant.assistantResponseMessage.toolUses, [
    { toolUseId: "glob_1", name: "glob", input: { pattern: "**/*.ts" } },
    {
      toolUseId: "read_1",
      name: "read",
      input: { operations: [{ path: "src/index.ts", mode: "Line" }] },
    },
  ]);
});

test("OpenAI -> Kiro maps final tool results under currentMessage context", () => {
  const result = buildKiroPayload("kiro/claude-sonnet-4.5", buildClaudeCodePayload(), true, null);
  const current = result.conversationState.currentMessage.userInputMessage;

  assert.equal(current.content, "");
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    { toolUseId: "glob_1", content: [{ text: "src/index.ts" }], status: "success" },
    { toolUseId: "read_1", content: [{ text: "export {};" }], status: "success" },
  ]);
  assert.deepEqual(current.userInputMessageContext.envState, {
    operatingSystem:
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    currentWorkingDirectory: process.cwd(),
  });
});

test("OpenAI -> Kiro keeps role:tool payload out of userInputMessage.content", () => {
  const result = buildKiroPayload(
    "kiro/claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Inspect file" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "read_1",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "D:\\repo\\file.ts" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "read_1", content: "file contents" },
      ],
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
    },
    true,
    null
  );

  const current = result.conversationState.currentMessage.userInputMessage;
  assert.equal(current.content, "");
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    { toolUseId: "read_1", content: [{ text: "file contents" }], status: "success" },
  ]);
});

test("OpenAI -> Kiro keeps JSON-looking read results as text", () => {
  const result = buildKiroPayload(
    "kiro/claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Read package" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "read_json_1",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "D:\\repo\\package.json" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "read_json_1", content: '{"scripts":{"test":"node"}}' },
      ],
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
    },
    true,
    null
  );

  const current = result.conversationState.currentMessage.userInputMessage;
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    {
      toolUseId: "read_json_1",
      content: [{ text: '{"scripts":{"test":"node"}}' }],
      status: "success",
    },
  ]);
});

test("OpenAI -> Kiro aggregates expanded batch read results back to Kiro toolUseId", () => {
  const result = buildKiroPayload(
    "kiro/claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Read several files" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "tooluse_batch_0",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "D:\\repo\\a.ts" }),
              },
            },
            {
              id: "tooluse_batch_1",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "D:\\repo\\b.ts" }),
              },
            },
            {
              id: "tooluse_batch_2",
              type: "function",
              function: {
                name: "Glob",
                arguments: JSON.stringify({ pattern: "*", path: "D:\\repo\\src" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "tooluse_batch_0", content: "a" },
        { role: "tool", tool_call_id: "tooluse_batch_1", content: "b" },
        { role: "tool", tool_call_id: "tooluse_batch_2", content: "src/a.ts" },
      ],
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
    },
    true,
    null
  );

  const current = result.conversationState.currentMessage.userInputMessage;
  const assistant = result.conversationState.history.find((item) => item.assistantResponseMessage);

  assert.deepEqual(assistant.assistantResponseMessage.toolUses, [
    {
      toolUseId: "tooluse_batch",
      name: "read",
      input: {
        operations: [
          { path: "D:\\repo\\a.ts", mode: "Line" },
          { path: "D:\\repo\\b.ts", mode: "Line" },
          { path: "D:\\repo\\src", mode: "Directory" },
        ],
      },
    },
  ]);
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    {
      toolUseId: "tooluse_batch",
      content: [{ text: "a" }, { text: "b" }, { text: "src/a.ts" }],
      status: "success",
    },
  ]);
});

test("OpenAI -> Kiro supports multiple role:tool results as pure toolResults", () => {
  const result = buildKiroPayload(
    "kiro/claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Inspect files" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "glob_1",
              type: "function",
              function: { name: "Glob", arguments: JSON.stringify({ pattern: "*.ts" }) },
            },
            {
              id: "read_1",
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: "D:\\repo\\file.ts" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "glob_1", content: "file.ts" },
        { role: "tool", tool_call_id: "read_1", content: "file contents" },
      ],
      tools: [
        { name: "Glob", description: "Glob", input_schema: { type: "object" } },
        { name: "Read", description: "Read", input_schema: { type: "object" } },
      ],
    },
    true,
    null
  );

  const current = result.conversationState.currentMessage.userInputMessage;
  assert.equal(current.content, "");
  assert.deepEqual(
    current.userInputMessageContext.toolResults.map((result) => result.toolUseId),
    ["glob_1", "read_1"]
  );
});

test("OpenAI -> Kiro preserves compression metadata reader", () => {
  assert.deepEqual(
    consumeKiroCompressionStats({
      _omnirouteCompressionStats: {
        originalTokens: 20,
        compressedTokens: 12,
        tokensCompressed: 8,
      },
    }),
    { originalTokens: 20, compressedTokens: 12, tokensCompressed: 8 }
  );
});
