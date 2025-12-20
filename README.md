# bun-socks

[![CI](https://github.com/phederal/bunsocks/actions/workflows/ci.yml/badge.svg)](https://github.com/phederal/bunsocks/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/bun-socks.svg)](https://badge.fury.io/js/bun-socks)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A lightweight, zero-dependency SOCKS5 proxy client specifically designed for [Bun](https://bun.sh).

While Bun's native `fetch` supports HTTP proxies, it does not currently support SOCKS5. This library bridges that gap by implementing a custom `fetch` wrapper that handles SOCKS5 handshakes (RFC 1928) and manually upgrades sockets to TLS for HTTPS requests.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [API](#api)
- [Configuration](#configuration)
- [License](#license)

## Features

- 🚀 **Zero Dependencies**: Uses Bun/Node native `net` and `tls` modules.
- 🔒 **SOCKS5 Support**: Full handshake with Username/Password authentication (RFC 1929).
- 🌐 **HTTPS Support**: Manually upgrades raw TCP sockets to TLS for secure connections.
- 📦 **Native Experience**: API mimics the standard `fetch` exactly.
- ⚡ **Streaming**: Supports chunked transfer encoding and binary responses.

## Installation

```bash
bun add bun-socks
```

## Usage

Import `fetch` from the library and use the `proxy` option in the init object. The proxy connection string must follow the format: `socks5://user:pass@host:port`.

## Examples

### Basic GET Request

```typescript
import { fetch } from "bun-socks";

const response = await fetch("https://api.ipify.org?format=json", {
  proxy: "socks5://myuser:mypass@127.0.0.1:1080"
});

const data = await response.json();
console.log(data);
```

### POST Request with Custom Headers

```typescript
import { fetch } from "bun-socks";

const response = await fetch("https://example.com/api/data", {
  method: "POST",
  body: JSON.stringify({ key: "value" }),
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer token"
  },
  proxy: "socks5://user:pass@proxy.server.com:1080"
});
```

### Using alongside standard Fetch

If you omit the `proxy` option, the library falls back to the native global `fetch`, so you can use it as a drop-in replacement throughout your application.

```typescript
// Uses SOCKS5 proxy
await fetch("https://secret-service.com", { proxy: "socks5://..." });

// Uses standard internet connection (native fetch)
await fetch("https://google.com"); 
```

## API

### `fetch(input: string | URL | Request, init?: RequestInit & { proxy?: string }): Promise<Response>`

A custom fetch function that supports SOCKS5 proxies via the `proxy` option.

- **Parameters**:
  - `input`: The URL or Request object to fetch.
  - `init`: Optional init object, extended with `proxy` string for SOCKS5 URL.
- **Returns**: A Promise that resolves to a Response object.
- **Throws**: Errors for invalid proxy URLs or connection failures.

If no `proxy` is provided, it falls back to the native `globalThis.fetch`.

## Configuration

The proxy URL must be a valid SOCKS5 URI:

- **No Auth**: `socks5://127.0.0.1:9050`
- **With Auth**: `socks5://user:password@proxy.example.com:1080`
- **IPv6**: `socks5://user:password@[2001:db8::1]:1080`

## License

MIT
