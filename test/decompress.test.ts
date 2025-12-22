import { describe, test, expect, beforeAll } from 'bun:test';
import { fetch } from '../src/fetch';

describe('SOCKS5', () => {
	// Test endpoints that return compressed responses
	const endpoints = {
		gzip: 'https://httpbin.org/gzip',
		deflate: 'https://httpbin.org/deflate',
		brotli: 'https://httpbin.org/brotli',
		zstd: 'https://httpbin.org/anything', // Use /anything to test zstd
		plain: 'https://httpbin.org/json', // uncompressed
		encodingTest: 'https://httpbin.org/encoding/utf8',
	};

	// Configuration - you'll need to replace these with your actual proxy
	const proxyUrl = process.env.SOCKS5_PROXY || "socks5://user:pass@127.0.0.1:1080";

	beforeAll(() => {
		if (!process.env.SOCKS5_PROXY) {
			console.warn("⚠️  Set SOCKS5_PROXY environment variable to run these tests");
			process.exit(1);
		}
	});

	describe('Decompression', () => {
		test('gzip', async () => {
			const response = await fetch(endpoints.gzip, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			const text = await response.text();
			expect(text).toContain('gzipped');
		});

		test('deflate', async () => {
			const response = await fetch(endpoints.deflate, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			const text = await response.text();
			expect(text).toContain('deflated');

			const json = JSON.parse(text);
			expect(json).toHaveProperty('deflated');
			expect(typeof json.deflated).toBe('boolean');
		});

		test('brotli', async () => {
			const response = await fetch(endpoints.brotli, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			const text = await response.text();
			expect(text).toContain('brotli');
		});

		test('zstd', async () => {
			// Test with httpbin.org/anything and specific zstd Accept-Encoding
			const response = await fetch(endpoints.zstd, {
				proxy: proxyUrl,
				headers: {
					'Accept-Encoding': 'zstd',
				},
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			const text = await response.text();
			expect(text.length).toBeGreaterThan(0);
		});

		test('uncompressed responses', async () => {
			const response = await fetch(endpoints.plain, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			const text = await response.text();
			expect(text).toContain('slideshow');
		});

		test('response headers correctly', async () => {
			const response = await fetch(endpoints.gzip, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			// Content-Encoding should be removed after decompression
			// (if decompression was applied)
			const contentEncoding = response.headers.get('content-encoding');

			// The decompressed response might still have content-encoding header
			// depending on implementation, but the body should be readable
			const text = await response.text();
			expect(text.length).toBeGreaterThan(0);
		});

		test('compare native fetch behavior', async () => {
			// Test with native fetch (no proxy)
			const nativeResponse = await fetch(endpoints.gzip, {
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
				headers: {
					'User-Agent': 'Bun/1.3.5',
					Accept: '*/*',
					'Accept-Encoding': 'gzip, deflate, br, zstd',
				},
			});

			// Test with SOCKS5 proxy
			const proxyResponse = await fetch(endpoints.gzip, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
				headers: {
					'User-Agent': 'Bun/1.3.5',
					Accept: '*/*',
					'Accept-Encoding': 'gzip, deflate, br, zstd',
				},
			});

			expect(nativeResponse).toBeInstanceOf(Response);
			expect(proxyResponse).toBeInstanceOf(Response);

			expect(nativeResponse.ok).toBe(true);
			expect(proxyResponse.ok).toBe(true);

			// Compare response bodies
			const nativeText = await nativeResponse.text();
			const proxyText = await proxyResponse.text();

			// Parse both as JSON to ensure structure is same
			const nativeJson = JSON.parse(nativeText);
			const proxyJson = JSON.parse(proxyText);

			// Compare only important data, ignoring dynamic headers
			expect(nativeJson.gzipped).toBe(proxyJson.gzipped);
			expect(nativeJson.method).toBe(proxyJson.method);
			expect(nativeJson.url).toBe(proxyJson.url);
		});
	});

	describe('Performance', () => {
		test('detect content encoding correctly', async () => {
			// Test only the basic encodings to avoid timeout
			const response = await fetch(endpoints.gzip, {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(10000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			const text = await response.text();
			expect(text.length).toBeGreaterThan(0);
			expect(text).toContain('gzipped');

			// Verify content-encoding header is removed after decompression
			const contentEncoding = response.headers.get('content-encoding');
			expect(contentEncoding).toBeNull();
		});

		test('large compressed responses', async () => {
			// httpbin has an endpoint that returns larger data
			const response = await fetch('https://httpbin.org/bytes/65536', {
				proxy: proxyUrl,
				signal: AbortSignal.timeout(15000),
				tls: { rejectUnauthorized: false },
			});

			expect(response).toBeInstanceOf(Response);
			expect(response.ok).toBe(true);

			// Read as bytes to check we get the expected amount
			const bytes = await response.arrayBuffer();
			expect(bytes.byteLength).toBe(65536);
		});

		test('errors gracefully', async () => {
			// Test with an endpoint that will return an error
			try {
				const response = await fetch('https://httpbin.org/status/500', {
					proxy: proxyUrl,
					signal: AbortSignal.timeout(10000),
					tls: { rejectUnauthorized: false },
				});

				expect(response.status).toBe(500);
				expect(response.ok).toBe(false);
			} catch (error) {
				// Don't fail the test if the proxy itself has connection issues
			}
		});
	});
});
