/**
 * JSMAWS Operator Auth Runner
 * Runs stateless auth providers inline in the operator process (Option D).
 *
 * This module handles auth for stateless methods (JWT, API key, Basic) that
 * run directly in the operator without an external auth service process.
 * Results are cached in an OperatorAuthCache for server-lifetime efficiency.
 *
 * Auth chain resolution (per revisions-20260510.md):
 * - Route-group `authn` overrides top-level `authn` when present
 * - Top-level `authn` is the site-level default
 * - If neither is configured, all requests are allowed (no auth)
 *
 * For network-dependent auth (OAuth, LDAP, session stores), use the auth
 * service process (Option C) via operator-process.esm.js integration.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { runAuthChain, buildAuthContext } from './auth-middleware.esm.js';
import { AuthProviderLoader } from './auth-provider-loader.esm.js';
import { OperatorAuthCache } from './operator-auth-cache.esm.js';

/**
 * Extract a cache key from a request for a given auth chain.
 * The key is the credential string (e.g. the Authorization header value).
 * Returns null if no credential is present (uncacheable).
 *
 * @param {Object} headers - Request headers (plain object)
 * @param {Array} authChain - Auth chain config array
 * @returns {string|null} Cache key or null
 */
function extractCacheKey (headers, authChain) {
	if (!authChain || !authChain.length) return null;

	// Use the Authorization header as the primary cache key
	const authHeader = headers?.authorization ?? headers?.Authorization;
	if (authHeader) return authHeader;

	// Fall back to API key headers (check all providers for a header config)
	for (const providerConfig of authChain) {
		if (!providerConfig) continue;
		const headerName = providerConfig.header;
		if (headerName) {
			const lname = headerName.toLowerCase();
			for (const [name, value] of Object.entries(headers ?? {})) {
				if (name.toLowerCase() === lname) return `${lname}:${value}`;
			}
		}
	}

	return null;
}

/**
 * Resolve the effective auth chain for a request.
 * Route-group authn overrides top-level authn (per revisions-20260510.md).
 *
 * @param {Object|null} routeGroup - Matched route group config (or null)
 * @param {Array} topLevelAuthn - Top-level authn array from config
 * @returns {Array} Effective auth chain (may be empty)
 */
function resolveAuthChain (routeGroup, topLevelAuthn) {
	// Route-group authn overrides top-level authn
	if (routeGroup && routeGroup.authn != null) {
		const groupAuthn = routeGroup.authn;
		if (Array.isArray(groupAuthn)) return groupAuthn;
		if (typeof groupAuthn === 'object') return Object.values(groupAuthn);
		return [];
	}
	// Fall back to top-level authn
	return topLevelAuthn ?? [];
}

/**
 * OperatorAuth
 * Manages operator-embedded stateless auth (Option D) with caching.
 */
export class OperatorAuth {
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
	 * Clear the auth result cache.
	 * Called on config reload to invalidate stale results.
	 */
	clearCache () {
		this._cache.clear();
	}

	/**
	 * Run auth for a request using the operator-embedded auth chain.
	 * Checks the cache first; runs the auth chain on cache miss.
	 *
	 * Auth chain resolution (per revisions-20260510.md):
	 * - Route-group `authn` overrides top-level `authn` when present
	 * - Top-level `authn` is the site-level default
	 * - If neither is configured, all requests are allowed (no auth)
	 *
	 * @param {Object} opts
	 * @param {string} opts.method - HTTP method
	 * @param {string} opts.url - Full request URL
	 * @param {Object} opts.headers - Request headers (plain object)
	 * @param {Object|null} opts.routeSpec - Matched route specification
	 * @param {string} opts.poolName - Pool name
	 * @param {Object|null} [opts.routeGroup] - Matched route group config (or null)
	 * @param {Array} [opts.topLevelAuthn] - Top-level authn array from config
	 * @returns {Promise<Object>} AuthResult
	 */
	async runAuth ({ method, url, headers, routeSpec, poolName, routeGroup = null, topLevelAuthn = [] }) {
		const authChain = resolveAuthChain(routeGroup, topLevelAuthn);

		// No auth configured
		if (!authChain || authChain.length === 0) {
			return { allow: true, identity: null, addHeaders: {} };
		}

		// Try cache (per-request second-level cache by provider, per revisions-20260510.md)
		const cacheKey = extractCacheKey(headers, authChain);
		if (cacheKey) {
			const cached = this._cache.get(cacheKey);
			if (cached) return cached;
		}

		// Build auth context and run chain
		const ctx = buildAuthContext({ method, url, headers, routeSpec, poolName });
		const result = await runAuthChain(ctx, authChain, this._loader);

		// Cache successful auth results (not denials — denials are not cacheable
		// because the same credential might be valid for a different route)
		if (result.allow && cacheKey) {
			this._cache.set(cacheKey, result);
		}

		return result;
	}
}
