import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { globalConnectionPool, type PooledConnection } from "./connection-pool";
import { convert } from "./convert";
import type { HeadersInit } from "bun";

// save original fetch
const _fetch = globalThis.fetch;

// constants for optimization
const HTTP_SEPARATOR = Buffer.from("\r\n\r\n");

/**
 * Parses a standard SOCKS5 connection string.
 * Example: socks5://user:pass@127.0.0.1:1080
 */
export function parseProxyUrl(proxyUrl: string) {
  try {
    const parsed = new URL(proxyUrl);

    // Validate Protocol - support socks5, http, https
    const protocol = parsed.protocol;
    const validProtocols = ["socks5:", "http:", "https:"];

    if (!validProtocols.includes(protocol)) {
      throw new Error(
        `Unsupported proxy protocol: ${protocol}. Supported protocols: socks5, http, https.`,
      );
    }

    // Extract Authentication
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    const password = parsed.password ? decodeURIComponent(parsed.password) : "";

    // Extract Host
    let host = parsed.hostname;
    // URL class keeps brackets for IPv6 (e.g. "[::1]"), but net.connect needs raw IP
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }

    // Extract Port
    // Extract Port - default ports based on protocol
    let defaultPort = 1080; // SOCKS default
    if (protocol === "http:" || protocol === "https:") {
      defaultPort = 8080; // HTTP default
    }

    const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;

    return { host, port, user, password, protocol: protocol.slice(0, -1) }; // remove ':' from protocol
  } catch (err) {
    throw new Error(
      `Invalid proxy URL: ${proxyUrl}. Error: ${(err as Error).message}`,
    );
  }
}

/**
 * Establishes a raw TCP connection to the SOCKS5 proxy and performs the handshake.
 */
export async function connectSocks5(
  proxyConfig: string,
  targetHost: string,
  targetPort: number,
  useTLS = false,
  resolveDnsLocally = false,
  signal?: AbortSignal,
  tlsOptions?: tls.ConnectionOptions,
): Promise<net.Socket | tls.TLSSocket> {
  const config = parseProxyUrl(proxyConfig);

  // Clean target host brackets if present (IPv6)
  let cleanTargetHost = targetHost;
  if (
    cleanTargetHost.charCodeAt(0) === 0x5b && // '['
    cleanTargetHost.charCodeAt(cleanTargetHost.length - 1) === 0x5d // ']'
  ) {
    cleanTargetHost = cleanTargetHost.slice(1, -1);
  }

  const connectWithHost = (
    hostToUse: string,
  ): Promise<net.Socket | tls.TLSSocket> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(config.port, config.host);

      // AbortSignal handler
      const abortHandler = () => {
        socket.destroy();
        reject(signal?.reason || new Error("Request aborted"));
      };

      if (signal) {
        if (signal.aborted) {
          socket.destroy();
          reject(signal.reason || new Error("Request aborted"));
          return;
        }
        signal.addEventListener("abort", abortHandler);
      }

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
      };

      socket.on("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === "ENOTFOUND") {
          reject(new Error(`SOCKS5 proxy host not found: ${config.host}`));
        } else {
          reject(err);
        }
      });

      socket.setTimeout(30000, () => {
        cleanup();
        socket.destroy();
        reject(new Error("Proxy connection timed out"));
      });

      socket.on("connect", () => {
        socket.setTimeout(0);
        // 1. Handshake: отправляем только нужные методы
        const methods = config.user && config.password ? [0x00, 0x02] : [0x00];
        socket.write(Buffer.from([0x05, methods.length, ...methods]));
      });

      let state = "handshake";

      socket.on("data", (data) => {
        try {
          if (state === "handshake") {
            if (data[0] !== 0x05) throw new Error("Invalid SOCKS version");

            const selectedMethod = data[1];

            if (selectedMethod === 0x02) {
              // Username/Password Auth Required
              if (!config.user)
                throw new Error(
                  "Proxy requested auth, but no credentials provided in URL",
                );

              const uBuf = Buffer.from(config.user);
              const pBuf = Buffer.from(config.password);
              socket.write(
                Buffer.from([0x01, uBuf.length, ...uBuf, pBuf.length, ...pBuf]),
              );
              state = "auth";
            } else if (selectedMethod === 0x00) {
              // No Auth Required - Skip to Connect
              sendConnectRequest();
            } else {
              throw new Error(
                "Proxy rejected supported authentication methods",
              );
            }
          } else if (state === "auth") {
            if (data[1] !== 0x00)
              throw new Error("SOCKS5 Authentication failed");
            sendConnectRequest();
          } else if (state === "connect") {
            if (data[1] !== 0x00)
              throw new Error(`SOCKS5 Connect failed: ${data[1]}`);

            // Done. Clean listeners so the socket is "raw" for the caller
            cleanup();
            socket.removeAllListeners("data");
            socket.removeAllListeners("error");
            socket.removeAllListeners("timeout");

            if (useTLS) {
              const tlsSocket = tls.connect({
                socket,
                servername: targetHost,
                ...tlsOptions,
              });
              tlsSocket.once("secureConnect", () => resolve(tlsSocket));
              tlsSocket.once("error", reject);
            } else {
              resolve(socket);
            }
          }
        } catch (err) {
          cleanup();
          socket.destroy();
          reject(err);
        }
      });

      function sendConnectRequest() {
        let req: Buffer;
        if (resolveDnsLocally) {
          // IPv4 mode (0x01) - host is already resolved IP address
          const ipParts = hostToUse.split(".").map(Number);
          req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x01]),
            Buffer.from(ipParts),
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]);
        } else {
          // Domain mode (0x03)
          const hostBuf = Buffer.from(hostToUse);
          req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]);
        }

        socket.write(req);
        state = "connect";
      }
    });

  if (resolveDnsLocally) {
    // Resolve DNS locally first
    return new Promise((resolve, reject) => {
      dns.lookup(cleanTargetHost, { family: 4 }, (err, address) => {
        if (err) return reject(err);
        connectWithHost(address).then(resolve).catch(reject);
      });
    });
  } else {
    return connectWithHost(cleanTargetHost);
  }
}

