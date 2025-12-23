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

export class Socks5ConnectionPool {
	private pool = new Map<string, PooledConnection[]>();
	private maxConnectionsPerKey = 50;
	private connectionTtl = 60000; // 60 seconds

	constructor(options?: {
		maxConnectionsPerKey?: number;
		connectionTtl?: number;
	}) {
		if (options?.maxConnectionsPerKey) {
			this.maxConnectionsPerKey = options.maxConnectionsPerKey;
		}
		if (options?.connectionTtl) {
			this.connectionTtl = options.connectionTtl;
		}

		// Periodic cleanup
		setInterval(() => this.cleanupStale(), 30000); // cleanup every 30 seconds
	}

	/**
	 * Get a connection from the pool or return null if none available
	 */
	getConnection(key: string): PooledConnection | null {
		const connections = this.pool.get(key);
		if (!connections || connections.length === 0) {
			return null;
		}

		// Find a healthy connection
		for (let i = 0; i < connections.length; i++) {
			const conn = connections[i];
			if (this.isConnectionHealthy(conn)) {
				// Remove from pool and return
				connections.splice(i, 1);
				conn.lastUsed = Date.now();
				return conn;
			}
		}

		return null;
	}

	/**
	 * Release a connection back to the pool
	 */
	async releaseConnection(
		key: string,
		connection: PooledConnection,
	): Promise<void> {
		if (!this.isConnectionHealthy(connection)) {
			// Destroy unhealthy connection
			connection.socket.destroy();
			return;
		}

		const connections = this.pool.get(key) || [];
		if (connections.length >= this.maxConnectionsPerKey) {
			// Pool full, destroy connection
			connection.socket.destroy();
			return;
		}

		// Add to pool
		connection.lastUsed = Date.now();
		connections.push(connection);
		this.pool.set(key, connections);
	}

	/**
	 * Cleanup stale connections
	 */
	cleanupStale(): void {
		const now = Date.now();
		for (const [key, connections] of this.pool.entries()) {
			const validConnections = connections.filter((conn) => {
				if (now - conn.lastUsed > this.connectionTtl) {
					conn.socket.destroy();
					return false;
				}
				return true;
			});

			if (validConnections.length === 0) {
				this.pool.delete(key);
			} else {
				this.pool.set(key, validConnections);
			}
		}
	}

	/**
	 * Check if a connection is healthy
	 */
	private isConnectionHealthy(connection: PooledConnection): boolean {
		const socket = connection.socket;

		// Check if socket is still connected
		if (socket.destroyed || !socket.writable || !socket.readable) {
			return false;
		}

		// For TLS sockets, check if secure connection is established
		if (connection.useTLS && "authorized" in socket) {
			const tlsSocket = socket as tls.TLSSocket;
			if (!tlsSocket.authorized && !tlsSocket.authorizationError) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Get pool statistics
	 */
	getStats(): { [key: string]: number } {
		const stats: { [key: string]: number } = {};
		for (const [key, connections] of this.pool.entries()) {
			stats[key] = connections.length;
		}
		return stats;
	}

	/**
	 * Clear all connections
	 */
	clear(): void {
		for (const connections of this.pool.values()) {
			for (const conn of connections) {
				conn.socket.destroy();
			}
		}
		this.pool.clear();
	}
}

// Global pool instance
export const globalConnectionPool = new Socks5ConnectionPool();
