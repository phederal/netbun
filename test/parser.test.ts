import { describe, expect, test } from "bun:test";
import {
	ChunkedDecoder,
	decodeChunked,
	determineBodyMode,
	parseHttpHead,
} from "../src/fetch";

describe("parseHttpHead", () => {
	test("returns null when terminator not yet present", () => {
		expect(parseHttpHead(Buffer.from("HTTP/1.1 200 OK\r\nX: 1"))).toBeNull();
	});

	test("parses status line + headers", () => {
		const buf = Buffer.from(
			"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Test: yes\r\n\r\nhello",
		);
		const out = parseHttpHead(buf);
		expect(out).not.toBeNull();
		expect(out!.status).toBe(200);
		expect(out!.statusText).toBe("OK");
		expect(out!.headers.get("content-length")).toBe("5");
		expect(out!.headers.get("x-test")).toBe("yes");
		// bodyStart points just past the \r\n\r\n separator
		expect(buf.subarray(out!.bodyStart).toString()).toBe("hello");
	});

	test("multi-word status text preserved", () => {
		const out = parseHttpHead(
			Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n"),
		);
		expect(out!.status).toBe(404);
		expect(out!.statusText).toBe("Not Found");
	});

	test("empty status text", () => {
		const out = parseHttpHead(Buffer.from("HTTP/1.1 204\r\n\r\n"));
		expect(out!.status).toBe(204);
		expect(out!.statusText).toBe("");
	});

	test("repeated headers (e.g. Set-Cookie) are appended", () => {
		const out = parseHttpHead(
			Buffer.from(
				"HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n",
			),
		);
		// Headers stores both; getSetCookie or comma-joined get
		const v = out!.headers.get("set-cookie");
		expect(v).toContain("a=1");
		expect(v).toContain("b=2");
	});
});

describe("determineBodyMode", () => {
	const H = (init: Record<string, string> = {}) => new Headers(init);

	test("HEAD has no body regardless of headers", () => {
		expect(determineBodyMode("HEAD", 200, H({ "content-length": "100" })))
			.toEqual({ mode: "empty" });
	});

	test("204 No Content → empty", () => {
		expect(determineBodyMode("GET", 204, H({ "content-length": "5" })))
			.toEqual({ mode: "empty" });
	});

	test("304 Not Modified → empty", () => {
		expect(determineBodyMode("GET", 304, H({ "content-length": "5" })))
			.toEqual({ mode: "empty" });
	});

	test("1xx informational → empty", () => {
		expect(determineBodyMode("GET", 100, H())).toEqual({ mode: "empty" });
		expect(determineBodyMode("GET", 199, H())).toEqual({ mode: "empty" });
	});

	test("Transfer-Encoding: chunked wins over Content-Length", () => {
		expect(
			determineBodyMode(
				"GET",
				200,
				H({ "transfer-encoding": "chunked", "content-length": "5" }),
			),
		).toEqual({ mode: "chunked" });
	});

	test("Content-Length used when no chunked", () => {
		expect(
			determineBodyMode("GET", 200, H({ "content-length": "42" })),
		).toEqual({ mode: "length", length: 42 });
	});

	test("falls back to close when neither header present", () => {
		expect(determineBodyMode("GET", 200, H())).toEqual({ mode: "close" });
	});

	test("chunked detected only when last token is 'chunked'", () => {
		// per RFC, chunked must be the final transfer-coding
		const out = determineBodyMode(
			"GET",
			200,
			H({ "transfer-encoding": "gzip, chunked" }),
		);
		expect(out).toEqual({ mode: "chunked" });
	});

	test("Content-Length: 0 → length 0 (not empty mode)", () => {
		expect(
			determineBodyMode("GET", 200, H({ "content-length": "0" })),
		).toEqual({ mode: "length", length: 0 });
	});
});

describe("ChunkedDecoder", () => {
	test("simple single chunk", () => {
		const d = new ChunkedDecoder();
		d.feed(Buffer.from("5\r\nhello\r\n0\r\n\r\n"));
		expect(d.done).toBe(true);
		expect(Buffer.from(d.getBody()).toString()).toBe("hello");
	});

	test("multiple chunks", () => {
		const d = new ChunkedDecoder();
		d.feed(Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"));
		expect(d.done).toBe(true);
		expect(Buffer.from(d.getBody()).toString()).toBe("hello world");
	});

	test("split byte-by-byte still parses", () => {
		const data = Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
		const d = new ChunkedDecoder();
		for (let i = 0; i < data.length; i++) {
			d.feed(data.subarray(i, i + 1));
		}
		expect(d.done).toBe(true);
		expect(Buffer.from(d.getBody()).toString()).toBe("hello world");
	});

	test("hex chunk size (uppercase)", () => {
		const d = new ChunkedDecoder();
		const body = "x".repeat(0xab);
		d.feed(Buffer.from(`AB\r\n${body}\r\n0\r\n\r\n`));
		expect(d.done).toBe(true);
		expect(d.getBody().byteLength).toBe(0xab);
	});

	test("zero body (only terminator)", () => {
		const d = new ChunkedDecoder();
		d.feed(Buffer.from("0\r\n\r\n"));
		expect(d.done).toBe(true);
		expect(d.getBody().byteLength).toBe(0);
	});

	test("not done until full terminator received", () => {
		const d = new ChunkedDecoder();
		d.feed(Buffer.from("5\r\nhello\r\n0\r\n"));
		expect(d.done).toBe(false);
		d.feed(Buffer.from("\r\n"));
		expect(d.done).toBe(true);
	});

	test("malformed size throws", () => {
		const d = new ChunkedDecoder();
		expect(() => d.feed(Buffer.from("zzz\r\n"))).toThrow(/bad size/);
	});

	test("missing CRLF after chunk data throws", () => {
		const d = new ChunkedDecoder();
		expect(() => d.feed(Buffer.from("5\r\nhelloXX"))).toThrow(/CR/);
	});

	test("trailing headers are accepted (ignored)", () => {
		const d = new ChunkedDecoder();
		d.feed(
			Buffer.from(
				"5\r\nhello\r\n0\r\nX-Trailer: yes\r\nX-Other: 1\r\n\r\n",
			),
		);
		expect(d.done).toBe(true);
		expect(Buffer.from(d.getBody()).toString()).toBe("hello");
	});
});

describe("decodeChunked (one-shot helper)", () => {
	test("decodes complete body", () => {
		const out = decodeChunked(Buffer.from("5\r\nhello\r\n0\r\n\r\n"));
		expect(Buffer.from(out).toString()).toBe("hello");
	});

	test("returns partial body on malformed input rather than throwing", () => {
		const out = decodeChunked(Buffer.from("5\r\nhello\r\nXX\r\n"));
		// "hello" was successfully extracted before the error
		expect(Buffer.from(out).toString()).toBe("hello");
	});
});
