/**
 * JSMAWS Authentication Chain Runner
 * Runs an auth provider chain for a request and returns an AuthnResult.
 *
 * The chain runs providers in order; the first success stops the chain.
 * Provider errors are treated as 500 Internal Server Error.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { authProviderLoader } from './auth-provider-loader.esm.js';

/**
 * Run an auth provider chain for a request.
 *
 * Providers are evaluated in order until one succeeds (returns allow=true with an identity)
 * or all are exhausted. The first successful authentication stops the chain.
 * An explicit denial (allow=false) from any provider short-circuits the chain immediately.
 *
 * @param {Object} ctx - AuthContext
 * @param {string} ctx.method - HTTP method
 * @param {string} ctx.url - Full request URL
 * @param {Object} ctx.headers - Raw request headers (plain object with lowercase keys)
 * @param {Object} ctx.cookies - Parsed cookies (plain object)
 * @param {Object} [ctx.config] - Auth provider configuration (from route/pool config)
 * @param {Array} authChain - Array of auth provider config objects
 *   Each entry: { provider: '@jwt' | './path.esm.js', ...providerConfig }
 * @param {AuthProviderLoader} [loader] - Optional loader instance (for testing)
 * @returns {Promise<AuthnResult>} Authn result
 *
 * AuthnResult (allow):
 *   { allow: true, identity: Object|null, provider: string|null, cacheKey: string|null }
 *   - identity: populated by the first successful auth provider (sub, roles, claims, provider)
 *   - provider: the provider spec string that succeeded (e.g. '@jwt'), or null if no auth
 *   - cacheKey: opaque string for caching the result, or null if not cacheable
 *     Providers that wish to support caching return a `cacheKey` in their result.
 *     The key must uniquely identify the credential used (e.g. `'@jwt:Bearer <token>'`).
 *
 * AuthnResult (deny):
 *   { allow: false, denyStatus: number, denyMessage: string }
 *
 * Chain semantics:
 *   - Provider returns null/undefined → did not authenticate; try next provider
 *   - Provider returns { allow: true, identity: ... } → success; stop chain
 *   - Provider returns { allow: false, ... } → explicit denial; stop chain immediately
 *   - All providers exhausted without success → allow with null identity (no auth configured)
 */
export async function runAuthnChain (ctx, authChain, loader = authProviderLoader) {
	if (!authChain || !Array.isArray(authChain) || authChain.length === 0) {
		// No auth configured — allow with null identity
		return { allow: true, identity: null, provider: null, cacheKey: null };
	}

	for (const providerConfig of authChain) {
		if (!providerConfig || typeof providerConfig !== 'object') continue;

		const { provider: providerSpec, ...config } = providerConfig;
		if (!providerSpec) continue;

		let provider;
		try {
			provider = await loader.load(providerSpec);
		} catch (error) {
			// Provider load failure → 500
			return {
				allow: false,
				denyStatus: 500,
				denyMessage: `Auth provider load error: ${error.message}`,
			};
		}

		// Build per-provider context (merge global ctx with provider-specific config)
		const providerCtx = { ...ctx, config };

		let result;
		try {
			result = await provider.authCheck(providerCtx);
		} catch (error) {
			// Provider runtime error → 500
			return {
				allow: false,
				denyStatus: 500,
				denyMessage: `Auth provider error: ${error.message}`,
			};
		}

		if (!result) {
			// Provider returned null/undefined — did not authenticate; try next provider
			continue;
		}

		if (!result.allow) {
			// Explicit denial — short-circuit
			return {
				allow: false,
				denyStatus: result.denyStatus ?? 401,
				denyMessage: result.denyMessage ?? 'Unauthorized',
			};
		}

		// First success — stop chain; identity does not accumulate
		// Pass through cacheKey from provider result (null if provider does not support caching)
		return {
			allow: true,
			identity: result.identity ?? null,
			provider: providerSpec,
			cacheKey: result.cacheKey ?? null,
		};
	}

	// All providers exhausted without success — allow with null identity
	return { allow: true, identity: null, provider: null, cacheKey: null };
}

/**
 * Parse cookies from a Cookie header string.
 * @param {string} cookieHeader - Value of the Cookie header
 * @returns {Object} Parsed cookies as a plain object
 */
export function parseCookies (cookieHeader) {
	if (!cookieHeader) return {};
	const cookies = {};
	for (const part of cookieHeader.split(';')) {
		const eqIdx = part.indexOf('=');
		if (eqIdx < 0) continue;
		const name = part.slice(0, eqIdx).trim();
		const value = part.slice(eqIdx + 1).trim();
		if (name) cookies[name] = value;
	}
	return cookies;
}

/**
 * Build an AuthContext from a request.
 *
 * The auth context is for authn providers (identification) only.
 * Authorization (role checks) is a routing-layer concern handled after route matching.
 *
 * @param {Object} opts
 * @param {string} opts.method - HTTP method
 * @param {string} opts.url - Full request URL
 * @param {Object} opts.headers - Raw request headers (plain object with **lowercase keys**)
 * @returns {Object} AuthContext
 */
export function buildAuthContext ({ method, url, headers }) {
	// Headers are expected to have lowercase keys (per Fetch API / Deno's Headers object).
	const cookies = parseCookies(headers?.cookie ?? '');

	return {
		method,
		url,
		headers: headers ?? {},
		cookies,
	};
}
