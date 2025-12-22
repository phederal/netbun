import { describe, expect, test } from "bun:test";
import { convert, convertLine } from "../src/convert";

describe("convert", () => {
	describe("Single string input - SOCKS5", () => {
		test("should convert colon-separated format without auth", () => {
			expect(convert("proxy.example.com:1080")).toBe(
				"socks5://proxy.example.com:1080",
			);
		});

		test("should convert colon-separated format with auth", () => {
			expect(convert("proxy.example.com:1080:user:pass")).toBe(
				"socks5://user:pass@proxy.example.com:1080",
			);
		});

		test("should convert format with protocol prefix without auth", () => {
			expect(convert("socks5://proxy.example.com:1080")).toBe(
				"socks5://proxy.example.com:1080",
			);
		});

		test("should convert format with protocol prefix with auth", () => {
			expect(convert("socks5://proxy.example.com:1080:user:pass")).toBe(
				"socks5://user:pass@proxy.example.com:1080",
			);
		});

		test("should return standard format as-is", () => {
			const standardUrl = "socks5://user:pass@proxy.example.com:1080";
			expect(convert(standardUrl)).toBe(standardUrl);
		});

		test("should return standard format without auth as-is", () => {
			const standardUrl = "socks5://proxy.example.com:1080";
			expect(convert(standardUrl)).toBe(standardUrl);
		});

		test("should convert inverted format (host:port@user:pass)", () => {
			expect(convert("socks5://proxy.example.com:1080@user:pass")).toBe(
				"socks5://user:pass@proxy.example.com:1080",
			);
		});

		test("should convert inverted format with special chars in password", () => {
			expect(convert("socks5://proxy.example.com:1080@user:p@ss#123")).toBe(
				"socks5://user:p%40ss%23123@proxy.example.com:1080",
			);
		});

		test("should handle special characters in credentials", () => {
			expect(convert("proxy.example.com:1080:user@mail:p@ss!word")).toBe(
				"socks5://user%40mail:p%40ss!word@proxy.example.com:1080",
			);
		});

		test("should handle URL-encoded characters in credentials", () => {
			expect(convert("proxy.example.com:1080:user%40:pass%21")).toBe(
				"socks5://user%2540:pass%2521@proxy.example.com:1080",
			);
		});

		test("should handle Unicode characters in credentials", () => {
			expect(convert("proxy.example.com:1080:юзер:пароль")).toBe(
				"socks5://%D1%8E%D0%B7%D0%B5%D1%80:%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C@proxy.example.com:1080",
			);
		});

		test("should handle empty password", () => {
			expect(convert("proxy.example.com:1080:user:")).toBe(
				"socks5://user:@proxy.example.com:1080",
			);
		});

		test("should handle IP address", () => {
			expect(convert("192.168.1.1:1080")).toBe("socks5://192.168.1.1:1080");
		});

		test("should handle IP address with auth", () => {
			expect(convert("192.168.1.1:1080:admin:secret")).toBe(
				"socks5://admin:secret@192.168.1.1:1080",
			);
		});

		test("should handle localhost", () => {
			expect(convert("localhost:1080")).toBe("socks5://localhost:1080");
		});

		test("should handle different valid ports", () => {
			expect(convert("proxy.example.com:1")).toBe(
				"socks5://proxy.example.com:1",
			);
			expect(convert("proxy.example.com:65535")).toBe(
				"socks5://proxy.example.com:65535",
			);
			expect(convert("proxy.example.com:8080")).toBe(
				"socks5://proxy.example.com:8080",
			);
		});

		test("should not encode already safe characters in credentials", () => {
			const result = convert("proxy.example.com:1080:user-name_123:pass.word");
			expect(result).toBe(
				"socks5://user-name_123:pass.word@proxy.example.com:1080",
			);
			// Ensure no unnecessary encoding happened
			expect(result).not.toContain("%");
		});

		test("should handle mixed safe and unsafe characters", () => {
			const result = convert("proxy.example.com:1080:user_name:pass@123");
			expect(result).toBe(
				"socks5://user_name:pass%40123@proxy.example.com:1080",
			);
		});

		test("should handle password with slash", () => {
			expect(convert("proxy.example.com:1080:user:pass/word")).toBe(
				"socks5://user:pass%2Fword@proxy.example.com:1080",
			);
		});

		test("should handle password with backslash", () => {
			expect(convert("proxy.example.com:1080:user:pass\\word")).toBe(
				"socks5://user:pass%5Cword@proxy.example.com:1080",
			);
		});

		test("should handle password with question mark", () => {
			expect(convert("proxy.example.com:1080:user:pass?word")).toBe(
				"socks5://user:pass%3Fword@proxy.example.com:1080",
			);
		});

		test("should handle password with hash/pound sign", () => {
			expect(convert("proxy.example.com:1080:user:pass#123")).toBe(
				"socks5://user:pass%23123@proxy.example.com:1080",
			);
		});

		test("should handle password with ampersand", () => {
			expect(convert("proxy.example.com:1080:user:pass&word")).toBe(
				"socks5://user:pass%26word@proxy.example.com:1080",
			);
		});

		test("should handle password with equals sign", () => {
			expect(convert("proxy.example.com:1080:user:pass=123")).toBe(
				"socks5://user:pass%3D123@proxy.example.com:1080",
			);
		});

		test("should handle password with percent sign", () => {
			expect(convert("proxy.example.com:1080:user:pass%word")).toBe(
				"socks5://user:pass%25word@proxy.example.com:1080",
			);
		});

		test("should handle password with spaces", () => {
			expect(convert("proxy.example.com:1080:user:pass word")).toBe(
				"socks5://user:pass%20word@proxy.example.com:1080",
			);
		});

		test("should handle password with plus sign", () => {
			expect(convert("proxy.example.com:1080:user:pass+word")).toBe(
				"socks5://user:pass%2Bword@proxy.example.com:1080",
			);
		});

		test("should handle password with brackets", () => {
			expect(convert("proxy.example.com:1080:user:pass[123]")).toBe(
				"socks5://user:pass%5B123%5D@proxy.example.com:1080",
			);
		});

		test("should handle password with curly braces", () => {
			expect(convert("proxy.example.com:1080:user:pass{123}")).toBe(
				"socks5://user:pass%7B123%7D@proxy.example.com:1080",
			);
		});

		test("should handle password with pipe", () => {
			expect(convert("proxy.example.com:1080:user:pass|word")).toBe(
				"socks5://user:pass%7Cword@proxy.example.com:1080",
			);
		});

		test("should handle password with quotes", () => {
			expect(convert("proxy.example.com:1080:user:pass\"word'test")).toBe(
				"socks5://user:pass%22word'test@proxy.example.com:1080",
			);
		});

		test("should handle password with less/greater than", () => {
			expect(convert("proxy.example.com:1080:user:pass<123>")).toBe(
				"socks5://user:pass%3C123%3E@proxy.example.com:1080",
			);
		});

		test("should handle password with semicolon", () => {
			expect(convert("proxy.example.com:1080:user:pass;word")).toBe(
				"socks5://user:pass%3Bword@proxy.example.com:1080",
			);
		});

		test("should handle password with comma", () => {
			expect(convert("proxy.example.com:1080:user:pass,word")).toBe(
				"socks5://user:pass%2Cword@proxy.example.com:1080",
			);
		});

		test("should handle password with caret", () => {
			expect(convert("proxy.example.com:1080:user:pass^word")).toBe(
				"socks5://user:pass%5Eword@proxy.example.com:1080",
			);
		});

		test("should handle password with backtick", () => {
			expect(convert("proxy.example.com:1080:user:pass`word")).toBe(
				"socks5://user:pass%60word@proxy.example.com:1080",
			);
		});

		test("should handle complex password with multiple special chars", () => {
			expect(
				convert("proxy.example.com:1080:admin:P@$$w0rd!#123<>{}[]"),
			).toBe(
				"socks5://admin:P%40%24%24w0rd!%23123%3C%3E%7B%7D%5B%5D@proxy.example.com:1080",
			);
		});

		test("should handle password with emoji", () => {
			expect(convert("proxy.example.com:1080:user:pass🔥word")).toBe(
				"socks5://user:pass%F0%9F%94%A5word@proxy.example.com:1080",
			);
		});

		test("should handle username with special chars too", () => {
			expect(convert("proxy.example.com:1080:user@domain.com:pass#123")).toBe(
				"socks5://user%40domain.com:pass%23123@proxy.example.com:1080",
			);
		});

		test("should handle both username and password with Chinese characters", () => {
			expect(convert("proxy.example.com:1080:用户:密码")).toBe(
				"socks5://%E7%94%A8%E6%88%B7:%E5%AF%86%E7%A0%81@proxy.example.com:1080",
			);
		});

		test("should handle password with Arabic characters", () => {
			expect(convert("proxy.example.com:1080:user:كلمةالسر")).toBe(
				"socks5://user:%D9%83%D9%84%D9%85%D8%A9%D8%A7%D9%84%D8%B3%D8%B1@proxy.example.com:1080",
			);
		});

		test("should handle password with all URL-reserved characters", () => {
			// Reserved chars: :/?#[]@!$&'()*+,;=
			expect(
				convert("proxy.example.com:1080:user:!$&'()*+,;=/?#[]"),
			).toBe(
				"socks5://user:!%24%26'()*%2B%2C%3B%3D%2F%3F%23%5B%5D@proxy.example.com:1080",
			);
		});
	});

	describe("Single string input - SOCKS4", () => {
		test("should handle socks4 proxy without auth", () => {
			expect(convert("socks4://proxy.example.com:1080")).toBe(
				"socks4://proxy.example.com:1080",
			);
		});

		test("should handle socks4 proxy with colon-separated auth", () => {
			expect(convert("socks4://proxy.example.com:1080:user:pass")).toBe(
				"socks4://user:pass@proxy.example.com:1080",
			);
		});

		test("should handle socks4 proxy with standard auth format", () => {
			const url = "socks4://user:pass@proxy.example.com:1080";
			expect(convert(url)).toBe(url);
		});

		test("should convert socks4 inverted format", () => {
			expect(convert("socks4://proxy.example.com:1080@user:pass")).toBe(
				"socks4://user:pass@proxy.example.com:1080",
			);
		});

		test("should handle socks4 proxy with special chars in password", () => {
			expect(convert("socks4://proxy.example.com:1080:user:p@ss#123")).toBe(
				"socks4://user:p%40ss%23123@proxy.example.com:1080",
			);
		});

		test("should handle socks4 proxy with IP address", () => {
			expect(convert("socks4://192.168.1.1:1080")).toBe(
				"socks4://192.168.1.1:1080",
			);
		});
	});

	describe("Single string input - HTTP/HTTPS", () => {
		test("should handle http proxy without auth", () => {
			expect(convert("http://proxy.example.com:8080")).toBe(
				"http://proxy.example.com:8080",
			);
		});

		test("should handle http proxy with colon-separated auth", () => {
			expect(convert("http://proxy.example.com:8080:user:pass")).toBe(
				"http://user:pass@proxy.example.com:8080",
			);
		});

		test("should handle http proxy with standard auth format", () => {
			const url = "http://user:pass@proxy.example.com:8080";
			expect(convert(url)).toBe(url);
		});

		test("should handle https proxy without auth", () => {
			expect(convert("https://proxy.example.com:8443")).toBe(
				"https://proxy.example.com:8443",
			);
		});

		test("should handle https proxy with colon-separated auth", () => {
			expect(convert("https://proxy.example.com:8443:admin:secret")).toBe(
				"https://admin:secret@proxy.example.com:8443",
			);
		});

		test("should handle https proxy with standard auth format", () => {
			const url = "https://admin:secret@proxy.example.com:8443";
			expect(convert(url)).toBe(url);
		});

		test("should handle http proxy with special chars in password", () => {
			expect(convert("http://proxy.example.com:8080:user:p@ss#123")).toBe(
				"http://user:p%40ss%23123@proxy.example.com:8080",
			);
		});

		test("should handle https proxy with Unicode password", () => {
			expect(convert("https://proxy.example.com:8443:user:密码")).toBe(
				"https://user:%E5%AF%86%E7%A0%81@proxy.example.com:8443",
			);
		});

		test("should handle http proxy with IP address", () => {
			expect(convert("http://192.168.1.1:3128")).toBe(
				"http://192.168.1.1:3128",
			);
		});

		test("should handle http proxy with IP and auth", () => {
			expect(convert("http://192.168.1.1:3128:proxy:password")).toBe(
				"http://proxy:password@192.168.1.1:3128",
			);
		});

		test("should handle common http proxy ports", () => {
			expect(convert("http://proxy.example.com:3128")).toBe(
				"http://proxy.example.com:3128",
			);
			expect(convert("http://proxy.example.com:8888")).toBe(
				"http://proxy.example.com:8888",
			);
		});

		test("should handle https proxy with complex password", () => {
			expect(
				convert("https://proxy.example.com:8443:admin:P@$$w0rd!#<>"),
			).toBe(
				"https://admin:P%40%24%24w0rd!%23%3C%3E@proxy.example.com:8443",
			);
		});

		test("should convert http inverted format", () => {
			expect(convert("http://proxy.example.com:8080@admin:secret")).toBe(
				"http://admin:secret@proxy.example.com:8080",
			);
		});

		test("should convert https inverted format", () => {
			expect(convert("https://proxy.example.com:8443@test:p@ss")).toBe(
				"https://test:p%40ss@proxy.example.com:8443",
			);
		});
	});

	describe("IPv6 addresses", () => {
		test("should handle IPv6 address without auth", () => {
			expect(convert("socks5://[2001:db8::1]:1080")).toBe(
				"socks5://[2001:db8::1]:1080",
			);
		});

		test("should handle IPv6 address with auth", () => {
			expect(convert("socks5://user:pass@[2001:db8::1]:1080")).toBe(
				"socks5://user:pass@[2001:db8::1]:1080",
			);
		});

		test("should handle IPv6 localhost", () => {
			expect(convert("http://[::1]:8080")).toBe("http://[::1]:8080");
		});

		test("should handle IPv6 with colon-separated auth", () => {
			expect(convert("socks5://[2001:db8::1]:1080:user:pass")).toBe(
				"socks5://user:pass@[2001:db8::1]:1080",
			);
		});

		test("should handle IPv6 inverted format", () => {
			expect(convert("socks5://[2001:db8::1]:1080@user:pass")).toBe(
				"socks5://user:pass@[2001:db8::1]:1080",
			);
		});

		test("should handle IPv6 without protocol", () => {
			expect(convert("[2001:db8::1]:1080:user:pass")).toBe(
				"socks5://user:pass@[2001:db8::1]:1080",
			);
		});

		test("should handle IPv6 without protocol and auth", () => {
			expect(convert("[::1]:1080")).toBe("socks5://[::1]:1080");
		});

		test("should handle IPv6 with special chars in password", () => {
			expect(convert("socks5://[2001:db8::1]:1080:user:p@ss#123")).toBe(
				"socks5://user:p%40ss%23123@[2001:db8::1]:1080",
			);
		});

		test("should handle http proxy with IPv6", () => {
			expect(convert("http://admin:secret@[::1]:3128")).toBe(
				"http://admin:secret@[::1]:3128",
			);
		});
	});

	describe("Array input", () => {
		test("should convert array of URLs", () => {
			const input = [
				"proxy1.example.com:1080",
				"proxy2.example.com:1080:user:pass",
			];
			const expected = [
				"socks5://proxy1.example.com:1080",
				"socks5://user:pass@proxy2.example.com:1080",
			];
			expect(convert(input)).toEqual(expected);
		});

		test("should convert mixed format array", () => {
			const input = [
				"proxy1.example.com:1080",
				"socks5://proxy2.example.com:1080",
				"proxy3.example.com:1080:admin:secret",
				"socks5://user:pass@proxy4.example.com:1080",
			];
			const expected = [
				"socks5://proxy1.example.com:1080",
				"socks5://proxy2.example.com:1080",
				"socks5://admin:secret@proxy3.example.com:1080",
				"socks5://user:pass@proxy4.example.com:1080",
			];
			expect(convert(input)).toEqual(expected);
		});

		test("should throw on invalid URL in array by default", () => {
			const input = ["proxy1.example.com:1080", "invalid"];
			expect(() => convert(input)).toThrow();
		});

		test("should skip invalid URLs with skipInvalid flag", () => {
			const input = [
				"proxy1.example.com:1080",
				"invalid",
				"proxy2.example.com:1080:user:pass",
			];
			const expected = [
				"socks5://proxy1.example.com:1080",
				"socks5://user:pass@proxy2.example.com:1080",
			];
			expect(convert(input, true)).toEqual(expected);
		});

		test("should handle empty array", () => {
			expect(convert([])).toEqual([]);
		});

		test("should handle large array efficiently", () => {
			const input = Array.from(
				{ length: 1000 },
				(_, i) => `proxy${i}.example.com:1080`,
			);
			const result = convert(input);
			expect(result.length).toBe(1000);
			expect(result[0]).toBe("socks5://proxy0.example.com:1080");
			expect(result[999]).toBe("socks5://proxy999.example.com:1080");
		});
	});

	describe("Error handling", () => {
		test("should throw on empty string", () => {
			expect(() => convert("")).toThrow("Proxy URL cannot be empty");
		});

		test("should throw on invalid port (too low)", () => {
			expect(() => convert("proxy.example.com:0")).toThrow("Invalid port");
		});

		test("should throw on invalid port (too high)", () => {
			expect(() => convert("proxy.example.com:65536")).toThrow("Invalid port");
		});

		test("should throw on invalid port (not a number)", () => {
			expect(() => convert("proxy.example.com:abc")).toThrow("Invalid port");
		});

		test("should throw on missing port", () => {
			expect(() => convert("proxy.example.com")).toThrow(
				"Invalid proxy format",
			);
		});

		test("should throw on unsupported protocol", () => {
			expect(() => convert("ftp://proxy.example.com:1080")).toThrow(
				"Unsupported proxy protocol: ftp",
			);
		});

		test("should throw on wrong number of colons (2 colons)", () => {
			expect(() => convert("proxy.example.com:1080:user")).toThrow(
				"Expected 1 or 3 colons",
			);
		});

		test("should throw on wrong number of colons (4+ colons)", () => {
			expect(() => convert("proxy.example.com:1080:user:pass:extra")).toThrow(
				"Expected 1 or 3 colons",
			);
		});

		test("should throw on empty username with password", () => {
			expect(() => convert("proxy.example.com:1080::password")).toThrow(
				"Username cannot be empty",
			);
		});

		test("should throw on negative port", () => {
			expect(() => convert("proxy.example.com:-1")).toThrow("Invalid port");
		});
	});

	describe("Edge cases", () => {
		test("should handle very long hostname", () => {
			const longHost = "a".repeat(253); // Max valid DNS hostname length
			expect(convert(`${longHost}:1080`)).toBe(`socks5://${longHost}:1080`);
		});

		test("should handle very long credentials", () => {
			const longUser = "u".repeat(100);
			const longPass = "p".repeat(100);
			expect(convert(`proxy.example.com:1080:${longUser}:${longPass}`)).toBe(
				`socks5://${longUser}:${longPass}@proxy.example.com:1080`,
			);
		});

		test("should handle subdomain with many levels", () => {
			expect(convert("proxy.sub1.sub2.sub3.example.com:1080")).toBe(
				"socks5://proxy.sub1.sub2.sub3.example.com:1080",
			);
		});

		test("should handle numeric hostname", () => {
			expect(convert("123:1080")).toBe("socks5://123:1080");
		});

		test("should handle hostname with hyphens", () => {
			expect(convert("proxy-server-1.example-domain.com:1080")).toBe(
				"socks5://proxy-server-1.example-domain.com:1080",
			);
		});

		test("should handle standard format with port in hostname position", () => {
			const url = "socks5://user:pass@proxy.example.com:1080";
			expect(convert(url)).toBe(url);
		});
	});

	describe("Performance optimization verification", () => {
		test("should handle standard format without unnecessary parsing", () => {
			// This should use fast-path and return immediately
			const standardUrl = "socks5://user:pass@proxy.example.com:1080";
			const start = performance.now();
			const result = convert(standardUrl);
			const duration = performance.now() - start;

			expect(result).toBe(standardUrl);
			// Fast path should be extremely quick (< 1ms even on slow machines)
			expect(duration).toBeLessThan(1);
		});

		test("should efficiently process large batch", () => {
			const input = Array.from(
				{ length: 10000 },
				(_, i) => `proxy${i}.example.com:1080:user${i}:pass${i}`,
			);

			const start = performance.now();
			const result = convert(input);
			const duration = performance.now() - start;

			expect(result.length).toBe(10000);
			// Should process 10k proxies in reasonable time (< 100ms on modern hardware)
			expect(duration).toBeLessThan(100);
		});

		test("should not encode when unnecessary", () => {
			// Characters that don't need encoding: A-Za-z0-9._~-
			const safeChars = "ABCabc123._~-";
			const result = convert(`proxy.example.com:1080:${safeChars}:${safeChars}`);

			expect(result).toBe(
				`socks5://${safeChars}:${safeChars}@proxy.example.com:1080`,
			);
			expect(result).not.toContain("%");
		});
	});

	describe("convertLine function", () => {
		test("should export and work independently", () => {
			expect(convertLine("proxy.example.com:1080")).toBe(
				"socks5://proxy.example.com:1080",
			);
		});

		test("should handle auth credentials", () => {
			expect(convertLine("proxy.example.com:1080:user:pass")).toBe(
				"socks5://user:pass@proxy.example.com:1080",
			);
		});

		test("should throw on invalid input", () => {
			expect(() => convertLine("")).toThrow();
			expect(() => convertLine("invalid")).toThrow();
		});
	});

	describe("Real-world scenarios", () => {
		test("should handle common proxy list formats", () => {
			const commonFormats = [
				"192.168.1.1:1080",
				"proxy.example.com:1080",
				"socks5://proxy.example.com:1080",
				"proxy.example.com:1080:username:password",
				"socks5://username:password@proxy.example.com:1080",
				"http://proxy.example.com:8080",
				"https://proxy.example.com:8443:user:pass",
			];

			const results = convert(commonFormats);
			expect(results).toEqual([
				"socks5://192.168.1.1:1080",
				"socks5://proxy.example.com:1080",
				"socks5://proxy.example.com:1080",
				"socks5://username:password@proxy.example.com:1080",
				"socks5://username:password@proxy.example.com:1080",
				"http://proxy.example.com:8080",
				"https://user:pass@proxy.example.com:8443",
			]);
		});

		test("should handle proxy list with special chars in password", () => {
			const input = [
				"proxy1.com:1080:user:p@ssw0rd!",
				"proxy2.com:1080:admin:test#123",
				"proxy3.com:1080:root:a&b=c",
			];

			const results = convert(input);
			expect(results[0]).toContain("p%40ssw0rd!");
			expect(results[1]).toContain("test%23123");
			expect(results[2]).toContain("a%26b%3Dc");
		});

		test("should handle mixed valid and invalid proxies with skipInvalid", () => {
			const input = [
				"proxy1.com:1080",
				"", // invalid: empty
				"proxy2.com:1080:user:pass",
				"proxy3.com", // invalid: no port
				"ftp://proxy4.com:1080", // invalid: unsupported protocol
				"proxy5.com:1080",
				"http://proxy6.com:8080",
			];

			const results = convert(input, true);
			expect(results).toEqual([
				"socks5://proxy1.com:1080",
				"socks5://user:pass@proxy2.com:1080",
				"socks5://proxy5.com:1080",
				"http://proxy6.com:8080",
			]);
		});

		test("should handle mixed protocols in array", () => {
			const input = [
				"socks5://proxy1.com:1080:user:pass",
				"http://proxy2.com:8080:admin:secret",
				"https://proxy3.com:8443",
				"proxy4.com:1080", // defaults to socks5
			];

			const results = convert(input);
			expect(results).toEqual([
				"socks5://user:pass@proxy1.com:1080",
				"http://admin:secret@proxy2.com:8080",
				"https://proxy3.com:8443",
				"socks5://proxy4.com:1080",
			]);
		});
	});
});
