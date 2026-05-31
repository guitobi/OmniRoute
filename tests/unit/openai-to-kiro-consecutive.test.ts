import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro";
import assert from "node:assert/strict";
import test from "node:test";

const sampleBody = {
  messages: [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "Write a short hello function in JS." },
  ],
  max_tokens: 512,
  _omnirouteCompressionStats: { original: 1000, final: 900 },
};

test("openai->kiro consecutive calls: does not mutate input and returns valid payloads across multiple calls", () => {
  const originalCopy = JSON.parse(JSON.stringify(sampleBody));
  const outputs: any[] = [];
  for (let i = 0; i < 5; i++) {
    const out = buildKiroPayload("claude-sonnet-4-6", sampleBody as any, false, {} as any, {
      enableCompression: false,
    });
    outputs.push(out);
  }

  // input should be unchanged
  assert.deepStrictEqual(sampleBody, originalCopy);

  // each output must include conversationState.currentMessage.userInputMessage.content
  for (const out of outputs) {
    assert.ok(out && out.conversationState, "missing conversationState");
    const cm = out.conversationState.currentMessage;
    assert.ok(cm && cm.userInputMessage, "missing current userInputMessage");
    assert.strictEqual(typeof cm.userInputMessage.content, "string");
    assert.ok(cm.userInputMessage.content.length > 0);
  }
});
