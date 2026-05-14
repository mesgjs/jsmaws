/**
 * JSMAWS Built-in Auth Provider: @api-key
 * Verifies API keys from a configurable request header.
 *
 * Configuration:
 *   provider=@api-key
 *   header=x-api-key              (header name to read the key from, default: x-api-key)
 *   keys=:env:API_KEYS             (comma-separated list of valid keys, or array)
 *   keyMap=:env:API_KEY_MAP        (JSON object mapping key → subject, optional)
 *
 * If keyMap is provided, the subject is looked up from the map.
 * If only keys is provided, the subject is the key itself.
 *
 * Return values (per auth-revisions-20260510.md 2026-05-11-B):
 *   null                          — no key header present (provider did not recognize request)
 *   null                          — key present but not valid (wrong key; try next provider)
 *   { allow: true, identity }     — valid key; identity includes sub, roles, claims, provider
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Parse a keys value into a Set of valid key strings.
 * Accepts a comma-separated string, an array, or a plain object (values).
 * @param {string|Array|Object} keysSpec
 * @returns {Set<string>}
 */
function parseKeys (keysSpec) {
	if (!keysSpec) return new Set();

	if (typeof keysSpec === 'string') {
		return new Set(keysSpec.split(',').map(k => k.trim()).filter(Boolean));
	}

	if (Array.isArray(keysSpec)) {
		return new Set(keysSpec.map(String).filter(Boolean));
	}

	if (typeof keysSpec === 'object') {
		return new Set(Object.values(keysSpec).map(String).filter(Boolean));
	}

	return new Set();
}

/**
 * Parse a keyMap value into a plain object mapping key → subject.
 * Accepts a JSON string, a plain object, or null.
 * @param {string|Object|null} keyMapSpec
 * @returns {Object|null}
 */
function parseKeyMap (keyMapSpec) {
	if (!keyMapSpec) return null;

	if (typeof keyMapSpec === 'string') {
		try {
			return JSON.parse(keyMapSpec);
		} catch (_) {
			return null;
		}
	}

	if (typeof keyMapSpec === 'object') {
		return keyMapSpec;
	}

	return null;
}

export default {
	/**
	 * Verify API key from request header.
	 *
	 * Per auth-revisions-20260510.md 2026-05-11-B:
	 *   - No key header → null (provider did not recognize this request)
	 *   - Key present but invalid → null (wrong key; try next provider)
	 *   - Valid key → { allow: true, identity }
	 *
	 * @param {Object} ctx - AuthContext
	 * @param {Object} ctx.headers - Request headers
	 * @param {Object} ctx.config - Provider configuration
	 * @returns {Object|null} AuthResult or null
	 */
	authCheck (ctx) {
		const { headers, config } = ctx;

		const headerName = (config?.header ?? 'x-api-key').toLowerCase();

		// Find the API key header (case-insensitive)
		let apiKey = null;
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === headerName) {
				apiKey = value;
				break;
			}
		}

		if (!apiKey) {
			// No key header — provider did not recognize this request
			return null;
		}

		// Parse valid keys
		const validKeys = parseKeys(config?.keys);
		const keyMap = parseKeyMap(config?.keyMap);

		// Check if key is valid
		const isValid = keyMap
			? Object.prototype.hasOwnProperty.call(keyMap, apiKey)
			: validKeys.has(apiKey);

		if (!isValid) {
			// Key present but not valid — try next provider
			return null;
		}

		// Determine subject
		const sub = keyMap ? (keyMap[apiKey] ?? apiKey) : apiKey;

		const identity = {
			sub: String(sub),
			roles: [],
			claims: {},
			provider: '@api-key',
		};

		return { allow: true, identity };
	},
};
