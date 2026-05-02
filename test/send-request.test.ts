import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as net from "node:net";
import {
	type PooledConnection,
	Socks5ConnectionPool,
} from "../src/connection-pool";
import { sendRequestOverSocket } from "../src/fetch";

// Lightweight HTTP/1.1 test server that handles the routes we exercise.
// Implemented at the byte level so we can fully control framing (chunked,
// Connection headers, etc.) — Bun.serve hides those decisions.
type RouteHandler = (
	req: { method: string; path: string; headers: Headers; body: Buffer },
	socket: net.Socket,
) => void;

class RawTestServer {
	private server: net.Server;
	port = 0;
	private routes = new Map<string, RouteHandler>();

	constructor() {
		this.server = net.createServer((sock) => this.onConn(sock));
	}

	async listen(): Promise<void> {
		await new Promise<void>((r) =>
			this.server.listen(0, "127.0.0.1", () => r()),
		);
		const addr = this.server.address();
		if (typeof addr === "string" || addr === null) throw new Error("bad addr");
		this.port = addr.port;
	}

	close(): Promise<void> {
		return new Promise((r) => this.server.close(() => r()));
	}

	on(method: string, path: string, fn: RouteHandler) {
		this.routes.set(`${method} ${path}`, fn);
	}

	private onConn(sock: net.Socket) {
		let buf = Buffer.alloc(0);
		const tryParse = () => {
			while (true) {
				const sep = buf.indexOf("\r\n\r\n");
				if (sep === -1) return;
				const headPart = buf.subarray(0, sep).toString("latin1");
				const lines = headPart.split("\r\n");
				const [method, path] = lines[0]!.split(" ");
				const headers = new Headers();
				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (!line) continue;
					const colon = line.indexOf(":");
					if (colon > 0) {
						headers.append(
							line.substring(0, colon).trim(),
							line.substring(colon + 1).trim(),
						);
					}
				}
				const cl = headers.get("content-length");
				const bodyLen = cl ? parseInt(cl, 10) : 0;
				const totalNeeded = sep + 4 + bodyLen;
				if (buf.length < totalNeeded) return; // wait for body
				const body = buf.subarray(sep + 4, totalNeeded);
				buf = buf.subarray(totalNeeded);

				const handler = this.routes.get(`${method} ${path}`);
				if (handler) {
					handler({ method: method!, path: path!, headers, body }, sock);
				} else {
					sock.write(
						"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
					);
					sock.end();
				}
			}
		};
		sock.on("data", (chunk) => {
			buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
			tryParse();
		});
		sock.on("error", () => sock.destroy());
	}
}

let server: RawTestServer;

beforeAll(async () => {
	server = new RawTestServer();

	// /len5 — Content-Length response
	server.on("GET", "/len5", (_req, sock) => {
		sock.write(
			"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
		);
	});

	// /chunked — chunked response, keep-alive
	server.on("GET", "/chunked", (_req, sock) => {
		sock.write(
			"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
				"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
		);
	});

	// /close — server explicitly closes after response
	server.on("GET", "/close", (_req, sock) => {
		sock.write(
			"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbye",
		);
		sock.end();
	});

	// /204 — no content, no body
	server.on("GET", "/204", (_req, sock) => {
		sock.write("HTTP/1.1 204 No Content\r\n\r\n");
	});

	// /head-target — for HEAD requests; sends Content-Length but no body
	server.on("HEAD", "/head-target", (_req, sock) => {
		sock.write(
			"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n",
		);
	});

	// /echo — POST echo: returns body verbatim
	server.on("POST", "/echo", (req, sock) => {
		sock.write(
			`HTTP/1.1 200 OK\r\nContent-Length: ${req.body.length}\r\n\r\n`,
		);
		sock.write(req.body);
	});

	// /headers — returns the request headers JSON-encoded
	server.on("GET", "/headers", (req, sock) => {
		const obj: Record<string, string> = {};
		req.headers.forEach((v, k) => {
			obj[k] = v;
		});
		const body = Buffer.from(JSON.stringify(obj));
		sock.write(
			`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`,
		);
		sock.write(body);
	});

	// /no-cl — HTTP/1.0-style: no length, no chunked, server closes
	server.on("GET", "/no-cl", (_req, sock) => {
		sock.write(
			"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nbody-without-length",
		);
		sock.end();
	});

	await server.listen();
});

afterAll(async () => {
	await server.close();
});

async function connect(): Promise<net.Socket> {
	const sock = net.connect(server.port, "127.0.0.1");
	await new Promise<void>((res, rej) => {
		sock.once("connect", () => res());
		sock.once("error", rej);
	});
	return sock;
}

describe("sendRequestOverSocket — body framing", () => {
	test("Content-Length response is read exactly", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/len5`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello");
		expect(keepAlive).toBe(true);
		sock.destroy();
	});

	test("chunked body is decoded", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/chunked`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello world");
		expect(keepAlive).toBe(true);
		sock.destroy();
	});

	test("Connection: close marks response as non-keep-alive", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/close`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("bye");
		expect(keepAlive).toBe(false);
		sock.destroy();
	});

	test("204 No Content → empty body, keep-alive ok", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/204`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(keepAlive).toBe(true);
		sock.destroy();
	});

	test("HEAD ignores Content-Length and reads no body", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/head-target`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"HEAD",
			new Headers(),
			null,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe("100");
		expect(await response.text()).toBe("");
		expect(keepAlive).toBe(true);
		sock.destroy();
	});

	test("close-delimited body (no length, no chunked) → keepAlive=false", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/no-cl`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		expect(await response.text()).toBe("body-without-length");
		expect(keepAlive).toBe(false);
	});
});

