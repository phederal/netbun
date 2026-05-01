import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import {
	type PooledConnection,
	Socks5ConnectionPool,
} from "../src/connection-pool";

// A trivial loopback echo server we can connect to in order to get real
// healthy net.Sockets — no mocks, no SOCKS handshake.
async function newLoopbackSocket(): Promise<net.Socket> {
	const server = net.createServer((sock) => sock.pipe(sock));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	if (typeof addr === "string" || addr === null) throw new Error("bad addr");
	const sock = net.connect(addr.port, "127.0.0.1");
	await new Promise<void>((res, rej) => {
		sock.once("connect", () => res());
		sock.once("error", rej);
	});
	// keep server alive but don't keep the loop alive past the test
	server.unref();
	return sock;
}

function asPooled(socket: net.Socket): PooledConnection {
	return {
		socket,
		proxyUrl: "socks5://x",
		targetHost: "h",
		targetPort: 80,
		useTLS: false,
		lastUsed: Date.now(),
		created: Date.now(),
	};
}

describe("Socks5ConnectionPool", () => {
	const pools: Socks5ConnectionPool[] = [];
	const sockets: net.Socket[] = [];

	afterEach(() => {
		for (const p of pools) p.dispose();
		pools.length = 0;
		for (const s of sockets) s.destroy();
		sockets.length = 0;
	});

	function makePool(opts?: ConstructorParameters<typeof Socks5ConnectionPool>[0]) {
		const p = new Socks5ConnectionPool(opts);
		pools.push(p);
		return p;
	}

	async function makeSocket() {
		const s = await newLoopbackSocket();
		sockets.push(s);
		return s;
	}

	test("getConnection returns null when pool is empty", () => {
		const pool = makePool();
		expect(pool.getConnection("k")).toBeNull();
	});

	test("releaseConnection then getConnection returns the same socket", async () => {
		const pool = makePool();
		const sock = await makeSocket();
		const conn = asPooled(sock);
		pool.releaseConnection("k", conn);
		expect(pool.size).toBe(1);
		const got = pool.getConnection("k");
		expect(got?.socket).toBe(sock);
		expect(pool.size).toBe(0);
	});

	test("destroyed socket is rejected on release", async () => {
		const pool = makePool();
		const sock = await makeSocket();
		sock.destroy();
		await new Promise((r) => setTimeout(r, 10));
		pool.releaseConnection("k", asPooled(sock));
		expect(pool.size).toBe(0);
	});

	test("destroyed socket from inside pool is skipped on getConnection", async () => {
		const pool = makePool();
		const a = await makeSocket();
		const b = await makeSocket();
		pool.releaseConnection("k", asPooled(a));
		pool.releaseConnection("k", asPooled(b));
		expect(pool.size).toBe(2);

		// Destroy one of them externally
		a.destroy();
		await new Promise((r) => setTimeout(r, 10));

		const got = pool.getConnection("k");
		// The healthy one (b) is returned; destroyed one was skipped/destroyed
		expect(got?.socket).toBe(b);
	});

	test("maxConnectionsPerHost limit destroys excess", async () => {
		const pool = makePool({ maxConnectionsPerHost: 2 });
		for (let i = 0; i < 4; i++) {
			pool.releaseConnection("k", asPooled(await makeSocket()));
		}
		expect(pool.size).toBe(2);
	});

	test("default maxConnectionsPerHost is 10", async () => {
		const pool = makePool();
		for (let i = 0; i < 12; i++) {
			pool.releaseConnection("k", asPooled(await makeSocket()));
		}
		expect(pool.size).toBe(10);
	});

	test("different keys are independent", async () => {
		const pool = makePool({ maxConnectionsPerHost: 2 });
		for (let i = 0; i < 3; i++) {
			pool.releaseConnection("a", asPooled(await makeSocket()));
		}
		for (let i = 0; i < 3; i++) {
			pool.releaseConnection("b", asPooled(await makeSocket()));
		}
		// 2 per key, 4 total
		expect(pool.size).toBe(4);
		const stats = pool.getStats();
		expect(stats.a).toBe(2);
		expect(stats.b).toBe(2);
	});

	test("listeners are stripped when releasing AND when retrieving", async () => {
		const pool = makePool();
		const sock = await makeSocket();
		sock.on("data", () => {});
		sock.on("error", () => {});
		expect(sock.listenerCount("data")).toBe(1);
		pool.releaseConnection("k", asPooled(sock));
		expect(sock.listenerCount("data")).toBe(0);
		expect(sock.listenerCount("error")).toBe(0);

		sock.on("data", () => {});
		expect(sock.listenerCount("data")).toBe(1);
		pool.getConnection("k");
		expect(sock.listenerCount("data")).toBe(0);
	});

	test("cleanupStale removes expired entries", async () => {
		const pool = makePool({ connectionTtl: 1 });
		const sock = await makeSocket();
		const conn = asPooled(sock);
		conn.lastUsed = Date.now() - 1000;
		pool.releaseConnection("k", conn);
		// release resets lastUsed to "now" — force it back
		const arr = pool.getStats();
		expect(arr.k).toBe(1);
		// re-poke lastUsed to expired
		(pool as any).pool.get("k")[0].lastUsed = Date.now() - 1000;
		pool.cleanupStale();
		expect(pool.size).toBe(0);
	});

	test("clear destroys every pooled socket", async () => {
		const pool = makePool();
		const a = await makeSocket();
		const b = await makeSocket();
		pool.releaseConnection("k", asPooled(a));
		pool.releaseConnection("k", asPooled(b));
		pool.clear();
		expect(pool.size).toBe(0);
		// destroy is async — let event loop run
		await new Promise((r) => setTimeout(r, 10));
		expect(a.destroyed).toBe(true);
		expect(b.destroyed).toBe(true);
	});
});