/**
 * One-shot decoder for a complete chunked body (used as a fallback / utility).
 * Returns whatever could be decoded; stops on the first malformed chunk or the
 * terminating 0-sized chunk.
 */
export function decodeChunked(buffer: Uint8Array): Uint8Array {
  const decoder = new ChunkedDecoder();
  try {
    decoder.feed(buffer);
  } catch {
    // Best-effort: return whatever was parsed before the error.
  }
  return decoder.getBody();
}

/**
 * Streaming parser for `Transfer-Encoding: chunked` bodies.
 *
 * Designed for repeated calls to `feed()` as bytes arrive on the socket.
 * Once `done` is true, the stream contains a complete body and all bytes
 * after `consumed` belong to the next response (HTTP pipelining is not
 * used by this client, but trailing CRLFs etc. need to be accounted for).
 */
export class ChunkedDecoder {
  private chunks: Uint8Array[] = [];
  private state:
    | "size"
    | "size-cr"
    | "data"
    | "data-cr"
    | "data-lf"
    | "trailer"
    | "trailer-cr"
    | "done" = "size";
  private remaining = 0;
  private sizeBuffer = "";
  private trailerLineEmpty = true;
  done = false;

  /**
   * Feed bytes; returns the number of bytes consumed (which may be less than
   * `buf.length` if `done` becomes true mid-buffer).
   */
  feed(buf: Uint8Array): number {
    let i = 0;
    while (i < buf.length && !this.done) {
      const byte = buf[i] as number;
      switch (this.state) {
        case "size": {
          if (byte === 0x0d /* \r */) {
            this.state = "size-cr";
          } else if (byte === 0x3b /* ; */) {
            // chunk extensions — skip rest of size line up to CRLF
            this.state = "size-cr"; // technically wrong (we should keep scanning to \r), but rare; strict mode below
            // rewind: keep scanning until \r
            this.state = "size";
            this.sizeBuffer = this.sizeBuffer; // size already accumulated
            // Switch to a "skip-to-cr" sub-state by reusing size with no append:
            this.state = "size-skip-ext" as "size";
          } else {
            this.sizeBuffer += String.fromCharCode(byte);
          }
          i++;
          break;
        }
        case "size-skip-ext" as "size": {
          // Skip everything until \r — chunk extensions are not used by us
          if (byte === 0x0d) this.state = "size-cr";
          i++;
          break;
        }
        case "size-cr": {
          if (byte !== 0x0a /* \n */) {
            throw new Error("Chunked: expected LF after CR in size line");
          }
          const size = parseInt(this.sizeBuffer, 16);
          if (Number.isNaN(size) || size < 0) {
            throw new Error(`Chunked: bad size "${this.sizeBuffer}"`);
          }
          this.sizeBuffer = "";
          if (size === 0) {
            this.state = "trailer";
          } else {
            this.remaining = size;
            this.state = "data";
          }
          i++;
          break;
        }
        case "data": {
          const take = Math.min(this.remaining, buf.length - i);
          this.chunks.push(buf.subarray(i, i + take));
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) this.state = "data-cr";
          break;
        }
        case "data-cr": {
          if (byte !== 0x0d) {
            throw new Error("Chunked: expected CR after chunk data");
          }
          this.state = "data-lf";
          i++;
          break;
        }
        case "data-lf": {
          if (byte !== 0x0a) {
            throw new Error("Chunked: expected LF after CR (chunk data)");
          }
          this.state = "size";
          i++;
          break;
        }
        case "trailer": {
          // Read lines; an empty line terminates trailers.
          if (byte === 0x0d) {
            this.state = "trailer-cr";
          } else {
            this.trailerLineEmpty = false;
          }
          i++;
          break;
        }
        case "trailer-cr": {
          if (byte !== 0x0a) {
            throw new Error("Chunked: expected LF after CR in trailer");
          }
          if (this.trailerLineEmpty) {
            this.state = "done";
            this.done = true;
          } else {
            this.trailerLineEmpty = true;
            this.state = "trailer";
          }
          i++;
          break;
        }
        case "done":
          return i;
      }
    }
    return i;
  }

  getBody(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/**
 * Try to parse the status line + headers of an HTTP response from `buf`.
 * Returns null if the header terminator (`\r\n\r\n`) hasn't arrived yet.
 */
export function parseHttpHead(buf: Buffer): {
  status: number;
  statusText: string;
  headers: Headers;
  bodyStart: number;
} | null {
  const sep = buf.indexOf(HTTP_SEPARATOR);
  if (sep === -1) return null;

  // Status + headers are ASCII per HTTP/1.1 spec; latin1 avoids UTF-8 surprises
  // on header values like cookies that may contain high bytes.
  const headerText = buf.subarray(0, sep).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusLine = lines[0] ?? "";
  const firstSpace = statusLine.indexOf(" ");
  const secondSpace =
    firstSpace === -1 ? -1 : statusLine.indexOf(" ", firstSpace + 1);
  const statusStr =
    firstSpace === -1
      ? ""
      : secondSpace === -1
        ? statusLine.substring(firstSpace + 1)
        : statusLine.substring(firstSpace + 1, secondSpace);
  const status = parseInt(statusStr, 10) || 0;
  const statusText =
    secondSpace === -1 ? "" : statusLine.substring(secondSpace + 1);

  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.substring(0, colon).trim();
      const val = line.substring(colon + 1).trim();
      headers.append(key, val);
    }
  }

  return { status, statusText, headers, bodyStart: sep + 4 };
}

