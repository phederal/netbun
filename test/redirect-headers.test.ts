import { describe, expect, test } from "bun:test";
import {
	buildRedirectHeaders,
	resolveRedirectHeaders,
} from "../src/fetch";

describe("buildRedirectHeaders", () => {
	const origin = new URL("https://orig.example.com/page?a=1");

	describe("cross-origin redirect", () => {
		test("strips authorization", () => {
			const out = buildRedirectHeaders(
				{ authorization: "Bearer secret-token" },
				origin,
				true,
			);
			expect(out.get("authorization")).toBeNull();
		});

		test("strips cookie", () => {
			const out = buildRedirectHeaders(
				{ cookie: "sid=abc; user=joe" },
				origin,
				true,
			);
			expect(out.get("cookie")).toBeNull();
		});

		test("PRESERVES proxy-authorization (proxy is reused across redirects)", () => {
			const out = buildRedirectHeaders(
				{ "proxy-authorization": "Basic dXNlcjpwYXNz" },
				origin,
				true,
			);
			expect(out.get("proxy-authorization")).toBe("Basic dXNlcjpwYXNz");
		});

		test("strips authorization but keeps proxy-authorization in same call", () => {
			const out = buildRedirectHeaders(
				{
					authorization: "Bearer secret",
					cookie: "sid=abc",
					"proxy-authorization": "Basic creds",
					"x-trace": "keep-me",
				},
				origin,
				true,
			);
			expect(out.get("authorization")).toBeNull();
			expect(out.get("cookie")).toBeNull();
			expect(out.get("proxy-authorization")).toBe("Basic creds");
			expect(out.get("x-trace")).toBe("keep-me");
		});

		test("sets referer to original URL when missing", () => {
			const out = buildRedirectHeaders({}, origin, true);
			expect(out.get("referer")).toBe(origin.href);
		});

		test("does not overwrite explicit referer", () => {
			const out = buildRedirectHeaders(
				{ referer: "https://custom.example/" },
				origin,
				true,
			);
			expect(out.get("referer")).toBe("https://custom.example/");
		});

		test("case-insensitive header matching for stripping", () => {
			const out = buildRedirectHeaders(
				{
					Authorization: "Bearer x",
					Cookie: "sid=1",
					"Proxy-Authorization": "Basic y",
				},
				origin,
				true,
			);
			expect(out.get("authorization")).toBeNull();
			expect(out.get("cookie")).toBeNull();
			expect(out.get("proxy-authorization")).toBe("Basic y");
		});
	});

	describe("same-origin redirect", () => {
		test("preserves authorization", () => {
			const out = buildRedirectHeaders(
				{ authorization: "Bearer secret" },
				origin,
				false,
			);
			expect(out.get("authorization")).toBe("Bearer secret");
		});

		test("preserves cookie", () => {
			const out = buildRedirectHeaders(
				{ cookie: "sid=abc" },
				origin,
				false,
			);
			expect(out.get("cookie")).toBe("sid=abc");
		});

		test("preserves proxy-authorization", () => {
			const out = buildRedirectHeaders(
				{ "proxy-authorization": "Basic creds" },
				origin,
				false,
			);
			expect(out.get("proxy-authorization")).toBe("Basic creds");
		});

		test("still sets referer", () => {
			const out = buildRedirectHeaders({}, origin, false);
			expect(out.get("referer")).toBe(origin.href);
		});
	});

	describe("resolveRedirectHeaders — Request input", () => {
		test("strips Authorization from Request when init.headers omitted (cross-origin)", () => {
			const req = new Request("https://orig.example.com/", {
				headers: {
					authorization: "Bearer leak-me",
					cookie: "sid=secret",
				},
			});
			const out = resolveRedirectHeaders(req, undefined, origin, true);
			expect(out.get("authorization")).toBeNull();
			expect(out.get("cookie")).toBeNull();
		});

		test("preserves proxy-authorization from Request input on cross-origin", () => {
			const req = new Request("https://orig.example.com/", {
				headers: { "proxy-authorization": "Basic xxx" },
			});
			const out = resolveRedirectHeaders(req, undefined, origin, true);
			expect(out.get("proxy-authorization")).toBe("Basic xxx");
		});

		test("preserves Authorization from Request on same-origin redirect", () => {
			const req = new Request("https://orig.example.com/", {
				headers: { authorization: "Bearer keep-me" },
			});
			const out = resolveRedirectHeaders(req, undefined, origin, false);
			expect(out.get("authorization")).toBe("Bearer keep-me");
		});

		test("init.headers takes precedence over Request headers (Fetch spec)", () => {
			const req = new Request("https://orig.example.com/", {
				headers: { authorization: "Bearer from-request" },
			});
			// init.headers is provided — its set replaces Request's
			const out = resolveRedirectHeaders(
				req,
				{ headers: { "x-other": "from-init" } },
				origin,
				true,
			);
			// Request's authorization is NOT carried (init.headers wins)
			expect(out.get("authorization")).toBeNull();
			expect(out.get("x-other")).toBe("from-init");
		});

		test("string input + init.headers behaves as before", () => {
			const out = resolveRedirectHeaders(
				"https://orig.example.com/",
				{ headers: { authorization: "Bearer x" } },
				origin,
				true,
			);
			expect(out.get("authorization")).toBeNull();
		});

		test("string input + no headers → only referer is set", () => {
			const out = resolveRedirectHeaders(
				"https://orig.example.com/",
				undefined,
				origin,
				true,
			);
			expect([...out.keys()]).toEqual(["referer"]);
			expect(out.get("referer")).toBe(origin.href);
		});
	});

	describe("input source variants", () => {
		test("accepts Headers instance", () => {
			const src = new Headers({
				authorization: "Bearer x",
				"proxy-authorization": "Basic y",
			});
			const out = buildRedirectHeaders(src, origin, true);
			expect(out.get("authorization")).toBeNull();
			expect(out.get("proxy-authorization")).toBe("Basic y");
		});

		test("accepts array-of-pairs", () => {
			const out = buildRedirectHeaders(
				[
					["authorization", "Bearer x"],
					["proxy-authorization", "Basic y"],
				],
				origin,
				true,
			);
			expect(out.get("authorization")).toBeNull();
			expect(out.get("proxy-authorization")).toBe("Basic y");
		});

		test("accepts undefined", () => {
			const out = buildRedirectHeaders(undefined, origin, true);
			expect(out.get("referer")).toBe(origin.href);
		});
	});
});
