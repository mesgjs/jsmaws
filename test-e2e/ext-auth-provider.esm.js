/**
 * Test External Auth Provider for E2E Auth Sub-Process Tests
 *
 * Simulates an external (network-dependent) auth provider for testing.
 * Authenticates requests based on a custom 'x-ext-token' header.
 *
 * This provider is intentionally NOT in OPR_AUTH_PROVIDERS, so it will
 * be delegated to the auth sub-process when authPool is configured.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default {
	/**
	 * Check authentication from 'x-ext-token' header.
	 * - 'valid-ext-token' → allow with identity { sub: 'ext-user', provider: '@ext-test' }
	 * - 'deny-ext-token' → explicit denial (401)
	 * - anything else → null (did not authenticate; try next provider)
	 */
	authCheck (ctx) {
		const token = ctx.headers?.['x-ext-token'] ?? ctx.headers?.['X-Ext-Token'];

		if (!token) return null; // No token — did not authenticate

		if (token === 'valid-ext-token') {
			return {
				allow: true,
				identity: {
					sub: 'ext-user',
					provider: '@ext-test',
					roles: ['external'],
				},
			};
		}

		if (token === 'deny-ext-token') {
			return {
				allow: false,
				denyStatus: 401,
				denyMessage: 'External token denied',
			};
		}

		// Unknown token — did not authenticate (try next provider)
		return null;
	},
};
