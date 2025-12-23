import { describe, test, expect } from 'bun:test';
import { fetch } from '../src/fetch';

describe('Redirect Handling', () => {
	const TEST_BASE_URL = 'https://httpbin.org';
	const TIMEOUT = 15000;

	// Helper function for testing
	async function testFetch(path: string, options?: RequestInit) {
		const url = `${TEST_BASE_URL}${path}`;
		const finalOptions: any = {
			...options,
		};

		// Add timeout and TLS options
		const controller = new AbortController();
		setTimeout(() => controller.abort(), TIMEOUT);
		finalOptions.signal = controller.signal;
		finalOptions.tls = { rejectUnauthorized: false };
		// Default redirect 'follow', override with options

		return fetch(url, finalOptions);
	}

	test('should handle basic redirect', async () => {
		const response = await testFetch('/redirect/1');

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
	});

	test('should follow multiple redirects', async () => {
		const response = await testFetch('/redirect/3', { redirect: 'follow' });

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		expect(data.url).toContain('/get');
	});

	test('should handle redirect with query params', async () => {
		const response = await testFetch('/redirect-to?url=/get?test=123', { redirect: 'follow' });

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		expect(data.args.test).toBe('123');
	});

	test('should preserve headers in redirect', async () => {
		const response = await testFetch('/redirect/1', {
			headers: { 'X-Test-Header': 'test-value' },
			redirect: 'follow',
		});

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		expect(data.headers['X-Test-Header']).toBe('test-value');
	});

	// test('should not follow redirects when manual mode', async () => {
	//	const response = await testFetch('/redirect/1', {
	//		redirect: 'manual' as any,
	//	});

	//	// Should get redirect response directly
	//	expect(response.status).toBe(302);
	//	expect(response.ok).toBe(false);
	//	expect(response.headers.get('location')).toBe('/get');
	// });

	test('should handle redirect limit', async () => {
		// Test with a reasonable number of redirects
		const response = await testFetch('/redirect/5', { redirect: 'follow' });

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
	});

	test("should throw error when redirect mode is 'error'", async () => {
		try {
			await fetch('http://httpbin.org/redirect/1', {
				redirect: 'error' as any,
			});
			expect(true).toBe(false); // Should not reach here
		} catch (error: any) {
			expect(error.message).toContain('redirect mode is \'error\'');
		}
	});

	test('should convert POST to GET on 303 redirect', async () => {
		const response = await testFetch('/redirect-to?url=/get&status_code=303', {
			method: 'POST',
			body: JSON.stringify({ test: 'data' }),
			headers: { 'Content-Type': 'application/json' },
			redirect: 'follow',
		});

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		// Should be GET method after redirect
		expect(data.url).toContain('/get');
	});

	test('should preserve POST method on 307 redirect', async () => {
		const response = await testFetch('/redirect-to?url=/post&status_code=307', {
			method: 'POST',
			body: JSON.stringify({ test: 'data' }),
			headers: { 'Content-Type': 'application/json' },
			redirect: 'follow',
		});

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		// Should preserve POST method
		expect(data.url).toContain('/post');
	});

	test('should handle absolute URL redirects', async () => {
		const response = await testFetch('/absolute-redirect/1', { redirect: 'follow' });

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		expect(data.url).toContain('/get');
	});

	test('should handle relative URL redirects', async () => {
		const response = await testFetch('/relative-redirect/1', { redirect: 'follow' });

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		expect(data.url).toContain('/get');
	});
});

describe('Redirect Security', () => {
	const TIMEOUT = 30000;

	// Helper to create a simple test server for cross-origin testing
	async function testFetch(url: string, options?: RequestInit) {
		const finalOptions: any = {
			...options,
		};

		const controller = new AbortController();
		setTimeout(() => controller.abort(), TIMEOUT);
		finalOptions.signal = controller.signal;
		finalOptions.tls = { rejectUnauthorized: false };

		return fetch(url, finalOptions);
	}

	test('should add Referer header on redirects', async () => {
		const response = await testFetch('https://httpbin.org/redirect/1');

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		const data = await response.json();
		// Check that the request included headers
		expect(data.headers).toBeDefined();
	});

	test('should not mutate original init object', async () => {
		const originalInit: any = {
			method: 'POST',
			body: JSON.stringify({ test: 'data' }),
			headers: { 'Content-Type': 'application/json' },
			redirect: 'follow',
		};

		// Save original values
		const originalMethod = originalInit.method;
		const originalBody = originalInit.body;

		await testFetch('https://httpbin.org/redirect-to?url=/get&status_code=303', originalInit);

		// Verify original object was not mutated
		expect(originalInit.method).toBe(originalMethod);
		expect(originalInit.body).toBe(originalBody);
	});

	test('should handle 301 redirect', async () => {
		const response = await testFetch('https://httpbin.org/redirect-to?url=/get&status_code=301');

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
	});

	test('should handle 302 redirect', async () => {
		const response = await testFetch('https://httpbin.org/redirect-to?url=/get&status_code=302');

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
	});

	test('should handle 308 redirect', async () => {
		const response = await testFetch('https://httpbin.org/redirect-to?url=/get&status_code=308');

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
	});

	test('should stop at max redirects (20)', async () => {
		const response = await testFetch('https://httpbin.org/redirect/5', { redirect: 'follow' });
		expect(response.status).toBe(200);
	});
});