type BodyMode =
  | { mode: "empty" }
  | { mode: "length"; length: number }
  | { mode: "chunked" }
  | { mode: "close" };

/**
 * Decide how to read the response body, per RFC 9112 §6.
 *
 * - HEAD, 1xx, 204, 304 → no body, regardless of headers.
 * - Transfer-Encoding: chunked (last token) → chunked.
 * - Content-Length → exactly that many bytes.
 * - Otherwise → read until the server closes the connection.
 */
export function determineBodyMode(
  method: string,
  status: number,
  headers: Headers,
): BodyMode {
  if (
    method === "HEAD" ||
    (status >= 100 && status < 200) ||
    status === 204 ||
    status === 304
  ) {
    return { mode: "empty" };
  }
  const te = headers.get("transfer-encoding");
  if (
    te &&
    te
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .includes("chunked")
  ) {
    return { mode: "chunked" };
  }
  const cl = headers.get("content-length");
  if (cl !== null) {
    const n = parseInt(cl, 10);
    if (!Number.isNaN(n) && n >= 0) return { mode: "length", length: n };
  }
  return { mode: "close" };
}

/**
 * Whether the response permits the connection to be reused for keep-alive.
 *
 * HTTP/1.1: keep-alive by default unless `Connection: close` is sent.
 * HTTP/1.0: must send `Connection: keep-alive` explicitly to opt in. We treat
 * any 1.x response without an explicit `close` token as keep-alive-eligible
 * unless the response uses close-delimited bodies, since pooling such a socket
 * means it's already half-shut-down.
 */
