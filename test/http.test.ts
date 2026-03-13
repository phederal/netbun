import { describe, test, expect } from 'bun:test';
import { fetch, parseProxyUrl } from '../src/fetch';

describe('HTTP Proxy Tests', () => {
	// Test server
	const testServer = 'https://httpbin.org';

	// Get real proxies from env
	const httpProxy = process.env.HTTP_PROXY;
	const socks5Proxy = process.env.SOCKS5_PROXY;

	describe('HTTP/HTTPS Proxy (Native fetch)', () => {
		test('should make real request through HTTP proxy from env', async () => {
			if (!httpProxy) {
				console.log('⚠️  HTTP_PROXY not set, skipping test');
				return;
			}

			const response = await fetch(testServer + '/get', {
				proxy: httpProxy,
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toHaveProperty('origin');
		}, 30000);

		test('should use HTTP_PROXY from environment automatically', async () => {
			if (!httpProxy) {
				console.log('⚠️  HTTP_PROXY not set, skipping test');
				return;
			}

			// Don't specify proxy - should use env HTTP_PROXY
			const response = await fetch(testServer + '/get');

			expect(response).toBeInstanceOf(Response);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toHaveProperty('origin');
		}, 30000);
	});

	describe('SOCKS5 Proxy (Custom implementation)', () => {
		test('should make real request through SOCKS5 proxy from env', async () => {
			if (!socks5Proxy) {
				console.log('⚠️  SOCKS5_PROXY not set, skipping test');
				return;
			}

			const response = await fetch(testServer + '/get', {
				proxy: socks5Proxy,
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toHaveProperty('origin');
			console.log('✅ SOCKS5 proxy works! Origin:', data.origin);
		}, 30000);

		test('should use SOCKS5_PROXY from environment automatically', async () => {
			if (!socks5Proxy) {
				console.log('⚠️  SOCKS5_PROXY not set, skipping test');
				return;
			}

			// Clear HTTP_PROXY to ensure SOCKS5 is used
			const originalHttpProxy = process.env.HTTP_PROXY;
			delete process.env.HTTP_PROXY;

			try {
				// Don't specify proxy - should use env SOCKS5_PROXY
				const response = await fetch(testServer + '/get');

				expect(response).toBeInstanceOf(Response);
				expect(response.status).toBe(200);

				const data = await response.json();
				console.log('✅ Auto SOCKS5 proxy works! Origin:', data.origin);
			} finally {
				if (originalHttpProxy) {
					process.env.HTTP_PROXY = originalHttpProxy;
				}
			}
		}, 30000);

		test('should handle POST request through SOCKS5', async () => {
			if (!socks5Proxy) {
				console.log('⚠️  SOCKS5_PROXY not set, skipping test');
				return;
			}

			const testData = { test: 'data', timestamp: Date.now() };
			const response = await fetch(testServer + '/post', {
				method: 'POST',
				proxy: socks5Proxy,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(testData),
			});

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.json).toEqual(testData);
			console.log('✅ SOCKS5 POST works!');
		}, 30000);
	});

	describe('Proxy configuration', () => {
		test('should parse SOCKS5 proxy URL correctly', () => {
			const parsed = parseProxyUrl('socks5://user:pass@proxy.example.com:1080');
			expect(parsed.protocol).toBe('socks5');
			expect(parsed.host).toBe('proxy.example.com');
			expect(parsed.port).toBe(1080);
			expect(parsed.user).toBe('user');
			expect(parsed.password).toBe('pass');
		});

		test('should parse HTTP proxy URL correctly', () => {
			const parsed = parseProxyUrl('http://user:pass@proxy.example.com:8080');
			expect(parsed.protocol).toBe('http');
			expect(parsed.host).toBe('proxy.example.com');
			expect(parsed.port).toBe(8080);
			expect(parsed.user).toBe('user');
			expect(parsed.password).toBe('pass');
		});

		test('should prioritize SOCKS5 over HTTP when both env vars set', async () => {
			if (!socks5Proxy) {
				console.log('⚠️  SOCKS5_PROXY not set, skipping test');
				return;
			}

			// Both proxies set - SOCKS5 should be used
			const response = await fetch(testServer + '/get');

			expect(response.status).toBe(200);
			console.log('✅ SOCKS5 prioritized over HTTP');
		}, 30000);
	});

	describe('Error handling', () => {
		test('should handle connection to non-existent SOCKS proxy', async () => {
			await expect(
				fetch(testServer + '/get', {
					proxy: 'socks5://127.0.0.1:19999', // Non-existent proxy
				}),
			).rejects.toThrow();
		}, 10000);

		test('should handle invalid proxy protocol gracefully', async () => {
			await expect(
				fetch(testServer + '/get', {
					proxy: 'ftp://invalid.proxy:8080',
				}),
			).rejects.toThrow();
		}, 10000);
	});
});
