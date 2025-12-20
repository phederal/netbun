import { beforeAll, describe, expect, test } from 'bun:test';
import { fetch as socksFetch } from '../src/fetch';

// Define strict types for our Environment to avoid TS errors
const rawConfig = process.env.PROXY_CONFIG;
let PROXY_URL = '';

describe('SOCKS5 Proxy Advanced Tests', () => {
	beforeAll(() => {
		if (!rawConfig) {
			console.warn('⚠️ PROXY_CONFIG is missing. Skipping tests.');
			// We can't actually skip 'describe' blocks dynamically in Bun yet,
			// but we will guard the tests inside.
			return;
		}

		// Convert comma-separated config to URL format if necessary
		// or just use it if it's already a URL.
		if (rawConfig.includes('://')) {
			PROXY_URL = rawConfig;
		} else {
			const [host, port, user, pass] = rawConfig.split(',').map((s) => s.trim());
			const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
			PROXY_URL = `socks5://${user}:${pass}@${urlHost}:${port}`;
		}

		console.log(`🔌 Using Proxy: ${PROXY_URL}`);
	});

	test('Security: Proxy IP should differ from Local IP', async () => {
		if (!PROXY_URL) return;

		const ipService = 'https://api64.ipify.org?format=json';

		// 1. Local IP
		const localRes = await fetch(ipService);
		const localJson = await localRes.json();

		// 2. Proxy IP
		const proxyRes = await socksFetch(ipService, { proxy: PROXY_URL });
		const proxyJson = await proxyRes.json();

		console.log(`🏠 Local: ${localJson.ip} | 🌍 Proxy: ${proxyJson.ip}`);

		expect(proxyRes.status).toBe(200);
		expect(proxyJson.ip).toBeDefined();
		expect(proxyJson.ip).not.toBe(localJson.ip);
	});

	test('Protocol: Should handle HTTP (Non-SSL) requests', async () => {
		if (!PROXY_URL) return;

		// We use detectportal.firefox.com as it supports plain HTTP reliably without redirects
		const res = await socksFetch('http://detectportal.firefox.com/success.txt', { proxy: PROXY_URL });
		const text = await res.text();

		expect(res.status).toBe(200);
		expect(text.trim()).toBe('success');
	});

	test('Protocol: Should handle HTTPS (TLS Upgrade) requests', async () => {
		if (!PROXY_URL) return;

		const res = await socksFetch('https://postman-echo.com/get', {
			proxy: PROXY_URL,
		});
		const data = await res.json();

		expect(res.status).toBe(200);
		expect(data.url).toBe('https://postman-echo.com/get');
	});

	test('Methods: Should handle POST requests with JSON body', async () => {
		if (!PROXY_URL) return;

		const payload = { message: 'Hello from SOCKS5', timestamp: Date.now() };

		const res = await socksFetch('https://postman-echo.com/post', {
			method: 'POST',
			body: JSON.stringify(payload),
			headers: { 'Content-Type': 'application/json' },
			proxy: PROXY_URL,
		});

		const data = await res.json();

		expect(res.status).toBe(200);
		// Postman Echo puts the JSON body in the 'json' field
		expect(data.json).toEqual(payload);

		// Postman Echo usually lowercases headers in the response JSON
		expect(data.headers['content-type']).toBe('application/json');
	});

	test('Headers: Should pass custom headers correctly', async () => {
		if (!PROXY_URL) return;

		const res = await socksFetch('https://postman-echo.com/headers', {
			headers: { 'X-Custom-Auth': 'SecretToken123' },
			proxy: PROXY_URL,
		});

		const data = await res.json();

		expect(res.status).toBe(200);
		// Header keys in the JSON response from Postman Echo are typically lowercase
		expect(data.headers['x-custom-auth']).toBe('SecretToken123');

		// Verify default User-Agent is set by our library
		expect(data.headers['user-agent']).toContain('Bun-Socks-Client');
	});

	test('Concurrency: Should handle parallel requests', async () => {
		if (!PROXY_URL) return;

		// Fire off 3 requests simultaneously using reliable endpoints
		const urls = ['https://postman-echo.com/ip', 'https://postman-echo.com/headers', 'https://postman-echo.com/get?test=concurrency'];

		const promises = urls.map((url) => socksFetch(url, { proxy: PROXY_URL }));
		const responses = await Promise.all(promises);

		for (const res of responses) {
			expect(res.ok).toBe(true);
			expect(res.status).toBe(200);
		}
	});

	test('Configuration: Should throw on invalid SOCKS proxy host', async () => {
		const invalidProxy = 'socks5://non-existent-host-12345.invalid:1080';

		expect(
			socksFetch('http://detectportal.firefox.com/success.txt', {
				proxy: invalidProxy,
			})
		).rejects.toThrow();
	}, 2000);

	test('Configuration: Should pass non-SOCKS proxy to native fetch', async () => {
		const httpProxy = 'http://proxy.example.com:8080';

		// Will pass to globalThis.fetch - may fail if proxy doesn't exist
		// This just tests that we don't throw and delegate properly
		try {
			await socksFetch('http://detectportal.firefox.com/success.txt', {
				proxy: httpProxy,
			});
		} catch (err) {
			// Expected to fail since proxy doesn't exist, but shouldn't be our error
			expect((err as Error).message).not.toContain('SOCKS5');
		}
	});

	test('AbortSignal: Should abort request during connection', async () => {
		if (!PROXY_URL) return;

		const controller = new AbortController();

		// Abort immediately
		controller.abort();

		await expect(
			socksFetch('https://postman-echo.com/delay/5', {
				proxy: PROXY_URL,
				signal: controller.signal,
			})
		).rejects.toThrow(/abort/i);
	});

	test('AbortSignal: Should abort request with custom reason', async () => {
		if (!PROXY_URL) return;

		const controller = new AbortController();
		const customReason = new Error('Custom abort reason');

		controller.abort(customReason);

		await expect(
			socksFetch('https://postman-echo.com/get', {
				proxy: PROXY_URL,
				signal: controller.signal,
			})
		).rejects.toThrow('Custom abort reason');
	});

	test('AbortSignal: Should abort request during response download', async () => {
		if (!PROXY_URL) return;

		const controller = new AbortController();

		// Start request and abort after 100ms
		const promise = socksFetch('https://postman-echo.com/delay/3', {
			proxy: PROXY_URL,
			signal: controller.signal,
		});

		setTimeout(() => controller.abort(), 100);

		await expect(promise).rejects.toThrow(/abort/i);
	});

	test('DNS Resolution: Should work with resolveDnsLocally=false (default)', async () => {
		if (!PROXY_URL) return;

		const res = await socksFetch('https://postman-echo.com/get', {
			proxy: {
				url: PROXY_URL,
				resolveDnsLocally: false,
			},
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.url).toBe('https://postman-echo.com/get');
	});

	test('DNS Resolution: Should work with resolveDnsLocally=true', async () => {
		if (!PROXY_URL) return;

		const res = await socksFetch('https://postman-echo.com/get', {
			proxy: { url: PROXY_URL, resolveDnsLocally: true },
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.url).toBe('https://postman-echo.com/get');
	});
});