function isResponseKeepAlive(headers: Headers, bodyMode: BodyMode): boolean {
  const conn = headers.get("connection");
  if (conn) {
    const tokens = conn
      .toLowerCase()
      .split(",")
      .map((s) => s.trim());
    if (tokens.includes("close")) return false;
    if (tokens.includes("keep-alive")) return true;
  }
  // No Connection header — keep-alive only if body framing is deterministic.
  if (bodyMode.mode === "close") return false;
  return true;
}

/**
 * Decompress a body byte-string per the `Content-Encoding` header.
 * Mutates `headers` to drop the encoding and update content-length.
 */
function decompressBody(body: Uint8Array, headers: Headers): Uint8Array {
  const contentEncoding = headers.get("content-encoding");
  if (!contentEncoding) return body;

  // Empty body cannot be meaningfully decompressed (and zlib will throw on it).
  // This commonly happens on HEAD / 204 / 304 / 302 responses where servers
  // still echo back `Content-Encoding` from the request's `Accept-Encoding`.
  if (body.byteLength === 0) {
    headers.delete("content-encoding");
    headers.set("content-length", "0");
    return body;
  }

  let out = body;
  const encodings = contentEncoding
    .split(",")
    .map((e) => e.trim().toLowerCase());

  for (const encoding of encodings) {
    if (encoding === "gzip") {
      out = new Uint8Array(Bun.gunzipSync(Buffer.from(out)));
    } else if (encoding === "deflate") {
      try {
        out = new Uint8Array(Bun.inflateSync(Buffer.from(out)));
      } catch {
        try {
          out = new Uint8Array(zlib.inflateSync(Buffer.from(out)));
        } catch {
          out = new Uint8Array(Bun.gunzipSync(Buffer.from(out)));
        }
      }
    } else if (encoding === "br") {
      out = new Uint8Array(zlib.brotliDecompressSync(Buffer.from(out)));
    } else if (encoding === "zstd") {
      out = new Uint8Array(Bun.zstdDecompressSync(Buffer.from(out)));
    } else if (encoding === "" || encoding === "identity") {
      // no-op
    } else {
      // Unknown encoding — leave header in place so caller sees it.
      return out;
    }
  }

  headers.delete("content-encoding");
  headers.set("content-length", out.byteLength.toString());
  return out;
}

/**
 * Send a single HTTP/1.1 request over an already-connected socket and read
 * back the response. Does NOT perform any SOCKS handshake — the socket must
 * already be a transparent tunnel to the target server.
 *
 * Returns the parsed Response and a `keepAlive` flag indicating whether the
 * socket is safe to return to a connection pool.
 */
