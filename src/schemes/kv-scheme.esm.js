/**
 * JSMAWS :kv: Value Scheme Handler
 * Resolves ':kv:key' and ':kv.selector:key' value references from Deno KV stores.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { parseValueRef } from '../value-resolver.esm.js';

/**
 * Scheme handler for ':kv:' and ':kv.selector:' value references.
 * Reads values from Deno KV stores configured in rawConfig.kvStores.
 *
 * KV stores are opened at construction time and closed in done().
 * The key path uses '/' as a separator, mapping to a KV key array:
 *   ':kv:secrets/jwt-signing-key' → ['secrets', 'jwt-signing-key']
 *
 * Configuration:
 *   kvStore=/path/to/store.db          (alias for kvStores=[default=/path/to/store.db])
 *   kvStores=[
 *     default=/path/to/store.db
 *     production=https://api.deno.com/databases/...
 *   ]
 */
export class KvScheme {
	/** @type {Map<string, Deno.Kv>} selector → open KV store handle */
	#stores = new Map();
	/** @type {Map<string, Promise<Deno.Kv|null>>} selector → open promise */
	#openPromises = new Map();

	/**
	 * @param {Object} rawConfig - Raw configuration; reads kvStores (and kvStore alias)
	 */
	constructor (rawConfig) {
		// Normalize kvStore (singular alias) → kvStores
		const kvStores = rawConfig?.kvStores ?? (rawConfig?.kvStore
			? { default: rawConfig.kvStore }
			: {});

		// Open all configured KV stores eagerly (synchronous constructor, async open deferred)
		// We store the open promises and await them in resolve()
		for (const [selector, path] of Object.entries(kvStores)) {
			this.#openPromises.set(selector, Deno.openKv(path).then((kv) => {
				this.#stores.set(selector, kv);
				return kv;
			}).catch((err) => {
				console.error(`[KvScheme] Failed to open KV store '${selector}' at '${path}': ${err.message}`);
				return null;
			}));
		}
	}

	/**
	 * Resolve a ':kv:key' or ':kv.selector:key' value reference.
	 * @param {string} ref - Full value reference string (e.g., ':kv:secrets/jwt-key')
	 * @returns {Promise<string|undefined>} Resolved value, or undefined if not found
	 */
	async resolve (ref) {
		const parsed = parseValueRef(ref);
		if (!parsed) {
			console.warn(`[KvScheme] Invalid value reference '${ref}'`);
			return undefined;
		}

		const { selector, ref: keyPath } = parsed;

		if (!keyPath) {
			console.warn(`[KvScheme] Missing key path in value reference '${ref}'`);
			return undefined;
		}

		// Await the open promise for this selector
		const openPromise = this.#openPromises?.get(selector);
		if (!openPromise) {
			console.error(`[KvScheme] No KV store configured for selector '${selector}' (from '${ref}')`);
			return undefined;
		}

		const kv = await openPromise;
		if (!kv) {
			// Error already logged during open
			return undefined;
		}

		// Convert '/'-separated key path to KV key array
		const keyArray = keyPath.split('/').filter(Boolean);
		if (keyArray.length === 0) {
			console.warn(`[KvScheme] Empty key path in value reference '${ref}'`);
			return undefined;
		}

		const entry = await kv.get(keyArray);
		if (entry.value === null) {
			console.warn(`[KvScheme] Key not found: [${keyArray.join(', ')}] in store '${selector}'`);
			return undefined;
		}

		// Coerce to string (KV values may be any type)
		return String(entry.value);
	}

	/**
	 * Close all KV stores opened by this instance.
	 */
	async done () {
		// Wait for all open promises to settle before closing
		await Promise.allSettled([...this.#openPromises.values()]);
		for (const [selector, kv] of this.#stores) {
			try {
				kv.close();
			} catch (err) {
				console.error(`[KvScheme] Error closing KV store '${selector}': ${err.message}`);
			}
		}
		this.#openPromises.clear();
		this.#stores.clear();
	}
}
