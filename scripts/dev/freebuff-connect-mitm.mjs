import http from "node:http";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import selfsigned from "selfsigned";

export const FREEBUFF_CONNECT_HOSTS = new Set(["codebuff.com", "www.codebuff.com", "freebuff.com"]);
export const FREEBUFF_INTERCEPT_PATH = "/api/freebuff/intercept";
export const FREEBUFF_INTERCEPT_SECRET_HEADER = "x-omniroute-freebuff-mitm-secret";
export const FREEBUFF_INTERCEPT_TARGET_HEADER = "x-omniroute-freebuff-target-url";

const ATTACHED_SYMBOL = Symbol.for("omniroute.freebuff.connectMitm.attached");

let secureContextPromise;

export function parseConnectAuthority(authority) {
  if (typeof authority !== "string" || authority.trim().length === 0) return null;
  const value = authority.trim().toLowerCase();
  const bracketMatch = value.match(/^\[([^\]]+)]:(\d+)$/);
  if (bracketMatch) {
    return { host: bracketMatch[1], port: Number.parseInt(bracketMatch[2], 10) };
  }

  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === value.length - 1) return null;

  const host = value.slice(0, lastColon);
  const port = Number.parseInt(value.slice(lastColon + 1), 10);
  if (!host || !Number.isInteger(port)) return null;
  return { host, port };
}

export function isAllowedFreebuffConnectAuthority(authority) {
  const parsed = parseConnectAuthority(authority);
  return !!parsed && parsed.port === 443 && FREEBUFF_CONNECT_HOSTS.has(parsed.host);
}

async function createFreebuffSecureContext() {
  if (!secureContextPromise) {
    secureContextPromise = (async () => {
      const pems = await selfsigned.generate(
        [
          { name: "commonName", value: "codebuff.com" },
          { name: "organizationName", value: "OmniRoute Local Freebuff MITM" },
        ],
        {
          algorithm: "sha256",
          days: 3650,
          keySize: 2048,
          extensions: [
            { name: "basicConstraints", cA: true },
            {
              name: "subjectAltName",
              altNames: [
                { type: 2, value: "codebuff.com" },
                { type: 2, value: "www.codebuff.com" },
                { type: 2, value: "freebuff.com" },
              ],
            },
          ],
        }
      );
      return tls.createSecureContext({ key: pems.private, cert: pems.cert });
    })();
  }
  return secureContextPromise;
}

function getServerPort(server, fallbackPort) {
  const address = server?.address?.();
  if (address && typeof address === "object" && typeof address.port === "number") {
    return address.port;
  }

  const rawPort = fallbackPort || process.env.DASHBOARD_PORT || process.env.PORT || "20128";
  const parsed = Number.parseInt(String(rawPort), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 20128;
}

function getMitmSecret(secret) {
  if (secret) return secret;
  process.env.OMNIROUTE_FREEBUFF_MITM_SECRET ||= randomUUID();
  return process.env.OMNIROUTE_FREEBUFF_MITM_SECRET;
}

function buildTargetUrl(reqUrl, targetHost) {
  const parsed = new URL(reqUrl || "/", `https://${targetHost}`);
  return `https://${targetHost}${parsed.pathname}${parsed.search}`;
}

export function bridgeFreebuffInterceptRequest(req, res, context) {
  const port = getServerPort(context.server, context.port);
  const targetUrl = buildTargetUrl(req.url, context.targetHost);
  const secret = getMitmSecret(context.secret);
  const headers = {
    ...req.headers,
    host: context.targetHost,
    [FREEBUFF_INTERCEPT_SECRET_HEADER]: secret,
    [FREEBUFF_INTERCEPT_TARGET_HEADER]: targetUrl,
  };

  const upstreamReq = http.request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: FREEBUFF_INTERCEPT_PATH,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: "Freebuff MITM bridge unavailable" }));
  });

  req.pipe(upstreamReq);
}

function createDecryptedHttpServer(context) {
  return http.createServer((req, res) => {
    const dispatch = context.dispatchInterceptRequest || bridgeFreebuffInterceptRequest;
    dispatch(req, res, context);
  });
}

function rejectConnect(socket, statusCode, reason) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`, () =>
    socket.destroy()
  );
}

export function attachFreebuffConnectMitm(server, options = {}) {
  if (!server || server[ATTACHED_SYMBOL]) return server;
  server[ATTACHED_SYMBOL] = true;

  server.on("connect", async (req, socket, head) => {
    const authority = req.url || "";
    if (!isAllowedFreebuffConnectAuthority(authority)) {
      rejectConnect(socket, 403, "Forbidden");
      return;
    }

    const parsed = parseConnectAuthority(authority);
    if (!parsed) {
      rejectConnect(socket, 400, "Bad Request");
      return;
    }

    try {
      const secureContext = await createFreebuffSecureContext();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) socket.unshift(head);

      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext,
      });
      const decryptedServer = createDecryptedHttpServer({
        ...options,
        server,
        targetHost: parsed.host,
        targetAuthority: authority,
      });

      tlsSocket.once("secure", () => {
        decryptedServer.emit("connection", tlsSocket);
      });
      tlsSocket.once("close", () => decryptedServer.close());
      tlsSocket.once("error", () => decryptedServer.close());
    } catch {
      rejectConnect(socket, 502, "Bad Gateway");
    }
  });

  return server;
}
