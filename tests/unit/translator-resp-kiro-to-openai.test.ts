import test from "node:test";
import assert from "node:assert/strict";

const { convertKiroToOpenAI } =
  await import("../../open-sse/translator/response/kiro-to-openai.ts");

test("Kiro -> OpenAI: first assistantResponseEvent emits role and content", () => {
  const state = {};
  const chunk = 'event:assistantResponseEvent\ndata:{"content":"Hello"}\n\n';
  const result = convertKiroToOpenAI(chunk, state);

  assert.equal(result.object, "chat.completion.chunk");
  assert.equal(result.choices[0].delta.role, "assistant");
  assert.equal(result.choices[0].delta.content, "Hello");
});

test("Kiro -> OpenAI: subsequent assistantResponseEvent omits role", () => {
  const state = {};
  convertKiroToOpenAI('event:assistantResponseEvent\ndata:{"content":"Hel"}\n\n', state);
  const result = convertKiroToOpenAI(
    'event:assistantResponseEvent\ndata:{"content":"lo"}\n\n',
    state
  );

  assert.equal(result.choices[0].delta.role, undefined);
  assert.equal(result.choices[0].delta.content, "lo");
});

test("Kiro -> OpenAI: reasoningContentEvent is wrapped as thinking tags", () => {
  const result = convertKiroToOpenAI(
    'event:reasoningContentEvent\ndata:{"content":"Need to inspect first"}\n\n',
    {}
  );

  assert.equal(result.choices[0].delta.content, "<thinking>Need to inspect first</thinking>");
});

test("Kiro -> OpenAI: native read toolUseEvent becomes Claude Code Read tool_call", () => {
  const result = convertKiroToOpenAI(
    {
      _eventType: "toolUseEvent",
      toolUseId: "call_1",
      name: "read",
      input: { operations: [{ path: "/tmp/a", mode: "Line", offset: 2, limit: 10 }] },
    },
    {}
  );

  assert.equal(result.choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(result.choices[0].delta.tool_calls[0].function.name, "Read");
  assert.equal(
    result.choices[0].delta.tool_calls[0].function.arguments,
    JSON.stringify({ file_path: "/tmp/a", offset: 2, limit: 10 })
  );
});

test("Kiro -> OpenAI: native tool names are mapped back to Claude Code names", () => {
  const cases = [
    ["glob", "Glob"],
    ["grep", "Grep"],
    ["shell", "PowerShell"],
    ["web_fetch", "WebFetch"],
    ["web_search", "WebSearch"],
    ["write", "Write"],
  ];

  for (const [kiroName, claudeName] of cases) {
    const result = convertKiroToOpenAI(
      { _eventType: "toolUseEvent", toolUseId: `call_${kiroName}`, name: kiroName, input: {} },
      {}
    );
    assert.equal(result.choices[0].delta.tool_calls[0].function.name, claudeName);
  }
});

test("Kiro -> OpenAI: Kiro-only tool arguments are stripped for Claude Code schemas", () => {
  const shell = convertKiroToOpenAI(
    {
      _eventType: "toolUseEvent",
      toolUseId: "call_shell",
      name: "shell",
      input: {
        command: "Get-Location",
        cwd: "D:\\tmp",
        timeout_ms: 1000,
        __tool_use_purpose: "Check cwd",
      },
    },
    {}
  );
  assert.equal(shell.choices[0].delta.tool_calls[0].function.name, "PowerShell");
  assert.equal(
    shell.choices[0].delta.tool_calls[0].function.arguments,
    JSON.stringify({ command: "Get-Location", timeout: 1000, description: "Check cwd" })
  );

  const directoryRead = convertKiroToOpenAI(
    {
      _eventType: "toolUseEvent",
      toolUseId: "call_dir",
      name: "read",
      input: { operations: [{ path: "D:\\repo", mode: "Directory", depth: 2 }] },
    },
    {}
  );
  assert.equal(directoryRead.choices[0].delta.tool_calls[0].function.name, "Glob");
  assert.equal(
    directoryRead.choices[0].delta.tool_calls[0].function.arguments,
    JSON.stringify({ pattern: "*", path: "D:\\repo" })
  );
});

test("Kiro -> OpenAI: stringified Kiro read input is parsed before Claude mapping", () => {
  const result = convertKiroToOpenAI(
    {
      _eventType: "toolUseEvent",
      toolUseId: "call_read_string",
      name: "read",
      input: JSON.stringify({ operations: [{ path: "D:\\repo\\file.ts", mode: "Line" }] }),
    },
    {}
  );

  assert.equal(result.choices[0].delta.tool_calls[0].function.name, "Read");
  assert.equal(
    result.choices[0].delta.tool_calls[0].function.arguments,
    JSON.stringify({ file_path: "D:\\repo\\file.ts" })
  );
});

test("Kiro -> OpenAI: batch read toolUseEvent expands to multiple Claude Code tool_calls", () => {
  const result = convertKiroToOpenAI(
    {
      _eventType: "toolUseEvent",
      toolUseId: "call_batch",
      name: "read",
      input: {
        operations: [
          { path: "D:\\repo\\a.ts", mode: "Line", offset: 4, limit: 8 },
          { path: "D:\\repo\\b.ts", mode: "Line" },
          { path: "D:\\repo\\src", mode: "Directory" },
        ],
      },
    },
    {}
  );

  const toolCalls = result.choices[0].delta.tool_calls;
  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ["call_batch_0", "call_batch_1", "call_batch_2"]
  );
  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.function.name),
    ["Read", "Read", "Glob"]
  );
  assert.equal(
    toolCalls[0].function.arguments,
    JSON.stringify({ file_path: "D:\\repo\\a.ts", offset: 4, limit: 8 })
  );
  assert.equal(toolCalls[1].function.arguments, JSON.stringify({ file_path: "D:\\repo\\b.ts" }));
  assert.equal(
    toolCalls[2].function.arguments,
    JSON.stringify({ pattern: "*", path: "D:\\repo\\src" })
  );
});

