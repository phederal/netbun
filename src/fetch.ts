import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";

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

		// Validate Protocol - support socks5, socks4, http, https
		const protocol = parsed.protocol;
		const validProtocols = ["socks5:", "socks4:", "http:", "https:"];

		if (!validProtocols.includes(protocol)) {
			throw new Error(
				`Unsupported proxy protocol: ${protocol}. Supported protocols: socks5, socks4, http, https.`,
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

			socket.setTimeout(10000, () => {
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

export function decodeChunked(buffer: Uint8Array): Uint8Array {
	const chunks: Uint8Array[] = [];
	let index = 0;

	while (index < buffer.length) {
		// Find \r\n sequence
		let lineEnd = index;
		while (lineEnd < buffer.length && buffer[lineEnd] !== 0x0d) {
			// \r
			lineEnd++;
		}
		if (lineEnd >= buffer.length || buffer[lineEnd + 1] !== 0x0a) {
			// \n
			break;
		}

		const decoder = new TextDecoder();
		const sizeStr = decoder.decode(buffer.subarray(index, lineEnd));
		const size = parseInt(sizeStr, 16);

		if (Number.isNaN(size)) {
			index = lineEnd + 2;
			continue;
		}
		if (size === 0) break;

		const dataStart = lineEnd + 2;
		const dataEnd = dataStart + size;

		if (dataEnd > buffer.length) break;

		chunks.push(buffer.subarray(dataStart, dataEnd));
		index = dataEnd + 2;
	}

	// Concatenate all chunks efficiently
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result;
}

/**
 * Handle HTTP redirects according to RFC 7231
 *
 * IMPORTANT: When using SOCKS proxy, each redirect creates a new connection to the proxy
 * and performs a full SOCKS5 handshake (including auth if configured). This means:
 * - Each redirect adds ~1-3 seconds of latency (TCP connect + SOCKS handshake + TLS handshake)
 * - Multiple redirects (5+) can be slow and may timeout
 * - The proxy settings are preserved across all redirects for security
 *
 * Security features:
 * - Sensitive headers (authorization, cookie, proxy-authorization) are removed on cross-origin redirects
 * - Referer header is automatically added
 * - Proxy settings are preserved to ensure all requests go through the same proxy
 */
export async function handleRedirects(
	input: string | URL | Request,
	init: BunFetchRequestInit & { proxy?: { resolveDnsLocally?: boolean } },
	maxRedirects: number = 20,
	currentRedirects: number = 0,
): Promise<Response> {
	// Make initial request
	let response: Response;
	try {
		response = await fetchInternal(input, init || {});
	} catch (error: any) {
		// Handle AbortError with clear message
		if (error.name === 'AbortError' || error.code === 20) {
			throw new Error(`Request aborted${currentRedirects > 0 ? ` after ${currentRedirects} redirect(s)` : ''}: ${error.message || 'The operation was aborted'}`);
		}
		// Re-throw other errors
		throw error;
	}

	// Check if it's a redirect
	const status = response.status;
	const location = response.headers.get('location');

	// No redirect or max redirects reached
	if (!status || !location || status < 300 || status >= 400 || currentRedirects >= maxRedirects) {
		return response;
	}

	// Check redirect status codes that should be followed
	const redirectStatuses = [301, 302, 303, 307, 308];
	if (!redirectStatuses.includes(status)) {
		return response;
	}

	// Determine new request method
	const originalMethod = init?.method || 'GET';
	let newMethod: string;
	let shouldRemoveBody = false;

	// 303 always converts to GET
	// 301, 302 convert POST to GET for historical reasons
	if (status === 303 || ((status === 301 || status === 302) && originalMethod !== 'GET' && originalMethod !== 'HEAD')) {
		newMethod = 'GET';
		shouldRemoveBody = true;
	} else {
		// 307, 308 preserve method
		newMethod = originalMethod;
	}

	// Resolve redirect URL and check if it's cross-origin
	const originalUrl = new URL(input instanceof Request ? input.url : input.toString());
	let redirectUrl: string;

	if (location.startsWith('http://') || location.startsWith('https://')) {
		// Absolute URL
		redirectUrl = location;
	} else {
		// Relative URL - resolve against original request URL
		redirectUrl = new URL(location, originalUrl).toString();
	}

	const newUrl = new URL(redirectUrl);
	const isCrossOrigin = originalUrl.origin !== newUrl.origin;

	// Copy headers and handle sensitive headers for cross-origin redirects
	const newHeaders = new Headers(init?.headers);

	// Remove sensitive headers on cross-origin redirects for security
	if (isCrossOrigin) {
		newHeaders.delete('authorization');
		newHeaders.delete('cookie');
		newHeaders.delete('proxy-authorization');
	}

	// Set Referer header if not already set
	if (!newHeaders.has('referer')) {
		newHeaders.set('referer', originalUrl.href);
	}

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
	return handleRedirects(redirectUrl, newInit, maxRedirects, currentRedirects + 1);
}


/**
 * Custom Fetch implementation that supports SOCKS5 via the 'proxy' init option.
 */
export async function fetch(
	input: string | URL | Request, // url
	init?: any, // bun fetch opts with redirect
): Promise<Response> {
	const redirectMode = init?.redirect || 'follow';
	
	// Handle different redirect modes
	if (redirectMode === 'manual') {
		// Don't follow redirects automatically
		return fetchInternal(input, init || {});
	} else if (redirectMode === 'error') {
		// Throw error on redirect
		const response = await fetchInternal(input, init || {});
		const status = response.status;
		const location = response.headers.get('location');
		
		if (status && status >= 300 && status < 400 && location) {
			throw new Error(`Redirect to ${location} requested but redirect mode is 'error'`);
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
): Promise<Response> {
	// Fallback 1: No proxy specified - check env vars
	let proxyUrl: string | undefined;

	if (!init?.proxy) {
		const envProxy =
			process.env.SOCKS5_PROXY ||
			process.env.SOCKS_PROXY ||
			process.env.HTTP_PROXY ||
			process.env.HTTPS_PROXY;
		if (envProxy) {
			proxyUrl = envProxy;
			// Для HTTP/HTTPS прокси сразу делаем fallback
			if (
				envProxy &&
				envProxy.charCodeAt(0) !== 0x73 &&
				envProxy.charCodeAt(0) !== 0x68
			) {
				return _fetch(input, init);
			}
		} else {
			return _fetch(input, init);
		}
	} else {
		proxyUrl = typeof init.proxy === "string" ? init.proxy : init.proxy.url;
	}

	const url = proxyUrl;

	// Быстрый early exit - не SOCKS прокси (http/https прокси поддерживает нативный fetch)
	if (!url || (url.charCodeAt(0) !== 0x73 && url.charCodeAt(0) !== 0x68)) {
		// Убираем proxy из init для нативного fetch
		const { proxy: _, ...nativeInit } = init || {};
		return _fetch(input, nativeInit);
	}

	// Fallback 2: Invalid proxy configuration string
	try {
		const parsed = parseProxyUrl(url);
		// Если это HTTP/HTTPS прокси, используем нативный fetch без proxy опции
		if (parsed.protocol === "http" || parsed.protocol === "https") {
			const { proxy: _, ...nativeInit } = init || {};
			return _fetch(input, nativeInit);
		}
	} catch (_err) {
		console.warn(
			`Invalid proxy configuration: "${url}". Falling back to native fetch.`,
		);

		// Fixed: Strip the 'proxy' property so native fetch doesn't error on the unsupported protocol
		const { proxy: _, ...nativeInit } = init || {};
		return _fetch(input, nativeInit);
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

	// 3. Get SOCKS socket with optional TLS
	const resolveDnsLocally = init?.proxy?.resolveDnsLocally ?? false;
	const socket = await connectSocks5(
		url,
		urlObj.hostname,
		port,
		isHttps,
		resolveDnsLocally,
		init?.signal || undefined,
		init?.tls as tls.ConnectionOptions,
	);

	return new Promise((resolve, reject) => {
		// AbortSignal handler for response phase
		const abortHandler = () => {
			socket.destroy();
			reject(init?.signal?.reason || new Error("Request aborted"));
		};

		if (init?.signal) {
			if (init.signal.aborted) {
				socket.destroy();
				reject(init.signal.reason || new Error("Request aborted"));
				return;
			}
			init.signal.addEventListener("abort", abortHandler);
		}

		const cleanup = () => {
			if (init?.signal) {
				init.signal.removeEventListener("abort", abortHandler);
			}
		};
		// 5. Construct Raw HTTP Request
		const path = urlObj.pathname + urlObj.search;
		const hostHeader = urlObj.hostname + (urlObj.port ? `:${urlObj.port}` : "");

		let headerString = `${req.method} ${path} HTTP/1.1\r\n`;
		headerString += `Host: ${hostHeader}\r\n`;
		headerString += `Connection: close\r\n`;

		// Set default User-Agent if not provided // disabled
		// if (!req.headers.has("user-agent")) {
		// 	headerString += `User-Agent: Bun/1.3.5\r\n`;
		// }

		// Set default Accept headers if not provided
		if (!req.headers.has("accept")) {
			headerString += `Accept: */*\r\n`;
		}

		if (!req.headers.has("accept-encoding")) {
			headerString += `Accept-Encoding: gzip, deflate, br, zstd\r\n`;
		}

		// Add Content-Length if body exists and header is missing
		if (bodyUint8 && !req.headers.has("content-length")) {
			req.headers.set("Content-Length", bodyUint8.byteLength.toString());
		}

		// Add all user-provided headers, excluding system-managed ones
		req.headers.forEach((value, key) => {
			const lowerKey = key.toLowerCase();
			// Exclude host and connection (handled separately), but allow user-set user-agent, accept, etc.
			if (lowerKey !== "host" && lowerKey !== "connection") {
				headerString += `${key}: ${value}\r\n`;
			}
		});

		headerString += `\r\n`;

		// 6. Send Headers & Body
		socket.write(headerString);
		if (bodyUint8) {
			socket.write(bodyUint8);
		}

		// 7. Read Raw Response
		const chunks: Buffer[] = [];
		socket.on("data", (chunk) => chunks.push(chunk));

		socket.on("end", () => {
			cleanup();
			const fullBuffer = Buffer.concat(chunks);

			const splitIndex = fullBuffer.indexOf(HTTP_SEPARATOR);

			if (splitIndex === -1) {
				reject(new Error("Invalid HTTP response: No header separator found"));
				return;
			}

			const headerBuffer = fullBuffer.subarray(0, splitIndex);
			const rawBody = fullBuffer.subarray(splitIndex + 4);

			const headerText = headerBuffer.toString();
			const lines = headerText.split("\r\n");
			const [_, statusStr, ...statusTextParts] = lines[0].split(" ");

			const status = parseInt(statusStr, 10) || 200;
			const statusText = statusTextParts.join(" ");

			const headers = new Headers();
			for (let i = 1; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;
				const sep = line.indexOf(":");
				if (sep > 0) {
					const key = line.substring(0, sep).trim();
					const val = line.substring(sep + 1).trim();
					headers.append(key, val);
				}
			}

			let finalBody: Uint8Array = new Uint8Array(rawBody);

			// Handle transfer encoding FIRST (before content encoding)
			// This is the correct order per HTTP spec
			const transferEncoding = headers.get("transfer-encoding");
			if (transferEncoding?.includes("chunked")) {
				finalBody = decodeChunked(Buffer.from(finalBody));
			}

			// Handle content decompression SECOND (after transfer encoding)
			const contentEncoding = headers.get("content-encoding");
			if (contentEncoding) {
				const encodings = contentEncoding.split(",").map((e) => e.trim());

				for (const encoding of encodings) {
					if (encoding === "gzip") {
						// @ts-expect-error
						finalBody = Bun.gunzipSync(finalBody);
						// Remove content-encoding header after decompression
						headers.delete("content-encoding");
						// Update content-length to decompressed size
						headers.set("content-length", finalBody.byteLength.toString());
					} else if (encoding === "deflate") {
						// For deflate, try both raw deflate and zlib formats
						try {
							// Try raw deflate first
							const inflated = Bun.inflateSync(Buffer.from(finalBody));
							finalBody = new Uint8Array(inflated);
						} catch (_err) {
							try {
								// Try zlib format (with header) using inflateRaw
								const buffer = Buffer.from(finalBody);
								const inflated = zlib.inflateSync(buffer);
								finalBody = new Uint8Array(inflated);
							} catch (_err2) {
								// Try as gzip
								const buffer = Buffer.from(finalBody);
								// @ts-ignore
								const inflated = Bun.gunzipSync(buffer);
								finalBody = new Uint8Array(inflated);
							}
						}
						// Remove content-encoding header after decompression
						headers.delete("content-encoding");
						// Update content-length to decompressed size
						headers.set("content-length", finalBody.byteLength.toString());
					} else if (encoding === "br") {
						// Brotli decompression using Node.js zlib
						try {
							const decompressed = zlib.brotliDecompressSync(
								Buffer.from(finalBody),
							);
							finalBody = new Uint8Array(decompressed);
						} catch (err) {
							throw new Error(
								`Brotli decompression failed: ${(err as Error).message}`,
							);
						}
						// Remove content-encoding header after decompression
						headers.delete("content-encoding");
						// Update content-length to decompressed size
						headers.set("content-length", finalBody.byteLength.toString());
					} else if (encoding === "zstd") {
						// Zstd decompression using Bun's built-in support
						try {
							const decompressed = Bun.zstdDecompressSync(finalBody);
							finalBody = new Uint8Array(decompressed);
						} catch (err) {
							throw new Error(
								`Zstd decompression failed: ${(err as Error).message}`,
							);
						}
						// Remove content-encoding header after decompression
						headers.delete("content-encoding");
						// Update content-length to decompressed size
						headers.set("content-length", finalBody.byteLength.toString());
					}
				}
			}

			resolve(
				new Response(finalBody, {
					status,
					statusText,
					headers,
				}),
			);
		});

		socket.on("error", (err) => {
			cleanup();
			reject(err);
		});
	});
}

/**
 * Stub for Bun's fetch.preconnect() method.
 * In Bun, this would perform DNS lookup, TCP socket connection, and TLS handshake early.
 *
 * @param _url - The URL to preconnect to (unused in stub)
 */
fetch.preconnect = function preconnect(_url: string | URL): void {};