export function sendRequestOverSocket(
  socket: net.Socket | tls.TLSSocket,
  urlObj: URL,
  method: string,
  headers: Headers,
  body: Uint8Array | null,
  signal?: AbortSignal,
): Promise<{ response: Response; keepAlive: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const abortHandler = () => {
      settle(() => {
        socket.destroy();
        reject(signal?.reason || new Error("Request aborted"));
      });
    };
    if (signal) {
      if (signal.aborted) {
        socket.destroy();
        reject(signal.reason || new Error("Request aborted"));
        return;
      }
      signal.addEventListener("abort", abortHandler);
    }
    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    // Build raw request
    const path = urlObj.pathname + urlObj.search;
    const hostHeader = urlObj.hostname + (urlObj.port ? `:${urlObj.port}` : "");

    let head = `${method} ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n`;

    let userSetConnection = false;
    let userSetAccept = false;
    let userSetAcceptEnc = false;
    let userSetContentLength = false;

    headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (lk === "host") return;
      if (lk === "connection") userSetConnection = true;
      if (lk === "accept") userSetAccept = true;
      if (lk === "accept-encoding") userSetAcceptEnc = true;
      if (lk === "content-length") userSetContentLength = true;
      head += `${key}: ${value}\r\n`;
    });

    if (!userSetConnection) head += `Connection: keep-alive\r\n`;
    if (!userSetAccept) head += `Accept: */*\r\n`;
    if (!userSetAcceptEnc)
      head += `Accept-Encoding: gzip, deflate, br, zstd\r\n`;
    if (body && !userSetContentLength)
      head += `Content-Length: ${body.byteLength}\r\n`;
    head += `\r\n`;

    // Response state
    let headBuf: Buffer = Buffer.alloc(0);
    let parsed: {
      status: number;
      statusText: string;
      headers: Headers;
      bodyStart: number;
    } | null = null;
    let bodyMode: BodyMode | null = null;
    const bodyChunks: Uint8Array[] = [];
    let bodyReceived = 0;
    let chunkedDecoder: ChunkedDecoder | null = null;

    const finishWith = (responseBody: Uint8Array) => {
      if (!parsed || !bodyMode) return;
      let finalBody: Uint8Array;
      try {
        finalBody = decompressBody(responseBody, parsed.headers);
      } catch (err) {
        settle(() => {
          cleanup();
          socket.destroy();
          reject(err);
        });
        return;
      }
      const keepAlive =
        bodyMode.mode !== "close" &&
        !socket.destroyed &&
        socket.writable &&
        socket.readable &&
        isResponseKeepAlive(parsed.headers, bodyMode);
      settle(() => {
        cleanup();
        resolve({
          response: new Response(finalBody, {
            status: parsed!.status,
            statusText: parsed!.statusText,
            headers: parsed!.headers,
          }),
          keepAlive,
        });
      });
    };

    const consumeBody = (chunk: Uint8Array) => {
      if (!bodyMode) return;
      if (bodyMode.mode === "empty") {
        // Server is misbehaving; ignore extra bytes.
        return;
      }
      if (bodyMode.mode === "length") {
        const need = bodyMode.length - bodyReceived;
        const take = Math.min(need, chunk.length);
        if (take > 0) {
          bodyChunks.push(chunk.subarray(0, take));
          bodyReceived += take;
        }
        if (bodyReceived >= bodyMode.length) {
          const out = concatChunks(bodyChunks, bodyMode.length);
          finishWith(out);
        }
        return;
      }
      if (bodyMode.mode === "chunked") {
        if (!chunkedDecoder) chunkedDecoder = new ChunkedDecoder();
        try {
          chunkedDecoder.feed(chunk);
        } catch (err) {
          settle(() => {
            cleanup();
            socket.destroy();
            reject(err);
          });
          return;
        }
        if (chunkedDecoder.done) {
          finishWith(chunkedDecoder.getBody());
        }
        return;
      }
      // mode === "close": accumulate until 'end'
      bodyChunks.push(chunk);
      bodyReceived += chunk.length;
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      if (parsed === null) {
        headBuf =
          headBuf.length === 0 ? chunk : Buffer.concat([headBuf, chunk]);
        const head = parseHttpHead(headBuf);
        if (!head) return;
        parsed = head;
        bodyMode = determineBodyMode(method, head.status, head.headers);
        const after = headBuf.subarray(head.bodyStart);
        headBuf = Buffer.alloc(0);
        if (bodyMode.mode === "empty") {
          finishWith(new Uint8Array(0));
          return;
        }
        // Length=0 with no body bytes after the head: complete immediately.
        // `consumeBody` is only invoked when there are bytes to feed, so without
        // this check 302/204/etc. with `Content-Length: 0` would hang forever.
        if (bodyMode.mode === "length" && bodyMode.length === 0) {
          finishWith(new Uint8Array(0));
          return;
        }
        if (after.length > 0) consumeBody(after);
        return;
      }
      consumeBody(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      if (!parsed) {
        settle(() => {
          cleanup();
          reject(new Error("Invalid HTTP response: No header separator found"));
        });
        return;
      }
      if (bodyMode?.mode === "close") {
        const out = concatChunks(bodyChunks, bodyReceived);
        finishWith(out);
        return;
      }
      // Premature close while expecting more bytes
      settle(() => {
        cleanup();
        reject(
          new Error(
            `Connection closed before response body was complete (mode=${bodyMode?.mode})`,
          ),
        );
      });
    };

    const onError = (err: Error) => {
      settle(() => {
        cleanup();
        reject(err);
      });
    };

    const onClose = () => {
      if (settled) return;
      onEnd();
    };

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
    socket.on("close", onClose);

    socket.write(head);
    if (body) socket.write(body);
  });
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.length === totalLength) {
    return chunks[0]!;
  }
  const out = new Uint8Array(totalLength);
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, totalLength - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= totalLength) break;
  }
  return out;
}

