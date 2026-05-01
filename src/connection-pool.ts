import type * as net from "node:net";
import type * as tls from "node:tls";

export interface PooledConnection {
	socket: net.Socket | tls.TLSSocket;
	proxyUrl: string;
	targetHost: string;
	targetPort: number;
	useTLS: boolean;
	lastUsed: number;
	created: number;
}

/**
 * Strip listeners that may have been attached during a previous request.
 *
 * Sockets returned from the pool must look "fresh" to the next caller — any
 * leftover `data`/`end`/`error`/`timeout` handlers from the previous request
 * would otherwise misroute bytes or fire spurious errors.
 */
function stripSocketListeners(socket: net.Socket | tls.TLSSocket): void {
	socket.removeAllListeners("data");
	socket.removeAllListeners("end");
	socket.removeAllListeners("error");
	socket.removeAllListeners("timeout");
	socket.removeAllListeners("close");
	socket.setTimeout(0);
}

export class Socks5ConnectionPool {
	private pool = new Map<string, PooledConnection[]>();
	private maxConnectionsPerHost = 10;
	private connectionTtl = 60000; // 60 seconds
	private cleanupTimer: ReturnType<typeof setInterval>;

	constructor(options?: {
		maxConnectionsPerHost?: number;
		connectionTtl?: number;
	}) {
		if (typeof options?.maxConnectionsPerHost === "number") {
			this.maxConnectionsPerHost = options.maxConnectionsPerHost;
		}
		if (typeof options?.connectionTtl === "number") {
			this.connectionTtl = options.connectionTtl;
		}

		this.cleanupTimer = setInterval(() => this.cleanupStale(), 30000);
		this.cleanupTimer.unref?.();
	}

	/**
	 * Take a healthy connection from the pool, or null if none available.
	 * The returned socket has had all prior listeners stripped — caller owns it
	 * and must either re-release or destroy.
	 */
	getConnection(key: string): PooledConnection | null {
		const connections = this.pool.get(key);
		if (!connections || connections.length === 0) return null;

		while (connections.length > 0) {
			const conn = connections.pop() as PooledConnection;
			if (this.isConnectionHealthy(conn)) {
				stripSocketListeners(conn.socket);
				conn.lastUsed = Date.now();
				return conn;
			}
			conn.socket.destroy();
		}

		this.pool.delete(key);
		return null;
	}

	/**
	 * Return a connection to the pool, or destroy it if the pool is full
	 * or the connection is unhealthy.
	 */
	releaseConnection(key: string, connection: PooledConnection): void {
		if (!this.isConnectionHealthy(connection)) {
			connection.socket.destroy();
			return;
		}

		const connections = this.pool.get(key) || [];
		if (connections.length >= this.maxConnectionsPerHost) {
			connection.socket.destroy();
			return;
		}

		// Strip listeners before parking the socket so leftover handlers from
		// the just-finished request can't fire on subsequent activity.
		stripSocketListeners(connection.socket);
		connection.lastUsed = Date.now();
		connections.push(connection);
		this.pool.set(key, connections);
	}

	/** Drop connections that exceeded the TTL. */
	cleanupStale(): void {
		const now = Date.now();
		for (const [key, connections] of this.pool.entries()) {
			const valid = connections.filter((conn) => {
				if (now - conn.lastUsed > this.connectionTtl) {
					conn.socket.destroy();
					return false;
				}
				if (!this.isConnectionHealthy(conn)) {
					conn.socket.destroy();
					return false;
				}
				return true;
			});

			if (valid.length === 0) this.pool.delete(key);
			else this.pool.set(key, valid);
		}
	}

	/**
	 * A socket is healthy iff it is not destroyed and is still both readable
	 * and writable. We deliberately do NOT inspect TLS authorization state:
	 * users may pass `rejectUnauthorized: false`, in which case `authorized`
	 * is `false` and `authorizationError` is `null` — that combination is
	 * legitimate, not a sign of a broken socket.
	 */
	private isConnectionHealthy(connection: PooledConnection): boolean {
		const socket = connection.socket;
		if (socket.destroyed) return false;
		if (!socket.writable || !socket.readable) return false;
		return true;
	}

	/** Number of pooled connections per key. Useful for tests/diagnostics. */
	getStats(): Record<string, number> {
		const stats: Record<string, number> = {};
		for (const [key, connections] of this.pool.entries()) {
			stats[key] = connections.length;
		}
		return stats;
	}

	/** Total number of pooled connections across all keys. */
	get size(): number {
		let total = 0;
		for (const conns of this.pool.values()) total += conns.length;
		return total;
	}

	/** Destroy every pooled connection and clear the pool. */
	clear(): void {
		for (const connections of this.pool.values()) {
			for (const conn of connections) conn.socket.destroy();
		}
		this.pool.clear();
	}

	/** Stop the periodic cleanup timer. Mainly for tests. */
	dispose(): void {
		clearInterval(this.cleanupTimer);
		this.clear();
	}
}

// Process-wide pool used by the public fetch().
export const globalConnectionPool = new Socks5ConnectionPool();
