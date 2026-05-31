import assert from "node:assert/strict";
import test from "node:test";

import { buildAntigravityMitmStartBody } from "../../src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.tsx";

test("buildAntigravityMitmStartBody resolves the selected raw API key", () => {
  const body = buildAntigravityMitmStartBody({
    apiKeys: [
      { id: "key-1", rawKey: "sk_test_123", key: "masked-1" },
      { id: "key-2", rawKey: "sk_test_456", key: "masked-2" },
    ],
    selectedApiKeyId: "key-2",
    sudoPassword: "secret",
  });

  assert.equal(body.apiKey, "sk_test_456");
  assert.equal(body.keyId, "key-2");
  assert.equal(body.sudoPassword, "secret");
});

test("buildAntigravityMitmStartBody falls back to the first key when none is selected", () => {
  const body = buildAntigravityMitmStartBody({
    apiKeys: [{ id: "key-1", rawKey: "sk_test_123", key: "masked-1" }],
    selectedApiKeyId: "",
    sudoPassword: "",
  });

  assert.equal(body.apiKey, "sk_test_123");
  assert.equal(body.keyId, "key-1");
});

test("buildAntigravityMitmStartBody uses the OmniRoute placeholder when no keys are available", () => {
  const body = buildAntigravityMitmStartBody({
    apiKeys: [],
    selectedApiKeyId: "",
    sudoPassword: "",
  });

  assert.equal(body.apiKey, "sk_omniroute");
  assert.equal(body.keyId, null);
});
