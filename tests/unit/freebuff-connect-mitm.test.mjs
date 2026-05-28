import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

import {
  FREEBUFF_CONNECT_HOSTS,
  FREEBUFF_INTERCEPT_PATH,
  FREEBUFF_INTERCEPT_SECRET_HEADER,
  FREEBUFF_INTERCEPT_TARGET_HEADER,
  attachFreebuffConnectMitm,
  isAllowedFreebuffConnectAuthority,
  parseConnectAuthority,
} from "../../scripts/dev/freebuff-connect-mitm.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(marker)) {
        socket.off("data", onData);
        socket.off("error", reject);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("Freebuff CONNECT helper only allows expected TLS authorities", () => {
  assert.ok(FREEBUFF_CONNECT_HOSTS.has("codebuff.com"));
  assert.ok(FREEBUFF_CONNECT_HOSTS.has("www.codebuff.com"));
  assert.ok(FREEBUFF_CONNECT_HOSTS.has("freebuff.com"));

  assert.deepEqual(parseConnectAuthority("codebuff.com:443"), {
    host: "codebuff.com",
    port: 443,
  });
  assert.equal(isAllowedFreebuffConnectAuthority("codebuff.com:443"), true);
  assert.equal(isAllowedFreebuffConnectAuthority("freebuff.com:443"), true);
  assert.equal(isAllowedFreebuffConnectAuthority("codebuff.com:80"), false);
  assert.equal(isAllowedFreebuffConnectAuthority("evil.example:443"), false);
});

test("Freebuff CONNECT MITM unwraps TLS and routes decrypted HTTP", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, FREEBUFF_INTERCEPT_PATH);
    assert.equal(req.headers[FREEBUFF_INTERCEPT_SECRET_HEADER], "secret");
    assert.equal(
      req.headers[FREEBUFF_INTERCEPT_TARGET_HEADER],
      "https://codebuff.com/api/v1/freebuff/session"
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "active", accessTier: "pro" }));
  });

  attachFreebuffConnectMitm(server, {
    secret: "secret",
  });

  const port = await listen(server);
  const socket = net.connect({ host: "127.0.0.1", port });

  try {
    await waitForConnect(socket);
    socket.write("CONNECT codebuff.com:443 HTTP/1.1\r\nHost: codebuff.com:443\r\n\r\n");
    const connectResponse = await readUntil(socket, "\r\n\r\n");
    assert.match(connectResponse, /200 Connection Established/);

    const tlsSocket = tls.connect({
      socket,
      servername: "codebuff.com",
      rejectUnauthorized: false,
    });
    await new Promise((resolve, reject) => {
      tlsSocket.once("secureConnect", resolve);
      tlsSocket.once("error", reject);
    });

    tlsSocket.write(
      "GET /api/v1/freebuff/session HTTP/1.1\r\nHost: codebuff.com\r\nConnection: close\r\n\r\n"
    );
    const response = await readUntil(tlsSocket, "\r\n0\r\n\r\n").catch(async () => {
      return await readUntil(tlsSocket, "}");
    });

    assert.match(response, /HTTP\/1\.1 200 OK/);
    assert.match(response, /"accessTier":"pro"/);
  } finally {
    socket.destroy();
    await close(server);
  }
});
