import test from "node:test";
import assert from "node:assert/strict";

import { APIKEY_PROVIDERS, supportsBulkApiKey } from "../../src/shared/constants/providers.ts";
import { validateBody, createProviderSchema } from "../../src/shared/validation/schemas.ts";
import {
  FREEBUFF_DEFAULT_LISTEN_PORT,
  FREEBUFF_DEFAULT_OVERRIDE_TIER,
  handleFreebuffRequest,
  normalizeFreebuffConnectionConfig,
} from "../../src/lib/providers/freebuff.ts";
import { handleFreebuffInterceptRequest } from "../../src/lib/providers/freebuffIntercept.ts";

test("Freebuff provider is registered and accepts a connection without apiKey", () => {
  assert.equal(APIKEY_PROVIDERS.freebuff.id, "freebuff");
  assert.equal(APIKEY_PROVIDERS.freebuff.name, "Freebuff");
  assert.equal(supportsBulkApiKey("freebuff"), false);

  const validation = validateBody(createProviderSchema, {
    provider: "freebuff",
    name: "Local Freebuff Interceptor",
    providerSpecificData: {
      listenPort: 20128,
      overrideTier: "unlimited",
    },
  });

  assert.equal(validation.success, true);
  if (validation.success) {
    assert.equal(validation.data.apiKey, undefined);
    assert.deepEqual(validation.data.providerSpecificData, {
      listenPort: 20128,
      overrideTier: "unlimited",
    });
  }
});

test("Freebuff config defaults and validates listenPort/overrideTier", () => {
  assert.deepEqual(normalizeFreebuffConnectionConfig(undefined), {
    listenPort: FREEBUFF_DEFAULT_LISTEN_PORT,
    overrideTier: FREEBUFF_DEFAULT_OVERRIDE_TIER,
  });

  const invalidPort = validateBody(createProviderSchema, {
    provider: "freebuff",
    name: "Bad Freebuff",
    providerSpecificData: { listenPort: 70000, overrideTier: "pro" },
  });
  assert.equal(invalidPort.success, false);

  const invalidTier = validateBody(createProviderSchema, {
    provider: "freebuff",
    name: "Bad Freebuff",
    providerSpecificData: { listenPort: 20128, overrideTier: "" },
  });
  assert.equal(invalidTier.success, false);
});

test("Freebuff session mock injects configured override tier", async () => {
  const response = await handleFreebuffRequest(
    new Request("http://localhost:20128/api/v1/freebuff/session", { method: "GET" }),
    { overrideTier: "unlimited" }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), {
    status: "active",
    accessTier: "unlimited",
    message: "Premium active",
    queueDepthByModel: {},
    countryCode: "US",
    countryBlockReason: null,
    ipPrivacySignals: null,
  });
});

test("Freebuff ad and telemetry mocks do not call upstream", async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return new Response("unexpected");
  };

  const ads = await handleFreebuffRequest(
    new Request("http://localhost:20128/api/v1/ads", { method: "POST" }),
    undefined,
    fetchImpl
  );
  assert.deepEqual(await ads.json(), { ads: [], provider: "zeroclick" });

  const telemetry = await handleFreebuffRequest(
    new Request("http://localhost:20128/events/batch/upload", { method: "PUT" }),
    undefined,
    fetchImpl
  );
  assert.deepEqual(await telemetry.json(), { success: true, creditsGranted: 0 });
  assert.equal(fetchCalled, false);
});

test("Freebuff proxy picks auth upstream and rewrites Host header", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const responseHeaders = new Headers({ "x-upstream": "freebuff" });
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response("auth-ok", { status: 202, headers: responseHeaders });
  };

  const response = await handleFreebuffRequest(
    new Request("http://localhost:20128/api/auth/cli/login?state=abc", {
      method: "POST",
      headers: { host: "localhost:20128", "x-test": "1" },
      body: "payload",
    }),
    undefined,
    fetchImpl
  );

  assert.equal(capturedUrl, "https://freebuff.com/api/auth/cli/login?state=abc");
  assert.equal(capturedInit?.method, "POST");
  assert.equal((capturedInit?.headers as Headers).get("host"), "freebuff.com");
  assert.equal((capturedInit?.headers as Headers).get("x-test"), "1");
  assert.equal(await response.text(), "auth-ok");
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-upstream"), "freebuff");
});

test("Freebuff proxy omits body for GET and targets Codebuff fallback", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response("model-ok", { status: 200 });
  };

  await handleFreebuffRequest(
    new Request("http://localhost:20128/api/v1/models", { method: "GET" }),
    undefined,
    fetchImpl
  );

  assert.equal(capturedUrl, "https://www.codebuff.com/api/v1/models");
  assert.equal(capturedInit?.method, "GET");
  assert.equal(capturedInit?.body, undefined);
  assert.equal((capturedInit?.headers as Headers).get("host"), "www.codebuff.com");
});

test("Freebuff internal MITM endpoint validates secret and uses target URL", async () => {
  const denied = await handleFreebuffInterceptRequest(
    new Request("http://localhost/api/freebuff/intercept", {
      headers: {
        "x-omniroute-freebuff-mitm-secret": "wrong",
        "x-omniroute-freebuff-target-url": "https://codebuff.com/api/v1/freebuff/session",
      },
    }),
    { expectedSecret: "secret" }
  );
  assert.equal(denied.status, 403);

  const allowed = await handleFreebuffInterceptRequest(
    new Request("http://localhost/api/freebuff/intercept", {
      headers: {
        host: "localhost",
        "x-omniroute-freebuff-mitm-secret": "secret",
        "x-omniroute-freebuff-target-url": "https://codebuff.com/api/v1/freebuff/session",
      },
    }),
    {
      expectedSecret: "secret",
      configResolver: async () => ({ listenPort: 20128, overrideTier: "pro" }),
    }
  );

  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.equal(payload.accessTier, "pro");
});
