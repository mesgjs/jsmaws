/**
 * JSMAWS Operator Authn Runner
 * Runs stateless auth providers inline in the operator process.
 *
 * This module handles authn for stateless methods (JWT, API key, Basic) that
 * run directly in the operator without an external auth sub-process.
 * Results are cached in an OperatorAuthnCache for server-lifetime efficiency.
 *
 * Auth chain resolution (per auth-revisions-20260510.md):
 * - Top-level `authn` runs before routing; stops at first successful identification
 * - Route-group `authn` is a scalar filter on the already-computed identity (not a chain)
 * - If no top-level authn is configured, all requests are allowed (no auth)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { runAuthnChain, buildAuthContext } from './authn-chain.esm.js';
import { AuthProviderLoader } from './auth-provider-loader.esm.js';
import { OperatorAuthCache } from './operator-authn-cache.esm.js';

/**
 * Extract a cache key from a request for a given auth chain.
 * The key is `providerSpec + ":" + credential` for the first provider that
 * has a recognizable credential in the request headers.
 * Returns null if no credential is present (uncacheable).
 *
 * @param {Object} headers - Request headers (plain object)
 * @param {Array} authChain - Auth chain config array
 * @returns {string|null} Cache key or null
 */
function extractCacheKey (headers, authChain) {
	if (!authChain || !authChain.length) return null;

	for (const providerConfig of authChain) {
		if (!providerConfig || typeof providerConfig !== 'object') continue;
		const { provider: providerSpec } = providerConfig;
		if (!providerSpec) continue;

		// JWT / Basic: Authorization header
		const authHeader = headers?.authorization ?? headers?.Authorization;
		if (authHeader) return `${providerSpec}:${authHeader}`;

		// API key: configurable header
		const headerName = providerConfig.header;
		if (headerName) {
			const lname = headerName.toLowerCase();
			for (const [name, value] of Object.entries(headers ?? {})) {
				if (name.toLowerCase() === lname) return `${providerSpec}:${lname}:${value}`;
			}
		}
	}

	return null;
}

/**
 * OperatorAuthn
 * Manages operator-embedded stateless authn with caching.
 *
 * Top-level authn runs before routing; the result (identity + providerName) is
 * passed to the router for route-group authn filtering.
 */
export class OperatorAuthn {
	/**
	 * @param {Object} [opts]
	 * @param {Object} [opts.cacheConfig] - Cache configuration
	 * @param {number} [opts.cacheConfig.maxSize=1000] - Max cache entries
	 * @param {number} [opts.cacheConfig.defaultTtlSeconds=300] - Default TTL
	 * @param {AuthProviderLoader} [opts.loader] - Provider loader (for testing)
	 */
	constructor ({ cacheConfig = {}, loader } = {}) {
		this._cache = new OperatorAuthCache(cacheConfig);
		this._loader = loader ?? new AuthProviderLoader();
	}

	/**
	 * Clear the authn result cache.
	 * Called on config reload to invalidate stale results.
	 */
	clearCache () {
		this._cache.clear();
	}

	/**
	 * Run top-level authn for a request using the operator-embedded auth chain.
	 * Checks the cache first; runs the auth chain on cache miss.
	 *
	 * Returns an AuthnResult with identity and providerName for use by the router.
	 * The router uses providerName to evaluate route-group authn scalar filters.
	 *
	 * @param {Object} opts
	 * @param {string} opts.method - HTTP method
	 * @param {string} opts.url - Full request URL
	 * @param {Object} opts.headers - Request headers (plain object)
	 * @param {Array} [opts.topLevelAuthn] - Top-level authn array from config
	 * @returns {Promise<Object>} AuthnResult: { allow, identity, providerName } or { allow: false, denyStatus, denyMessage }
	 */
	async runAuthn ({ method, url, headers, topLevelAuthn = [] }) {
		const authChain = topLevelAuthn ?? [];

		// No auth configured
		if (!authChain || authChain.length === 0) {
			return { allow: true, identity: null, providerName: null };
		}

		// Try cache
		const cacheKey = extractCacheKey(headers, authChain);
		if (cacheKey) {
			const cached = this._cache.get(cacheKey);
			if (cached) return cached;
		}

		// Build auth context and run chain
		const ctx = buildAuthContext({ method, url, headers });
		const result = await runAuthnChain(ctx, authChain, this._loader);

		// Cache successful auth results (not denials — denials are not cacheable
		// because the same credential might be valid for a different route)
		if (result.allow && cacheKey) {
			this._cache.set(cacheKey, result);
		}

		return result;
	}
}
