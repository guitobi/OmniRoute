import {
  handleFreebuffRequest,
  isAllowedFreebuffProxyHost,
  type FreebuffConnectionConfig,
  type FreebuffFetch,
} from "./freebuff";
import { getConfiguredFreebuffConnectionConfig } from "./freebuffConnection";

export const FREEBUFF_INTERCEPT_SECRET_HEADER = "x-omniroute-freebuff-mitm-secret";
export const FREEBUFF_INTERCEPT_TARGET_HEADER = "x-omniroute-freebuff-target-url";

export interface FreebuffInterceptOptions {
  expectedSecret?: string;
  configResolver?: () => Promise<Partial<FreebuffConnectionConfig> | null | undefined>;
  fetchImpl?: FreebuffFetch;
}

function isBodylessMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function parseTargetUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (!isAllowedFreebuffProxyHost(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildFreebuffRequest(request: Request, targetUrl: URL): Request {
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  headers.delete(FREEBUFF_INTERCEPT_SECRET_HEADER);
  headers.delete(FREEBUFF_INTERCEPT_TARGET_HEADER);
  headers.set("host", targetUrl.host);

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: request.signal,
  };

  if (!isBodylessMethod(method)) {
    init.body = request.body;
    init.duplex = "half";
  }

  return new Request(targetUrl, init);
}

export async function handleFreebuffInterceptRequest(
  request: Request,
  options: FreebuffInterceptOptions = {}
): Promise<Response> {
  const expectedSecret = options.expectedSecret ?? process.env.OMNIROUTE_FREEBUFF_MITM_SECRET;
  const receivedSecret = request.headers.get(FREEBUFF_INTERCEPT_SECRET_HEADER);
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return jsonError("Forbidden", 403);
  }

  const targetUrl = parseTargetUrl(request.headers.get(FREEBUFF_INTERCEPT_TARGET_HEADER));
  if (!targetUrl) {
    return jsonError("Invalid Freebuff MITM target", 400);
  }

  const config = options.configResolver
    ? await options.configResolver()
    : await getConfiguredFreebuffConnectionConfig();
  const freebuffRequest = buildFreebuffRequest(request, targetUrl);
  return handleFreebuffRequest(freebuffRequest, config, options.fetchImpl);
}
