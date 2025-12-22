// Pre-compiled regex for performance
const NEEDS_ENCODING_REGEX = /[^A-Za-z0-9._~-]/;
const PORT_REGEX = /^\d+$/;

/**
 * Converts proxy URL(s) from non-standard format to standard proxy URL format.
 *
 * Supported protocols: socks5, socks4, http, https
 *
 * Supported input formats:
 * - Standard: protocol://[user:pass@]host:port
 * - Colon-separated: protocol://host:port:username:password
 * - Colon-separated without protocol: host:port:username:password (assumes socks5)
 *
 *
 * @param proxyUrl - Single proxy URL or array of proxy URLs in any supported format
 * @param skipInvalid - If true and array is passed, skips invalid URLs instead of throwing errors (default: false)
 * @returns Standard proxy URL(s): protocol://[user:pass@]host:port
 * @throws Error if the proxy URL format is invalid (unless skipInvalid is true for arrays)
 *
 * @example
 * ```ts
 * // Single URL - Standard format (returns as-is)
 * convert("socks5://user:pass@example.com:1080")
 * // => "socks5://user:pass@example.com:1080"
 *
 * // Single URL - Colon-separated format
 * convert("socks5://example.com:1080:user:pass")
 * // => "socks5://user:pass@example.com:1080"
 *
 * // Single URL - Without protocol (defaults to socks5)
 * convert("example.com:1080:user:pass")
 * // => "socks5://user:pass@example.com:1080"
 *
 * // HTTP proxy
 * convert("http://proxy.com:8080:user:pass")
 * // => "http://user:pass@proxy.com:8080"
 *
 * // SOCKS4 proxy
 * convert("socks4://proxy.com:1080:user:pass")
 * // => "socks4://user:pass@proxy.com:1080"
 *
 * // Array of URLs
 * convert([
 *   "socks5://proxy1.com:1080:user:pass",
 *   "proxy2.com:1080:admin:secret"
 * ])
 * // => [
 * //   "socks5://user:pass@proxy1.com:1080",
 * //   "socks5://admin:secret@proxy2.com:1080"
 * // ]
 * ```
 */
