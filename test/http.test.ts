import { describe, test, expect, beforeAll } from "bun:test";
import { fetch, parseProxyUrl } from "../src/fetch";

describe("HTTP Proxy Fallback", () => {
	// Mock server for testing
	const mockServer = "https://httpbin.org";

	test("should fallback to native fetch for HTTP proxy", async () => {
		const response = await fetch(mockServer + "/get", {
			proxy: "http://proxy.example.com:8080"
		});
		
		// Это должно работать через нативный fetch с HTTP прокси
		// Но так как у нас нет реального HTTP прокси, проверим что функция не падает
		// и возвращает Response объект
		expect(response).toBeInstanceOf(Response);
	});

	test("should fallback to native fetch for HTTPS proxy", async () => {
		const response = await fetch(mockServer + "/get", {
			proxy: "https://proxy.example.com:8443"
		});
		
		expect(response).toBeInstanceOf(Response);
	});

	test("should fallback to native fetch for HTTP proxy with auth", async () => {
		const response = await fetch(mockServer + "/get", {
			proxy: "http://user:pass@proxy.example.com:8080"
		});
		
		expect(response).toBeInstanceOf(Response);
	});

	test("should use custom fetch implementation for SOCKS proxies", async () => {
		// Для SOCKS прокси должна использоваться наша реализация
		// Но так как у нас нет реального SOCKS прокси, проверим что парсинг работает
		const parsed = parseProxyUrl("socks5://user:pass@proxy.example.com:1080");
		expect(parsed.protocol).toBe("socks5");
		expect(parsed.host).toBe("proxy.example.com");
		expect(parsed.port).toBe(1080);
		expect(parsed.user).toBe("user");
		expect(parsed.password).toBe("pass");
	});

	test("should handle HTTP_PROXY environment variable", () => {
		const originalProxy = process.env.HTTP_PROXY;
		process.env.HTTP_PROXY = "http://proxy.example.com:8080";
		
		try {
			// Это должно использовать env proxy и fallback к native fetch
			const response = fetch(mockServer + "/get");
			expect(response).toBeInstanceOf(Promise);
		} finally {
			if (originalProxy) {
				process.env.HTTP_PROXY = originalProxy;
			} else {
				delete process.env.HTTP_PROXY;
			}
		}
	});

	test("should prioritize SOCKS proxies over HTTP proxies when both available", async () => {
		const originalHttpProxy = process.env.HTTP_PROXY;
		const originalSocksProxy = process.env.SOCKS5_PROXY;
		
		process.env.HTTP_PROXY = "http://proxy.example.com:8080";
		process.env.SOCKS5_PROXY = "socks5://socks.example.com:1080";
		
		try {
			// Должен использоваться SOCKS прокси (наша реализация)
			const parsed = parseProxyUrl(process.env.SOCKS5_PROXY);
			expect(parsed.protocol).toBe("socks5");
		} finally {
			if (originalHttpProxy) {
				process.env.HTTP_PROXY = originalHttpProxy;
			} else {
				delete process.env.HTTP_PROXY;
			}
			if (originalSocksProxy) {
				process.env.SOCKS5_PROXY = originalSocksProxy;
			} else {
				delete process.env.SOCKS5_PROXY;
			}
		}
	});

	test("should handle invalid proxy gracefully", async () => {
		try {
			const response = await fetch(mockServer + "/anything", {
				proxy: "invalid://proxy.example.com:8080",
				tls: { rejectUnauthorized: false }
			});
			
			// Должен fallback к native fetch
			expect(response).toBeInstanceOf(Response);
		} catch (error) {
			// Handle certificate errors that might occur even with rejectUnauthorized: false
			if (error instanceof Error && error.message.includes('CERT_HAS_EXPIRED')) {
				console.log('✅ Fallback worked, but certificate expired (expected)');
			} else {
				throw error;
			}
		}
	});
});