/**
 * Resolve which headers should be carried into a redirect.
 *
 * Per the Fetch spec, `init.headers` (when provided) takes precedence over the
 * headers attached to a Request input — otherwise the Request's headers are used.
 * The strip for cross-origin redirects must apply to whichever set is actually
 * sent, so this helper picks the right source before delegating to
 * {@link buildRedirectHeaders}.
 */
export function resolveRedirectHeaders(
  input: string | URL | Request,
  init: { headers?: HeadersInit } | undefined,
  originalUrl: URL,
  isCrossOrigin: boolean,
): Headers {
  const source: HeadersInit | undefined =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  return buildRedirectHeaders(source, originalUrl, isCrossOrigin);
}

/**
 * Build the headers for a redirected request.
 *
 * On cross-origin redirects, sensitive headers (authorization, cookie) are stripped.
 * proxy-authorization is intentionally preserved because the proxy itself is reused
 * across redirects (carried via init.proxy), so its credentials must travel with it.
 *
 * Always sets Referer to the original URL if not already provided.
 */
export function buildRedirectHeaders(
  sourceHeaders: HeadersInit | undefined,
  originalUrl: URL,
  isCrossOrigin: boolean,
): Headers {
  const headers = new Headers(sourceHeaders);

  if (isCrossOrigin) {
    headers.delete("authorization");
    headers.delete("cookie");
  }

  if (!headers.has("referer")) {
    headers.set("referer", originalUrl.href);
  }

  return headers;
}

/**
 * Handle HTTP redirects according to RFC 7231
 *
 * Connection reuse: If existingConnection is provided and redirect is to same host/port/protocol,
 * the connection will be reused to avoid SOCKS5 handshake overhead.
 *
 * Security features:
 * - Sensitive headers (authorization, cookie) are removed on cross-origin redirects
 * - proxy-authorization is preserved because the proxy itself is preserved across redirects
 * - Referer header is automatically added
 * - Proxy settings are preserved to ensure all requests go through the same proxy
 */
