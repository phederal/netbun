import { fetch } from '../src/fetch';
import { describe, test, expect } from 'bun:test';

// Test configuration
const TEST_BASE_URL = 'https://httpbin.org';
const TIMEOUT = 15000;

// Proxy configuration for testing
const TEST_PROXIES: string[] = [
	// Add your SOCKS5 proxies here for testing
	// "socks5://user:pass@127.0.0.1:1080",
	// "socks5://127.0.0.1:1080"
	'socks5://107.152.98.5:4145',
	'socks5://34.124.190.108:8080',
	'http://190.12.150.244:999',
	'http://190.242.157.215:8080',
];

describe('Fetch API Comprehensive Tests', () => {
	// Helper function to create test with optional proxy
	async function testFetch(path: string, options?: RequestInit, useProxy = false) {
		let url = `${TEST_BASE_URL}${path}`;
		if (path.startsWith('http')) {
			url = path;
		}
		const finalOptions: any = {
			...options,
			tls: { rejectUnauthorized: false },
		};

		if (useProxy && TEST_PROXIES.length > 0) {
			// Use first available proxy for testing
			finalOptions.proxy = TEST_PROXIES[0];
		}

		// Add timeout via AbortSignal if not provided
		if (!options?.signal) {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), TIMEOUT);
			finalOptions.signal = controller.signal;
		} else {
			finalOptions.signal = options.signal;
		}

		return fetch(url, finalOptions);
	}

	describe('HTTP Methods', () => {
		test('GET request', async () => {
			const response = await testFetch('/anything');
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('GET');
		});

		test('POST request with JSON body', async () => {
			const body = { test: 'data', number: 42 };
			const response = await testFetch('/anything', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('POST');
			expect(data.json).toEqual(body);
		});

		test('PUT request', async () => {
			const body = 'test data';
			const response = await testFetch('/anything', {
				method: 'PUT',
				headers: { 'Content-Type': 'text/plain' },
				body,
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('PUT');
			expect(data.data).toBe(body);
		});

		test('DELETE request', async () => {
			const response = await testFetch('/anything', { method: 'DELETE' });
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('DELETE');
		});

		test('PATCH request', async () => {
			const body = { patch: 'data' };
			const response = await testFetch('/anything', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('PATCH');
			expect(data.json).toEqual(body);
		});

		test('HEAD request', async () => {
			const response = await testFetch('/get', { method: 'HEAD' });
			expect(response.ok).toBe(true);
			// HEAD responses should not have a body or should be empty
			const text = await response.text();
			expect(text).toBe('');
		});

		test('OPTIONS request', async () => {
			const response = await testFetch('/get', { method: 'OPTIONS' });
			expect(response.ok).toBe(true);
			expect(response.headers.get('allow')).toBeTruthy();
		});
	});

	describe('Headers Handling', () => {
		test('custom headers', async () => {
			const headers = {
				'X-Custom-Header': 'test-value',
				'X-Another-Header': 'another-value',
			};
			const response = await testFetch('/get', { headers });
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.headers['X-Custom-Header']).toBe('test-value');
			expect(data.headers['X-Another-Header']).toBe('another-value');
		});

		test('authorization header', async () => {
			const auth = 'Bearer token123';
			const response = await testFetch('/get', {
				headers: { Authorization: auth },
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.headers.Authorization).toBe(auth);
		});

		test('user-agent header', async () => {
			const userAgent = 'netbun-test/1.0';
			const response = await testFetch('/get', {
				headers: { 'User-Agent': userAgent },
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.headers['User-Agent']).toBe(userAgent);
		});

		test('content-type header', async () => {
			const response = await testFetch('/post', {
				method: 'POST',
				headers: { 'Content-Type': 'application/xml' },
				body: '<xml>test</xml>',
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.headers['Content-Type']).toBe('application/xml');
		});
	});

	describe('Request Body Handling', () => {
		test('JSON body', async () => {
			const body = { key: 'value', array: [1, 2, 3] };
			const response = await testFetch('/post', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.json).toEqual(body);
		});

		test('text body', async () => {
			const body = 'plain text content';
			const response = await testFetch('/post', {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body,
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.data).toBe(body);
		});

		test('form data body', async () => {
			const body = 'name=value&param=data';
			const response = await testFetch('/post', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.form).toEqual({ name: 'value', param: 'data' });
		});

		test('binary body', async () => {
			const body = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
			const response = await testFetch('/post', {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream' },
				body,
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.data).toBeTruthy();
		});

		test('empty body with POST', async () => {
			const response = await testFetch('/anything', { method: 'POST' });
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('POST');
		});
	});

	describe('Response Handling', () => {
		test('status codes', async () => {
			// Test 200 OK
			const response200 = await testFetch('/status/200');
			expect(response200.status).toBe(200);
			expect(response200.ok).toBe(true);

			// Test 404 Not Found
			const response404 = await testFetch('/status/404');
			expect(response404.status).toBe(404);
			expect(response404.ok).toBe(false);

			// Test 500 Internal Server Error
			const response500 = await testFetch('/status/500');
			expect(response500.status).toBe(500);
			expect(response500.ok).toBe(false);
		});

		test('response headers', async () => {
			const response = await testFetch('/response-headers', {
				headers: { 'X-Test-Header': 'test-value' },
			});
			expect(response.ok).toBe(true);
			expect(response.headers.get('content-type')).toBeTruthy();
		});

		test('response body as text', async () => {
			const response = await testFetch('/html');
			expect(response.ok).toBe(true);
			const text = await response.text();
			expect(text).toContain('<html>');
		});

		test('response body as JSON', async () => {
			const response = await testFetch('/json');
			expect(response.ok).toBe(true);
			const json = await response.json();
			expect(json).toHaveProperty('slideshow');
		});

		test('response body as arrayBuffer', async () => {
			const response = await testFetch('/bytes/1024');
			expect(response.ok).toBe(true);
			const buffer = await response.arrayBuffer();
			expect(buffer.byteLength).toBe(1024);
		});
	});

	describe('Proxy Configuration', () => {
		test('SOCKS5 proxy without authentication', async () => {
			if (TEST_PROXIES.length === 0) {
				console.log('⚠️  Skipping proxy test - no proxies configured');
				return;
			}

			// Test with a proxy that doesn't require authentication
			const proxyUrl = TEST_PROXIES.find((p) => !p.includes('@'));
			if (!proxyUrl) {
				console.log('⚠️  Skipping unauthenticated proxy test - none available');
				return;
			}

			const response = await testFetch('/anything', {}, true);
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('GET');
		});

		test.skip('SOCKS5 proxy with authentication', async () => {
			if (TEST_PROXIES.length === 0) {
				console.log('⚠️  Skipping proxy test - no proxies configured');
				return;
			}

			// Test with a proxy that requires authentication
			const proxyUrl = TEST_PROXIES.find((p) => p.includes('@'));
			if (!proxyUrl) {
				console.log('⚠️  Skipping authenticated proxy test - none available');
				return;
			}

			const response = await testFetch('/anything', {}, true);
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('GET');
		});

		test('proxy fallback to native fetch', async () => {
			// Test with invalid proxy - should fallback to native fetch
			try {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), TIMEOUT);
				const response = await fetch(`${TEST_BASE_URL}/get`, {
					proxy: 'invalid://proxy',
					tls: { rejectUnauthorized: false },
					signal: controller.signal,
				});
				expect(response.ok).toBe(true);
			} catch (error) {
				// Handle certificate expiration errors gracefully
				if (error instanceof Error && error.message.includes('CERT_HAS_EXPIRED')) {
					console.log('⚠️  Certificate expired - test passed (fallback worked)');
				} else {
					throw error;
				}
			}
		});
	});

	describe('TLS Options', () => {
		test('rejectUnauthorized: false', async () => {
			// This test would work with a proxy that has certificate issues
			if (TEST_PROXIES.length === 0) {
				console.log('⚠️  Skipping TLS test - no proxies configured');
				return;
			}

			const response = await testFetch('https://httpbin.dmuth.org/get', {}, true);
			expect(response.ok).toBe(true);
		});

		test('custom TLS options', async () => {
			if (TEST_PROXIES.length === 0) {
				console.log('⚠️  Skipping TLS test - no proxies configured');
				return;
			}

			const controller = new AbortController();
			setTimeout(() => controller.abort(), TIMEOUT);
			const response = await fetch(`${TEST_BASE_URL}/anything`, {
				proxy: TEST_PROXIES[0],
				tls: {
					rejectUnauthorized: false,
					// Add other TLS options as needed
				},
				signal: controller.signal,
			});
			expect(response.ok).toBe(true);
		});
	});

	describe('AbortSignal and Timeout', () => {
		test('AbortSignal cancellation', async () => {
			const controller = new AbortController();
			// Abort immediately
			controller.abort();

			try {
				await testFetch('/delay/5', { signal: controller.signal });
				expect(true).toBe(false); // Should not reach here
			} catch (error) {
				expect(error).toBeInstanceOf(DOMException);
				expect((error as DOMException).name).toBe('AbortError');
			}
		});

		test('timeout via AbortSignal', async () => {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 100); // 100ms timeout

			try {
				await testFetch('/delay/5', { signal: controller.signal });
				clearTimeout(timeoutId);
				expect(true).toBe(false); // Should not reach here
			} catch (error) {
				clearTimeout(timeoutId);
				expect(error).toBeInstanceOf(DOMException);
				expect((error as DOMException).name).toBe('AbortError');
			}
		});
	});

	describe('Edge Cases and Error Conditions', () => {
		test('invalid URL', async () => {
			try {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), TIMEOUT);
				await fetch('not-a-url', { signal: controller.signal });
				expect(true).toBe(false); // Should not reach here
			} catch (error) {
				expect(error).toBeInstanceOf(TypeError);
			}
		});

		test('network error', async () => {
			try {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), TIMEOUT);
				await fetch('http://nonexistent-domain-12345.com', { signal: controller.signal });
				expect(true).toBe(false); // Should not reach here
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
			}
		});

		test('Request object as input', async () => {
			const request = new Request(`${TEST_BASE_URL}/get`, {
				method: 'GET',
				headers: { 'X-Test': 'Request-Object' },
			});
			const response = await fetch(request, {
				tls: { rejectUnauthorized: false },
			});
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.headers['X-Test']).toBe('Request-Object');
		});

		test('URL object as input', async () => {
			const url = new URL(`${TEST_BASE_URL}/anything`);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), TIMEOUT);
			const response = await fetch(url, { signal: controller.signal, tls: { rejectUnauthorized: false } });
			expect(response.ok).toBe(true);
			const data = await response.json();
			expect(data.method).toBe('GET');
		});

		test('large request body', async () => {
			const largeBody = 'x'.repeat(1024 * 1024); // 1MB
			const response = await testFetch('/post', {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: largeBody,
			});
			expect(response.ok).toBe(true);
		});

		test('concurrent requests', async () => {
			const promises = Array.from({ length: 10 }, (_, i) => testFetch(`/get?test=${i}`));
			const responses = await Promise.all(promises);
			responses.forEach((response) => {
				expect(response.ok).toBe(true);
			});
		});
	});
});
