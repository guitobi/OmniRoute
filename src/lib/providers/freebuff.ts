export const FREEBUFF_PROVIDER_ID = "freebuff";
export const FREEBUFF_DEFAULT_LISTEN_PORT = 20128;
export const FREEBUFF_DEFAULT_OVERRIDE_TIER = "pro";
export const FREEBUFF_ALLOWED_PROXY_HOSTS = new Set([
  "codebuff.com",
  "www.codebuff.com",
  "freebuff.com",
]);

export interface FreebuffConnectionConfig {
  listenPort: number;
  overrideTier: string;
}

export type FreebuffFetch = (
  input: string | URL | Request,
  init?: RequestInit & { duplex?: "half" }
) => Promise<Response>;

const FREEBUFF_AUTH_UPSTREAM = new URL("https://freebuff.com");
const FREEBUFF_DEFAULT_UPSTREAM = new URL("https://www.codebuff.com");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeFreebuffConnectionConfig(value: unknown): FreebuffConnectionConfig {
  const record = asRecord(value);
  const rawListenPort = record.listenPort;
  const rawOverrideTier = record.overrideTier;

  return {
    listenPort:
      typeof rawListenPort === "number" && Number.isInteger(rawListenPort)
        ? rawListenPort
        : FREEBUFF_DEFAULT_LISTEN_PORT,
    overrideTier:
      typeof rawOverrideTier === "string" && rawOverrideTier.trim()
        ? rawOverrideTier.trim()
        : FREEBUFF_DEFAULT_OVERRIDE_TIER,
  };
}

export function getFreebuffUpstream(pathname: string): URL {
  return pathname.startsWith("/api/auth/cli/") ? FREEBUFF_AUTH_UPSTREAM : FREEBUFF_DEFAULT_UPSTREAM;
}

export function isAllowedFreebuffProxyHost(hostname: string): boolean {
  return FREEBUFF_ALLOWED_PROXY_HOSTS.has(hostname.toLowerCase());
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

function isBodylessMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function buildProxyInit(
  request: Request,
  upstream: URL
): Promise<RequestInit & { duplex?: "half" }> {
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  headers.set("host", upstream.host);

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
    signal: request.signal,
  };

  if (!isBodylessMethod(method)) {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return init;
}

export async function proxyFreebuffRequest(
  request: Request,
  fetchImpl: FreebuffFetch = fetch
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const upstream = getFreebuffUpstream(incomingUrl.pathname);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, upstream);
  const init = await buildProxyInit(request, upstream);

  try {
    const upstreamResponse = await fetchImpl(targetUrl, init);
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers,
    });
  } catch {
    return jsonResponse(
      {
        error: "Freebuff upstream unavailable",
        code: "FREEBUFF_UPSTREAM_UNAVAILABLE",
      },
      { status: 502 }
    );
  }
}

export async function handleFreebuffRequest(
  request: Request,
  config?: Partial<FreebuffConnectionConfig> | null,
  fetchImpl: FreebuffFetch = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();
  const normalizedConfig = normalizeFreebuffConnectionConfig(config);

  if (method === "GET" && pathname === "/api/v1/freebuff/session") {
    return jsonResponse({
      status: "active",
      accessTier: normalizedConfig.overrideTier,
      message: "Premium active",
      queueDepthByModel: {},
      countryCode: "US",
      countryBlockReason: null,
      ipPrivacySignals: null,
    });
  }

  if (method === "POST" && pathname === "/api/v1/ads") {
    return jsonResponse({ ads: [], provider: "zeroclick" });
  }

  if (
    pathname.includes("/api/v1/ads/impression") ||
    pathname.includes("/api/v2/impressions") ||
    pathname.includes("/batch/")
  ) {
    return jsonResponse({ success: true, creditsGranted: 0 });
  }

  return proxyFreebuffRequest(request, fetchImpl);
}