test("Kiro -> OpenAI: Kiro code toolUseEvent maps to executable Claude Code tool_call", () => {
  const result = convertKiroToOpenAI(
    {
      _eventType: "toolUseEvent",
      toolUseId: "call_code",
      name: "code",
      input: { operation: "pattern_search", pattern: "buildKiroPayload", path: "open-sse" },
    },
    {}
  );

  assert.equal(result.choices[0].delta.tool_calls[0].function.name, "Grep");
  assert.equal(
    result.choices[0].delta.tool_calls[0].function.arguments,
    JSON.stringify({ pattern: "buildKiroPayload", path: "open-sse" })
  );
});

test("Kiro -> OpenAI: usageEvent is stored and final done event includes usage", () => {
  const state = {};
  const usage = convertKiroToOpenAI(
    'event:usageEvent\ndata:{"inputTokens":4,"outputTokens":6}\n\n',
    state
  );
  const done = convertKiroToOpenAI("event:done\ndata:{}\n\n", state);

  assert.equal(usage, null);
  assert.equal(done.choices[0].finish_reason, "stop");
  assert.deepEqual(done.usage, {
    prompt_tokens: 4,
    completion_tokens: 6,
    total_tokens: 10,
  });
});

test("Kiro -> OpenAI: already-normalized OpenAI chunks pass through unchanged", () => {
  const chunk = {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
  };

  assert.equal(convertKiroToOpenAI(chunk, {}), chunk);
});

test("Kiro -> OpenAI: unknown or empty events are ignored", () => {
  assert.equal(convertKiroToOpenAI("event:unknown\ndata:{}\n\n", {}), null);
  assert.equal(convertKiroToOpenAI("event:assistantResponseEvent\n\n", {}), null);
});
