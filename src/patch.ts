import { fetch as _fetch } from "./fetch";

function fetchPatch() {
	// Override global fetch (preconnect method is already attached to newFetch)
	globalThis.fetch = _fetch as typeof globalThis.fetch;
}

export { fetchPatch };