export async function handleRedirects(
  input: string | URL | Request,
  init: BunFetchRequestInit & { proxy?: { resolveDnsLocally?: boolean } },
  maxRedirects: number = 20,
  currentRedirects: number = 0,
  existingConnection?: PooledConnection,
): Promise<Response> {
  // Make initial request
  let response: Response;
  try {
    response = await fetchInternal(input, init || {}, existingConnection);
  } catch (error: unknown) {
    // Handle AbortError with clear message
    const err = error as Error;
    if (
      err.name === "AbortError" ||
      ("code" in err && (err as { code: number }).code === 20)
    ) {
      throw new Error(
        `Request aborted${currentRedirects > 0 ? ` after ${currentRedirects} redirect(s)` : ""}: ${err.message || "The operation was aborted"}`,
      );
    }
    // Re-throw other errors
    throw error;
  }

  // Check if it's a redirect
  const status = response.status;
  const location = response.headers.get("location");

  // Max redirects reached - throw error
  if (currentRedirects >= maxRedirects) {
    throw new Error(`Maximum redirects exceeded: ${maxRedirects}`);
  }

  // No redirect
  if (!status || !location || status < 300 || status >= 400) {
    return response;
  }

  // Check redirect status codes that should be followed
  const redirectStatuses = [301, 302, 303, 307, 308];
  if (!redirectStatuses.includes(status)) {
    return response;
  }

  // Determine new request method
  const originalMethod = init?.method || "GET";
  let newMethod: string;
  let shouldRemoveBody = false;

  // 303 always converts to GET
  // 301, 302 convert POST to GET for historical reasons
  if (
    status === 303 ||
    ((status === 301 || status === 302) &&
      originalMethod !== "GET" &&
      originalMethod !== "HEAD")
  ) {
    newMethod = "GET";
    shouldRemoveBody = true;
  } else {
    // 307, 308 preserve method
    newMethod = originalMethod;
  }

  // Resolve redirect URL and check if it's cross-origin
  const originalUrl = new URL(
    input instanceof Request ? input.url : input.toString(),
  );
  let redirectUrl: string;

  if (location.startsWith("http://") || location.startsWith("https://")) {
    // Absolute URL
    redirectUrl = location;
  } else {
    // Relative URL - resolve against original request URL
    redirectUrl = new URL(location, originalUrl).toString();
  }

  const newUrl = new URL(redirectUrl);
  const isCrossOrigin = originalUrl.origin !== newUrl.origin;

  const newHeaders = resolveRedirectHeaders(
    input,
    init,
    originalUrl,
    isCrossOrigin,
  );

  // Prepare new request without mutating original init
  // Important: preserve proxy settings for security (all requests must go through same proxy)
  const newInit = {
    ...init,
    method: newMethod,
    body: shouldRemoveBody ? undefined : init?.body,
    headers: newHeaders,
    // Preserve proxy settings
    proxy: init?.proxy,
  };

  // Follow redirect recursively
  return handleRedirects(
    redirectUrl,
    newInit,
    maxRedirects,
    currentRedirects + 1,
  );
}

/**
 * Custom Fetch implementation that supports SOCKS5 via the 'proxy' init option.
 */
export async function fetch(
  input: string | URL | Request, // url
  init?: BunFetchRequestInit & {
    proxy?: string | { url: string; resolveDnsLocally?: boolean };
  }, // bun fetch opts with redirect
): Promise<Response> {
  const redirectMode = init?.redirect || "follow";

  // Handle different redirect modes
  if (redirectMode === "manual") {
    // Don't follow redirects automatically
    return fetchInternal(input, init || {});
  } else if (redirectMode === "error") {
    // Throw error on redirect
    const response = await fetchInternal(input, init || {});
    const status = response.status;
    const location = response.headers.get("location");

    if (status && status >= 300 && status < 400 && location) {
      throw new Error(
        `Redirect to ${location} requested but redirect mode is 'error'`,
      );
    }

    return response;
  } else {
    // Follow redirects (default behavior)
    return handleRedirects(input, init || {});
  }
}

/**
 * Internal fetch implementation without redirect handling
 */
