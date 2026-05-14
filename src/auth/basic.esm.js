/**
 * JSMAWS Built-in Auth Provider: @basic
 * Verifies HTTP Basic Authentication credentials.
 *
 * Configuration:
 *   provider=@basic
 *   users=:env:BASIC_AUTH_USERS   (JSON object mapping username → password, or
 *                                  comma-separated "user:pass" pairs)
 *   base64=@t                     (optional: passwords in users map are base64-encoded,
 *                                  default: false)
 *
 * When base64=@t, each password value in the users map is treated as a base64-encoded
 * string. The decoded value is compared against the submitted password. This is useful
 * when passwords contain special characters (colons, commas) that would interfere with
 * the comma-separated "user:pass" parsing format.
 *
 * Return values (per auth-revisions-20260510.md 2026-05-11-B):
 *   null                          — no Basic header (provider did not recognize request)
 *   { allow: false, ... }         — malformed base64 (structurally invalid credential)
 *   null                          — wrong credentials (try next provider)
 *   { allow: true, identity }     — valid credentials
 *
 * Note: The realm config option is retained for documentation purposes but WWW-Authenticate
 * headers are no longer injected by this provider. Response headers are a mod-app concern.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Parse a users spec into a plain object mapping username → password.
 * Accepts:
 *   - JSON string: '{"alice":"secret","bob":"pass"}'
 *   - Comma-separated "user:pass" pairs: "alice:secret,bob:pass"
 *   - Plain object: { alice: 'secret', bob: 'pass' }
 * @param {string|Object|null} usersSpec
 * @returns {Object} username → password map
 */
function parseUsers (usersSpec) {
	if (!usersSpec) return {};

	if (typeof usersSpec === 'object') {
		return usersSpec;
	}

	if (typeof usersSpec === 'string') {
		// Try JSON first
		if (usersSpec.trim().startsWith('{')) {
			try {
				return JSON.parse(usersSpec);
			} catch (_) {
				// Fall through to comma-separated parsing
			}
		}

		// Parse comma-separated "user:pass" pairs
		const result = {};
		for (const pair of usersSpec.split(',')) {
			const colonIdx = pair.indexOf(':');
			if (colonIdx < 0) continue;
			const username = pair.slice(0, colonIdx).trim();
			const password = pair.slice(colonIdx + 1).trim();
			if (username) result[username] = password;
		}
		return result;
	}

	return {};
}

export default {
	/**
	 * Verify HTTP Basic Authentication credentials.
	 *
	 * Per auth-revisions-20260510.md 2026-05-11-B:
	 *   - No Basic header → null (provider did not recognize this request)
	 *   - Malformed base64 → { allow: false } (structurally invalid credential)
	 *   - Wrong credentials → null (try next provider)
	 *   - Valid credentials → { allow: true, identity }
	 *
	 * WWW-Authenticate response headers are a mod-app concern, not a provider concern.
	 *
	 * @param {Object} ctx - AuthContext
	 * @param {Object} ctx.headers - Request headers
	 * @param {Object} ctx.config - Provider configuration
	 * @returns {Object|null} AuthResult or null
	 */
	authCheck (ctx) {
		const { headers, config } = ctx;
		const useBase64Passwords = config?.base64 === true || config?.base64 === '@t' || config?.base64 === 'true';

		// Extract Basic credentials from Authorization header
		const authHeader = headers?.authorization ?? headers?.Authorization ?? '';
		if (!authHeader.startsWith('Basic ')) {
			// No Basic header — provider did not recognize this request
			return null;
		}

		const encoded = authHeader.slice(6).trim();
		let decoded;
		try {
			decoded = atob(encoded);
		} catch (_) {
			// Malformed base64 — structurally invalid credential
			return {
				allow: false,
				denyStatus: 401,
				denyMessage: 'Unauthorized',
			};
		}

		const colonIdx = decoded.indexOf(':');
		if (colonIdx < 0) {
			// No colon separator — structurally invalid credential
			return {
				allow: false,
				denyStatus: 401,
				denyMessage: 'Unauthorized',
			};
		}

		const username = decoded.slice(0, colonIdx);
		const password = decoded.slice(colonIdx + 1);

		// Validate credentials
		const users = parseUsers(config?.users);
		const storedPassword = users[username];

		if (storedPassword === undefined) {
			// Unknown username — try next provider
			return null;
		}

		// Decode stored password if base64 option is enabled
		let expectedPassword = storedPassword;
		if (useBase64Passwords) {
			try {
				expectedPassword = atob(storedPassword);
			} catch (_) {
				// Invalid base64 in config — treat as auth failure (try next provider)
				return null;
			}
		}

		if (expectedPassword !== password) {
			// Wrong password — try next provider
			return null;
		}

		const identity = {
			sub: username,
			roles: [],
			claims: {},
			provider: '@basic',
		};

		return { allow: true, identity };
	},
};
