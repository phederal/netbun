# netbun

[![CI](https://github.com/phederal/netbun/actions/workflows/ci.yml/badge.svg)](https://github.com/phederal/netbun/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/netbun.svg)](https://badge.fury.io/js/netbun)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A high-performance, zero-dependency fetch implementation for [Bun](https://bun.sh) with comprehensive proxy support, including SOCKS5, SOCKS4, HTTP, and HTTPS proxies. Features automatic decompression, redirect handling, connection pooling, and more.

This library extends Bun's native capabilities by providing a drop-in replacement for `fetch` that supports various proxy protocols and advanced networking features not available in the standard implementation.

## Table of Contents

-   [Features](#features)
-   [Installation](#installation)
-   [Usage](#usage)
-   [Examples](#examples)
-   [API](#api)
-   [Configuration](#configuration)
-   [Supported Formats](#supported-formats)
-   [License](#license)

## Features

-   🚀 **Zero Dependencies**: Uses only Bun/Node native modules (`net`, `tls`, `zlib`).
-   🧦 **Comprehensive Proxy Support**: SOCKS5, SOCKS4, HTTP, and HTTPS proxies with automatic fallback.
-   🔒 **SOCKS5 & SOCKS4**: Full handshake with Username/Password authentication (RFC 1928/1929).
-   🌐 **HTTPS/TLS**: Automatic socket upgrade to TLS for secure connections.
-   📦 **Native Fetch API**: Drop-in replacement with identical interface to standard `fetch`.
-   ⚡ **High Performance**: Connection pooling, streaming responses, and optimized parsing.
-   🔄 **Decompression**: Supports gzip, deflate, brotli, and zstd encodings.
-   ↩️ **Redirect Handling**: Full support for follow, manual, and error redirect modes.
-   🔧 **Proxy URL Converter**: Converts between various non-standard proxy formats.
-   🌍 **IPv6 Support**: Full IPv6 address handling in proxy configurations.
-   🛡️ **Security**: Proper header preservation, authentication, and connection management.

## Installation

```bash
bun add netbun
```

## Usage

Import `fetch` from the library and use the `proxy` option in the init object. The library supports various proxy protocols and automatically handles connection details.

```typescript
import { fetch } from 'netbun';

// Use SOCKS5 proxy
const response = await fetch('https://api.example.com', {
  proxy: 'socks5://user:pass@proxy.example.com:1080'
});

// Use HTTP proxy
const response2 = await fetch('https://api.example.com', {
  proxy: 'http://user:pass@proxy.example.com:8080'
});

// No proxy - falls back to native fetch
const response3 = await fetch('https://api.example.com');
```

## Examples

### Basic GET Request

```typescript
import { fetch } from 'netbun';

const response = await fetch('https://api.ipify.org?format=json', {
	proxy: 'socks5://myuser:mypass@127.0.0.1:1080',
});

const data = await response.json();
console.log(data);
```

### POST Request with Custom Headers

```typescript
import { fetch } from 'netbun';

const response = await fetch('https://example.com/api/data', {
	method: 'POST',
	body: JSON.stringify({ key: 'value' }),
	headers: {
		'Content-Type': 'application/json',
		Authorization: 'Bearer token',
	},
	proxy: 'socks5://user:pass@proxy.server.com:1080',
});
```

### Redirect Handling

```typescript
import { fetch } from 'netbun';

// Follow redirects (default)
const response = await fetch('https://httpbin.org/redirect/3', {
	proxy: 'socks5://user:pass@proxy.com:1080'
});

// Error on redirect
try {
	await fetch('https://httpbin.org/redirect/1', {
		proxy: 'socks5://user:pass@proxy.com:1080',
		redirect: 'error'
	});
} catch (error) {
	console.log('Redirect blocked:', error.message);
}
```

### Using Different Proxy Types

```typescript
import { fetch } from 'netbun';

// SOCKS5 proxy
await fetch('https://example.com', { proxy: 'socks5://user:pass@host:1080' });

// SOCKS4 proxy
await fetch('https://example.com', { proxy: 'socks4://host:1080' });

// HTTP proxy
await fetch('https://example.com', { proxy: 'http://user:pass@host:8080' });

// HTTPS proxy
await fetch('https://example.com', { proxy: 'https://user:pass@host:8080' });
```

### Drop-in Replacement

The library falls back to native `fetch` when no proxy is specified, making it safe to use as a global replacement.

```typescript
// Uses proxy
await fetch('https://secret-service.com', { proxy: 'socks5://...' });

// Uses standard connection
await fetch('https://google.com');
```

## API

### `fetch(input: string | URL | Request, init?: RequestInit & { proxy?: string | { url: string; resolveDnsLocally?: boolean } }): Promise<Response>`

An enhanced fetch function with comprehensive proxy support and advanced networking features.

-   **Parameters**:
    -   `input`: The URL, Request object, or string to fetch.
    -   `init`: Optional init object with standard fetch options plus:
        -   `proxy`: Proxy configuration string or object
        -   `redirect`: Redirect handling mode ('follow', 'error', 'manual')
-   **Returns**: A Promise that resolves to a Response object.
-   **Throws**: Errors for invalid proxy URLs, connection failures, or redirect errors.

**Proxy Support**:
-   SOCKS5: `socks5://user:pass@host:port`
-   SOCKS4: `socks4://host:port`
-   HTTP: `http://user:pass@host:port`
-   HTTPS: `https://user:pass@host:port`

If no `proxy` is provided, it falls back to the native `globalThis.fetch`.

### `convert(proxyUrl: string | string[], skipInvalid?: boolean): string | string[]`

Converts proxy URL(s) from various non-standard formats to the standard proxy URL format.

-   **Parameters**:
    -   `proxyUrl`: Single proxy URL string or array of proxy URLs in any supported format.
    -   `skipInvalid`: (Optional) If `true` and array is passed, skips invalid URLs instead of throwing errors. Default: `false`.
-   **Returns**: Standard proxy URL(s) in format `protocol://[user:pass@]host:port`.
-   **Throws**: Error if the proxy URL format is invalid (unless `skipInvalid` is `true` for arrays).

See [Supported Formats](#supported-formats) for detailed examples.

## Configuration

### Proxy URL Formats

The library supports various proxy protocols and authentication methods:

#### SOCKS5
-   **No Auth**: `socks5://127.0.0.1:9050`
-   **With Auth**: `socks5://user:password@proxy.example.com:1080`
-   **IPv6**: `socks5://user:password@[2001:db8::1]:1080`

#### SOCKS4
-   **Basic**: `socks4://proxy.example.com:1080`

#### HTTP/HTTPS
-   **No Auth**: `http://proxy.example.com:8080`
-   **With Auth**: `https://user:password@proxy.example.com:8080`

### Environment Variables

The library also respects standard proxy environment variables:
-   `SOCKS5_PROXY`
-   `SOCKS_PROXY`
-   `HTTP_PROXY`
-   `HTTPS_PROXY`

#### SOCKS4
-   **Basic**: `socks4://proxy.example.com:1080`

#### HTTP/HTTPS
-   **No Auth**: `http://proxy.example.com:8080`
-   **With Auth**: `https://user:password@proxy.example.com:8080`

### Environment Variables

The library also respects standard proxy environment variables:
-   `SOCKS5_PROXY`
-   `SOCKS_PROXY`
-   `HTTP_PROXY`
-   `HTTPS_PROXY`

## Supported Formats

The `convert` function supports various non-standard proxy URL formats for maximum compatibility:

-   **Standard**: `protocol://[user:pass@]host:port`
-   **Colon-separated**: `protocol://host:port:username:password`
-   **Inverted**: `protocol://host:port@user:pass`
-   **Without protocol**: `host:port:username:password` (defaults to `socks5`)
-   **IPv6**: `[2001:db8::1]:1080` or `socks5://[2001:db8::1]:1080`

**Supported protocols**: `socks5`, `socks4`, `http`, `https`

```typescript
import { convert } from 'netbun';

// Convert various formats
convert('proxy.example.com:1080:user:pass')
// => 'socks5://user:pass@proxy.example.com:1080'

convert('socks5://proxy.com:1080@admin:secret')
// => 'socks5://admin:secret@proxy.com:1080'

convert('[2001:db8::1]:1080:user:pass')
// => 'socks5://user:pass@[2001:db8::1]:1080'
```

## License

MIT
