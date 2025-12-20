import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";

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

		// Validate Protocol - 's' и '5'
		if (
			parsed.protocol.charCodeAt(0) !== 0x73 ||
			parsed.protocol.charCodeAt(5) !== 0x35
		) {
			throw new Error(
				`Unsupported proxy protocol: ${parsed.protocol}. Only socks5: is supported.`,
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
		const port = parsed.port ? parseInt(parsed.port, 10) : 1080;

		return { host, port, user, password };
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

			socket.setTimeout(15000, () => {
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
							const tlsSocket = tls.connect({ socket, servername: targetHost });
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

export function decodeChunked(buffer: Buffer): Uint8Array {
	const chunks: Buffer[] = [];
	let index = 0;

	while (index < buffer.length) {
		const lineEnd = buffer.indexOf("\r\n", index);
		if (lineEnd === -1) break;

		const sizeStr = buffer.toString("utf8", index, lineEnd);
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

	return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Custom Fetch implementation that supports SOCKS5 via the 'proxy' init option.
 */
export async function fetch(
	input: string | URL | Request, // url
	init?: BunFetchRequestInit & { proxy?: { resolveDnsLocally?: boolean } }, // bun fetch opts
): Promise<Response> {
	// Fallback 1: No proxy specified - check env vars
	let proxyUrl: string | undefined;

	if (!init?.proxy) {
		const envProxy = process.env.SOCKS5_PROXY || process.env.SOCKS_PROXY;
		if (envProxy) {
			proxyUrl = envProxy;
		} else {
			return _fetch(input, init);
		}
	} else {
		proxyUrl = typeof init.proxy === "string" ? init.proxy : init.proxy.url;
	}

	const url = proxyUrl;

	// Быстрый early exit - не SOCKS прокси
	if (!url || url.charCodeAt(0) !== 0x73) {
		return _fetch(input, init);
	}

	// Fallback 2: Invalid proxy configuration string
	try {
		parseProxyUrl(url);
	} catch (_err) {
		console.warn(
			`Invalid proxy configuration: "${url}". Falling back to native fetch.`,
		);

		// Fixed: Strip the 'proxy' property so native fetch doesn't error on the unsupported protocol
		// const { proxy: _, ...nativeInit } = init || {}; // not for that case
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

	// 3. Get SOCKS socket with optional TLS
	const resolveDnsLocally = init?.proxy?.resolveDnsLocally ?? false;
	const socket = await connectSocks5(
		url,
		urlObj.hostname,
		port,
		isHttps,
		resolveDnsLocally,
		init?.signal || undefined,
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

		// Add Content-Length if body exists and header is missing
		if (bodyUint8 && !req.headers.has("content-length")) {
			req.headers.set("Content-Length", bodyUint8.byteLength.toString());
		}

		req.headers.forEach((value, key) => {
			const lowerKey = key.toLowerCase();
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

			const transferEncoding = headers.get("transfer-encoding");
			if (transferEncoding?.includes("chunked")) {
				finalBody = decodeChunked(rawBody);
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