export function convert(proxyUrl: string, skipInvalid?: false): string;
export function convert(
	proxyUrl: string[],
	skipInvalid?: boolean,
): string[];
export function convert(
	proxyUrl: string | string[],
	skipInvalid = false,
): string | string[] {
	// Handle array input
	if (Array.isArray(proxyUrl)) {
		const results: string[] = [];

		for (const url of proxyUrl) {
			try {
				results.push(convertLine(url));
			} catch (error) {
				if (!skipInvalid) {
					throw error;
				}
				// Skip invalid URLs silently
				console.warn(
					`Skipping invalid proxy URL: ${url} - ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return results;
	}

	// Handle single string input
	return convertLine(proxyUrl);
}

export function convertLine(proxyUrl: string): string {
	if (!proxyUrl) {
		throw new Error("Proxy URL cannot be empty");
	}

	const len = proxyUrl.length;

	// Extract protocol if present
	let protocol = "socks5";
	let remaining = proxyUrl;
	const protocolIdx = proxyUrl.indexOf("://");

	if (protocolIdx !== -1) {
		// Quick validation for known protocols using charCodeAt - check first char
		const c0 = proxyUrl.charCodeAt(0);

		// Early exit for invalid first char
		if (c0 !== 0x73 && c0 !== 0x68) {
			// Not 's' or 'h', invalid protocol
			protocol = proxyUrl.substring(0, protocolIdx);
			throw new Error(
				`Unsupported proxy protocol: ${protocol}. Supported protocols: socks5, socks4, http, https.`,
			);
		}

		protocol = proxyUrl.substring(0, protocolIdx);
		remaining = proxyUrl.substring(protocolIdx + 3);

		// Validate protocol using charCodeAt for speed
		const valid =
			(c0 === 0x73 &&
				(protocol.charCodeAt(5) === 0x35 || protocol.charCodeAt(5) === 0x34)) || // socks5 or socks4
			c0 === 0x68; // http or https

		if (!valid) {
			throw new Error(
				`Unsupported proxy protocol: ${protocol}. Supported protocols: socks5, socks4, http, https.`,
			);
		}
	}

	// Count colons ONCE to detect format (ignore colons inside IPv6 brackets)
	let colonCount = 0;
	let insideBrackets = false;
	for (let i = 0; i < remaining.length; i++) {
		const char = remaining.charCodeAt(i);
		if (char === 0x5b) {
			// '['
			insideBrackets = true;
		} else if (char === 0x5d) {
			// ']'
			insideBrackets = false;
		} else if (char === 0x3a && !insideBrackets) {
			// ':' outside brackets
			colonCount++;
		}
	}

	// Fast path for protocol:// URLs with @ symbol
	if (protocolIdx !== -1 && colonCount !== 3) {
		const atIndex = remaining.indexOf("@");

		if (atIndex !== -1) {
			// Has @ - check if it's standard or inverted format
			const beforeAt = remaining.substring(0, atIndex);
			const afterAt = remaining.substring(atIndex + 1);

			// Standard format: protocol://user:pass@host:port
			// Inverted format: protocol://host:port@user:pass
			// Key: in standard, the LAST part after @ (after splitting by :) is a port number

			const afterParts = afterAt.split(":");
			const lastPart = afterParts[afterParts.length - 1];
			const isPort = PORT_REGEX.test(lastPart);

			if (isPort) {
				// Standard format: protocol://user:pass@host:port - return as-is
				const c0 = proxyUrl.charCodeAt(0);
				if (c0 === 0x73) {
					// socks5 or socks4
					const c5 = proxyUrl.charCodeAt(5);
					if (c5 === 0x35 || c5 === 0x34) {
						return proxyUrl;
					}
				} else if (c0 === 0x68) {
					// http or https
					return proxyUrl;
				}
			} else {
				// Inverted format: protocol://host:port@user:pass
				const hostPort = beforeAt;
				const userPass = afterAt;

				// Encode credentials if needed
				const colonPos = userPass.indexOf(":");
				if (colonPos === -1) {
					// No password, just username
					const needsEncode = NEEDS_ENCODING_REGEX.test(userPass);
					const encoded = needsEncode
						? encodeURIComponent(userPass)
						: userPass;
					return `${protocol}://${encoded}@${hostPort}`;
				}

				const username = userPass.substring(0, colonPos);
				const password = userPass.substring(colonPos + 1);

				const needsEncodeUser = NEEDS_ENCODING_REGEX.test(username);
				const needsEncodePass = NEEDS_ENCODING_REGEX.test(password);

				const encodedUser = needsEncodeUser
					? encodeURIComponent(username)
					: username;
				const encodedPass = needsEncodePass
					? encodeURIComponent(password)
					: password;

				return `${protocol}://${encodedUser}:${encodedPass}@${hostPort}`;
			}
		} else if (colonCount === 1) {
			// No @ and only 1 colon: protocol://host:port (no auth)
			return proxyUrl;
		}
	}

	if (colonCount < 1) {
		throw new Error(
			`Invalid proxy format: ${proxyUrl}. Expected format: host:port or host:port:username:password`,
		);
	}

	// Format: host:port (1 colon, or IPv6 with brackets)
	if (colonCount === 1) {
		// For IPv6: find the closing bracket, then the port after it
		let colonIdx: number;
		let host: string;
		let port: string;

		if (remaining.charCodeAt(0) === 0x5b) {
			// '[' - IPv6 address
			const closeBracket = remaining.indexOf("]");
			if (closeBracket === -1) {
				throw new Error("Invalid IPv6 format: missing closing bracket");
			}
			host = remaining.substring(0, closeBracket + 1);
			colonIdx = closeBracket + 1;
			port = remaining.substring(colonIdx + 1);
		} else {
			colonIdx = remaining.indexOf(":");
			host = remaining.substring(0, colonIdx);
			port = remaining.substring(colonIdx + 1);
		}

		// Validate port
		const portNum = parseInt(port, 10);
		if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
			throw new Error(`Invalid port: ${port}`);
		}

		return `${protocol}://${host}:${port}`;
	}

	// Format: host:port:username:password (3 colons, or IPv6 with brackets + 3 colons)
	if (colonCount === 3) {
		let host: string;
		let port: string;
		let username: string;
		let password: string;

		if (remaining.charCodeAt(0) === 0x5b) {
			// '[' - IPv6 address
			const closeBracket = remaining.indexOf("]");
			if (closeBracket === -1) {
				throw new Error("Invalid IPv6 format: missing closing bracket");
			}
			host = remaining.substring(0, closeBracket + 1);

			// Parse the rest: ]:port:username:password
			const afterBracket = remaining.substring(closeBracket + 2); // skip ']:'
			const parts = afterBracket.split(":");
			port = parts[0];
			username = parts[1];
			password = parts[2];
		} else {
			const parts = remaining.split(":");
			host = parts[0];
			port = parts[1];
			username = parts[2];
			password = parts[3];
		}

		// Validate port
		const portNum = parseInt(port, 10);
		if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
			throw new Error(`Invalid port: ${port}`);
		}

		if (!username) {
			throw new Error("Username cannot be empty when password is provided");
		}

		// Only encode if needed (check for special chars)
		const needsEncodeUser = NEEDS_ENCODING_REGEX.test(username);
		const needsEncodePass = NEEDS_ENCODING_REGEX.test(password);

		const encodedUser = needsEncodeUser
			? encodeURIComponent(username)
			: username;
		const encodedPass = needsEncodePass
			? encodeURIComponent(password)
			: password;

		return `${protocol}://${encodedUser}:${encodedPass}@${host}:${port}`;
	}

	throw new Error(
		`Invalid proxy format: ${proxyUrl}. Expected 1 or 3 colons (host:port or host:port:username:password)`,
	);
}