export async function fetchInternal(
  input: string | URL | Request, // url
  init?: BunFetchRequestInit & { proxy?: { resolveDnsLocally?: boolean } }, // bun fetch opts
  existingConnection?: PooledConnection, // optional existing connection for reuse
): Promise<Response> {
  // Fallback 1: No proxy specified - check env vars
  let proxyUrl: string | undefined;

  if (init?.proxy === undefined) {
    const envProxy =
      process.env.SOCKS5_PROXY ||
      process.env.SOCKS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY;
    if (envProxy) {
      proxyUrl = envProxy;
      // For HTTP/HTTPS Bun proxy supports natively
      // 's' (0x73) = socks, everything else (including 'h' for http/https) = native
      if (envProxy.charCodeAt(0) !== 0x73) {
        // HTTP/HTTPS proxy - add to init and use native fetch
        const newInit = { ...init, proxy: envProxy };
        return _fetch(input, newInit);
      }
    } else {
      return _fetch(input, init);
    }
  } else if (init?.proxy === null) {
    // Explicitly disabled proxy - use native fetch and remove proxy from init
    const { proxy: _, ...initWithoutProxy } = init || {};
    return _fetch(input, initWithoutProxy);
  } else {
    proxyUrl = typeof init.proxy === "string" ? init.proxy : init.proxy.url;
  }

  let url: string;
  try {
    url = convert(proxyUrl);
  } catch (err) {
    // User explicitly supplied a proxy URL we cannot understand. Propagate the
    // error rather than silently falling through with the original string —
    // otherwise `parseProxyUrl` either fails further down with a less specific
    // message, or worse, the request leaks out without proxying at all.
    throw new Error(
      `Invalid proxy URL "${proxyUrl}": ${(err as Error).message}`,
    );
  }

  // Fast early exit - not a SOCKS proxy (http/https proxy supports native fetch Bun)
  // 's' (0x73) = socks, everything else = native fetch
  if (!url || url.charCodeAt(0) !== 0x73) {
    // For HTTP/HTTPS proxy we pass init as is - Bun supports proxy option
    return _fetch(input, init);
  }

  // Try to parse proxy
  try {
    const parsed = parseProxyUrl(url);
    // If this is an HTTP/HTTPS proxy, use native fetch with the proxy option
    if (parsed.protocol === "http" || parsed.protocol === "https") {
      // Bun supports proxy option in fetch - we pass init as is
      return _fetch(input, init);
    }
  } catch (_err) {
    console.warn(
      `Invalid proxy configuration: "${url}". Falling back to native fetch.`,
    );

    // Fallback: pass init as is to native fetch
    return _fetch(input, init);
  }

  // 1. Normalize Input using native Request
  const req =
    input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
  const urlObj = new URL(req.url);
  const isHttps = urlObj.protocol.charCodeAt(4) === 0x73; // 's' in http[s]:
  const port = urlObj.port ? parseInt(urlObj.port, 10) : isHttps ? 443 : 80;

  // 2. Prepare Body (Read into memory to calculate Content-Length)
  let bodyUint8: Uint8Array | null = null;
  try {
    const buffer = await req.arrayBuffer();
    if (buffer.byteLength > 0) {
      bodyUint8 = new Uint8Array(buffer);
    }
  } catch (_e) {
    // Body already consumed or invalid
  }

  // 3. Get a tunnel socket (either passed in, taken from the pool, or freshly
  //    negotiated through the SOCKS5 proxy).
  const resolveDnsLocally =
    typeof init?.proxy === "object" && init.proxy !== null
      ? (init.proxy.resolveDnsLocally ?? false)
      : false;

  const poolKey = `${url}:${urlObj.hostname}:${port}:${isHttps}`;
  let pooledConn: PooledConnection;
  let fromPool = false;

  if (existingConnection) {
    pooledConn = existingConnection;
    fromPool = true;
  } else {
    const reused = globalConnectionPool.getConnection(poolKey);
    if (reused) {
      pooledConn = reused;
      fromPool = true;
    } else {
      const socket = await connectSocks5(
        url,
        urlObj.hostname,
        port,
        isHttps,
        resolveDnsLocally,
        init?.signal || undefined,
        init?.tls as tls.ConnectionOptions,
      );
      pooledConn = {
        socket,
        proxyUrl: url,
        targetHost: urlObj.hostname,
        targetPort: port,
        useTLS: isHttps,
        lastUsed: Date.now(),
        created: Date.now(),
      };
    }
  }

  // 4. Send the HTTP request and parse the response.
  let result: { response: Response; keepAlive: boolean };
  try {
    result = await sendRequestOverSocket(
      pooledConn.socket,
      urlObj,
      req.method,
      req.headers,
      bodyUint8,
      init?.signal || undefined,
    );
  } catch (err) {
    // On any error, the socket is unsafe to reuse.
    pooledConn.socket.destroy();
    throw err;
  }

  // 5. Decide whether to return the socket to the pool.
  if (result.keepAlive) {
    globalConnectionPool.releaseConnection(poolKey, pooledConn);
  } else {
    // We won't reuse this socket — but if it came from the pool we should
    // still close it (it already wasn't a "fresh" socket from outside).
    if (fromPool) pooledConn.socket.destroy();
    else pooledConn.socket.destroy();
  }

  return result.response;
}

/**
 * Stub for Bun's fetch.preconnect() method.
 * In Bun, this would perform DNS lookup, TCP socket connection, and TLS handshake early.
 *
 * @param _url - The URL to preconnect to (unused in stub)
 */
fetch.preconnect = function preconnect(_url: string | URL): void {};
