/**
 * JSMAWS Value Resolver
 * Resolves value references in configuration objects using registered scheme handlers.
 *
 * Supported built-in schemes:
 *   :: (empty/literal) - treats the remainder as a literal string value
 *   :delete:           - marks a key for deletion in appEnv merge (appEnv only)
 *
 * External schemes (registered via registerScheme):
 *   :env:VAR_NAME      - OS environment variable
 *   :file:/path        - file contents (trimmed)
 *   :kv:key            - Deno KV store entry
 *   :kv.selector:key   - named Deno KV store entry
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Sentinel value returned by resolveValue() when a key should be deleted
 * from an appEnv merge. Not a valid resolved string value.
 * Only meaningful in appEnv blocks; using :delete: outside appEnv is an error.
 */
export const DELETE_SENTINEL = Symbol('delete');

/**
 * Parses a value reference string into its scheme, selector, and reference parts.
 * Returns null if the string is not a value reference (does not start with ':').
 *
 * Examples:
 *   ':env:JWT_SECRET'          → { scheme: 'env', selector: 'default', ref: 'JWT_SECRET' }
 *   ':kv.production:secrets/k' → { scheme: 'kv', selector: 'production', ref: 'secrets/k' }
 *   '::'                       → { scheme: '', selector: 'default', ref: '' }
 *   ':::value'                 → { scheme: '', selector: 'default', ref: ':value' }
 *   ':delete:'                 → { scheme: 'delete', selector: 'default', ref: '' }
 *
 * @param {string} value
 * @returns {{ scheme: string, selector: string, ref: string }|null}
 */
export function parseValueRef (value) {
	if (typeof value !== 'string' || !value.startsWith(':')) return null;

	// Find the closing colon of the scheme (second ':' after the opening one)
	const secondColon = value.indexOf(':', 1);
	if (secondColon === -1) return null; // Malformed: no closing colon

	const schemeAndSelector = value.slice(1, secondColon); // e.g. 'env', 'kv.production', ''
	const ref = value.slice(secondColon + 1);

	const dotIdx = schemeAndSelector.indexOf('.');
	let scheme, selector;
	if (dotIdx === -1) {
		scheme = schemeAndSelector;
		selector = 'default';
	} else {
		scheme = schemeAndSelector.slice(0, dotIdx);
		selector = schemeAndSelector.slice(dotIdx + 1) || 'default';
	}

	return { scheme, selector, ref };
}

/**
 * ValueResolver
 *
 * Resolves value references in configuration objects. Scheme handlers are
 * registered via the static registerScheme() method. The built-in '::' (literal)
 * and ':delete:' schemes are handled directly without external classes.
 *
 * Usage:
 *   const resolver = new ValueResolver();
 *   const resolved = await resolver.resolveObject(rawConfig, rawConfig);
 */
export class ValueResolver {
	/** @type {Map<string, Function>} scheme name → handler class */
	static #schemes = new Map();

	/**
	 * Register a scheme handler class for a scheme name.
	 * May be called multiple times with the same class and different names
	 * to support aliasing.
	 *
	 * @param {string} schemeName - Scheme name (e.g., 'env', 'kv', 'file')
	 * @param {Function} SchemeClass - Class with constructor(rawConfig), async resolve(ref), async done()
	 */
	static registerScheme (schemeName, SchemeClass) {
		ValueResolver.#schemes.set(schemeName, SchemeClass);
	}

	/**
	 * Resolve all value references in an object (recursively).
	 * Strings matching ':scheme:reference' are replaced with resolved values.
	 * Non-string values are passed through unchanged.
	 *
	 * On the first encounter of a registered scheme during a resolution pass,
	 * a scheme-class instance is created (receiving rawConfig) and cached for
	 * the duration of the pass. At the end of the pass, done() is called on
	 * each instantiated handler.
	 *
	 * @param {Object} rawConfig - The entire raw (unresolved) configuration object
	 * @param {Object|Array} obj - Object or array to resolve (may be rawConfig itself)
	 * @returns {Promise<Object|Array>} New object/array with all references resolved
	 */
	async resolveObject (rawConfig, obj) {
		/** @type {Map<string, object>} scheme name → handler instance (per-pass cache) */
		const handlerCache = new Map();

		try {
			return await this.#resolveValue(rawConfig, obj, handlerCache);
		} finally {
			// Call done() on all instantiated handlers
			for (const handler of handlerCache.values()) {
				try {
					await handler.done();
				} catch (err) {
					// Log but don't rethrow — cleanup errors should not mask resolution errors
					console.error(`[ValueResolver] Handler done() error: ${err.message}`);
				}
			}
		}
	}

	/**
	 * Resolve a single string value reference.
	 * Returns the resolved string, DELETE_SENTINEL, or the original string if not a reference.
	 * @private
	 */
	async #resolveString (rawConfig, value, handlerCache) {
		const parsed = parseValueRef(value);
		if (!parsed) return value; // Not a value reference — use as-is

		const { scheme, ref } = parsed;

		// Built-in: :: (literal/empty scheme)
		if (scheme === '') {
			return ref; // Everything after '::' is the literal value
		}

		// Built-in: :delete:
		if (scheme === 'delete') {
			return DELETE_SENTINEL;
		}

		// External scheme
		const SchemeClass = ValueResolver.#schemes.get(scheme);
		if (!SchemeClass) {
			throw new Error(`[ValueResolver] Unknown scheme ':${scheme}:' in value reference '${value}'`);
		}

		// Get or create handler instance for this scheme (per-pass cache)
		let handler = handlerCache.get(scheme);
		if (!handler) {
			handler = new SchemeClass(rawConfig);
			handlerCache.set(scheme, handler);
		}

		// Pass the full original value reference string to the handler
		// (e.g., ':kv.production:secrets/key') so it can extract selector if needed
		return await handler.resolve(value);
	}

	/**
	 * Recursively resolve a value (string, array, or plain object).
	 * @private
	 */
	async #resolveValue (rawConfig, value, handlerCache) {
		if (typeof value === 'string') {
			return await this.#resolveString(rawConfig, value, handlerCache);
		}

		if (Array.isArray(value)) {
			const result = [];
			for (const item of value) {
				result.push(await this.#resolveValue(rawConfig, item, handlerCache));
			}
			return result;
		}

		if (value !== null && typeof value === 'object') {
			const result = {};
			for (const [key, val] of Object.entries(value)) {
				result[key] = await this.#resolveValue(rawConfig, val, handlerCache);
			}
			return result;
		}

		// Primitives (number, boolean, null, undefined) pass through unchanged
		return value;
	}
}