describe("sendRequestOverSocket — request shape", () => {
	test("POST body is sent verbatim", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/echo`);
		const body = new TextEncoder().encode("payload-bytes");
		const { response } = await sendRequestOverSocket(
			sock,
			url,
			"POST",
			new Headers({ "Content-Type": "application/octet-stream" }),
			body,
		);
		expect(await response.text()).toBe("payload-bytes");
		sock.destroy();
	});

	test("default Connection header is keep-alive", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/headers`);
		const { response, keepAlive } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		const sent = (await response.json()) as Record<string, string>;
		expect(sent.connection).toBe("keep-alive");
		expect(keepAlive).toBe(true);
		sock.destroy();
	});

	test("Host header is set automatically from URL", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/headers`);
		const { response } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers(),
			null,
		);
		const sent = (await response.json()) as Record<string, string>;
		expect(sent.host).toBe(`127.0.0.1:${server.port}`);
		sock.destroy();
	});

	test("user Connection: close suppresses the default keep-alive", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/headers`);
		const { response } = await sendRequestOverSocket(
			sock,
			url,
			"GET",
			new Headers({ Connection: "close" }),
			null,
		);
		const sent = (await response.json()) as Record<string, string>;
		expect(sent.connection).toBe("close");
		sock.destroy();
	});
});

describe("sendRequestOverSocket — keep-alive reuse on the same socket", () => {
	test("two sequential requests on one socket both succeed", async () => {
		const sock = await connect();
		const url1 = new URL(`http://127.0.0.1:${server.port}/len5`);
		const r1 = await sendRequestOverSocket(
			sock,
			url1,
			"GET",
			new Headers(),
			null,
		);
		expect(await r1.response.text()).toBe("hello");
		expect(r1.keepAlive).toBe(true);
		expect(sock.destroyed).toBe(false);

		// Same socket, second request — only possible if framing was honoured
		// and listeners were properly cleaned up between requests.
		const url2 = new URL(`http://127.0.0.1:${server.port}/chunked`);
		const r2 = await sendRequestOverSocket(
			sock,
			url2,
			"GET",
			new Headers(),
			null,
		);
		expect(await r2.response.text()).toBe("hello world");
		expect(r2.keepAlive).toBe(true);

		sock.destroy();
	});
});

describe("sendRequestOverSocket + pool — full roundtrip", () => {
	test("release + reacquire actually reuses the same TCP socket", async () => {
		const pool = new Socks5ConnectionPool();
		try {
			const sock = await connect();
			const initialRemotePort = sock.remotePort; // identity proof
			const conn: PooledConnection = {
				socket: sock,
				proxyUrl: "test",
				targetHost: "127.0.0.1",
				targetPort: server.port,
				useTLS: false,
				lastUsed: Date.now(),
				created: Date.now(),
			};

			// Request 1
			const url = new URL(`http://127.0.0.1:${server.port}/len5`);
			const r1 = await sendRequestOverSocket(
				conn.socket,
				url,
				"GET",
				new Headers(),
				null,
			);
			expect(await r1.response.text()).toBe("hello");
			expect(r1.keepAlive).toBe(true);

			// Park into pool
			pool.releaseConnection("k", conn);
			expect(pool.size).toBe(1);

			// Take back out — should be the same socket object
			const got = pool.getConnection("k");
			expect(got).not.toBeNull();
			expect(got!.socket).toBe(sock);
			expect(got!.socket.remotePort).toBe(initialRemotePort);
			expect(got!.socket.destroyed).toBe(false);

			// Request 2 on the reused socket
			const url2 = new URL(`http://127.0.0.1:${server.port}/chunked`);
			const r2 = await sendRequestOverSocket(
				got!.socket,
				url2,
				"GET",
				new Headers(),
				null,
			);
			expect(await r2.response.text()).toBe("hello world");
			expect(r2.keepAlive).toBe(true);

			sock.destroy();
		} finally {
			pool.dispose();
		}
	});

	test("server Connection: close → keepAlive=false → not pooled", async () => {
		const pool = new Socks5ConnectionPool();
		try {
			const sock = await connect();
			const conn: PooledConnection = {
				socket: sock,
				proxyUrl: "test",
				targetHost: "127.0.0.1",
				targetPort: server.port,
				useTLS: false,
				lastUsed: Date.now(),
				created: Date.now(),
			};

			const url = new URL(`http://127.0.0.1:${server.port}/close`);
			const result = await sendRequestOverSocket(
				conn.socket,
				url,
				"GET",
				new Headers(),
				null,
			);
			expect(result.keepAlive).toBe(false);

			// fetchInternal would skip release in this case — simulate the same
			// decision here and verify the pool stays empty.
			if (result.keepAlive) {
				pool.releaseConnection("k", conn);
			} else {
				conn.socket.destroy();
			}
			expect(pool.size).toBe(0);
		} finally {
			pool.dispose();
		}
	});
});

describe("sendRequestOverSocket — abort", () => {
	test("aborted signal rejects the promise", async () => {
		const sock = await connect();
		const url = new URL(`http://127.0.0.1:${server.port}/len5`);
		const ctrl = new AbortController();
		ctrl.abort(new Error("nope"));
		await expect(
			sendRequestOverSocket(
				sock,
				url,
				"GET",
				new Headers(),
				null,
				ctrl.signal,
			),
		).rejects.toThrow(/nope/);
		expect(sock.destroyed).toBe(true);
	});
});
