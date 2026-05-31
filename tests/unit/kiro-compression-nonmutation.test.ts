import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKiroPayload,
  consumeKiroCompressionStats,
} from "../../open-sse/translator/request/openai-to-kiro";

test("buildKiroPayload does not mutate body._omnirouteCompressionStats", () => {
  const body = {
    messages: [{ role: "user", content: "echo hi" }],
    _omnirouteCompressionStats: { original: 1000, final: 900 },
  } as any;

  const original = JSON.parse(JSON.stringify(body));

  const out = buildKiroPayload("claude-sonnet-4-6", body, false, {} as any, {
    enableCompression: false,
  });

  // input unchanged
  assert.deepStrictEqual(body, original);

  // final payload may include _omnirouteCompressionStats but original must be intact
  assert.strictEqual(typeof out, "object");
});

test("consumeKiroCompressionStats reads stats without deleting field", () => {
  const payload: any = {
    foo: 1,
    _omnirouteCompressionStats: {
      originalTokens: 200,
      compressedTokens: 150,
      tokensCompressed: 50,
    },
  };
  const stats = consumeKiroCompressionStats(payload);
  assert.ok(stats && typeof stats.originalTokens === "number");
  // payload must still contain the field
  assert.ok(payload._omnirouteCompressionStats);
});
