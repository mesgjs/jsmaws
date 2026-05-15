/**
 * JSMAWS Operator Authn Runner
 * Runs operator-resident auth providers inline in the operator process, or
 * delegates external auth providers to the auth sub-process.
 *
 * Provider classification:
 * - Operator-resident providers (OPR_AUTH_PROVIDERS): stateless, run inline in the
 *   operator without an external sub-process (JWT, API key, Basic, test-identity).
 * - External auth providers: network-dependent providers (OAuth, LDAP, session stores,
 *   or any custom/external provider path) that run in the auth sub-process.
 *
 * Chain-splitting strategy:
 * - The chain is split at the first external (non-operator-resident) provider.
 * - The operator-resident prefix runs inline first. If a provider succeeds, no IPC needed.
 * - If the operator-resident prefix is exhausted without success and there is an external
 *   suffix, the remaining chain is delegated to the auth sub-process (when authDelegate
 *   is set). If no authDelegate is configured, the external suffix runs inline (fallback).
 *
 * This design minimizes IPC round-trips: requests authenticated by stateless operator-
 * resident providers (e.g. JWT for API endpoints) never touch the auth sub-process.
 *
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
 * Set of built-in provider specs that run inline in the operator process.
 * These are stateless providers that do not require network access.
 * All other provider specs (including custom paths) are treated as external
 * and delegated to the auth sub-process when one is configured.
 */
export const OPR_AUTH_PROVIDERS = new Set([
	'@test-identity',
	'@jwt',
	'@api-key',
	'@basic',
]);

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
 * Split an auth chain into an operator-resident prefix and an external suffix.
 * The split point is the first provider that is not in OPR_AUTH_PROVIDERS.
 *
 * @param {Array} authChain - Auth chain config array
 * @returns {{ oprChain: Array, extChain: Array }} Split chains
 */
export function splitAuthChain (authChain) {
	if (!authChain || !authChain.length) return { oprChain: [], extChain: [] };

	let splitIdx = authChain.length; // Default: all operator-resident (no external providers)
	for (let i = 0; i < authChain.length; i++) {
		const entry = authChain[i];
		if (!entry || typeof entry !== 'object') continue;
		const { provider: providerSpec } = entry;
		if (providerSpec && !OPR_AUTH_PROVIDERS.has(providerSpec)) {
			splitIdx = i;
			break;
		}
	}

	return {
		oprChain: authChain.slice(0, splitIdx),
		extChain: authChain.slice(splitIdx),
	};
}

/**
 * OperatorAuthn
 * Manages operator-resident authn with caching and optional auth sub-process delegation.
 *
 * Top-level authn runs before routing; the result (identity + provider) is
 * passed to the router for route-group authn filtering.
 */
export class OperatorAuthn {
	/**
	 * @param {Object} [opts]
	 * @param {Object} [opts.cacheConfig] - Cache configuration
	 * @param {number} [opts.cacheConfig.maxSize=1000] - Max cache entries
	 * @param {number} [opts.cacheConfig.defaultTtlSeconds=300] - Default TTL
	 * @param {AuthProviderLoader} [opts.loader] - Provider loader (for testing)
	 * @param {object} [opts.authDelegate] - OperatorAuthDelegate for external provider delegation (optional)
	 */
	constructor ({ cacheConfig = {}, loader, authDelegate } = {}) {
		this._cache = new OperatorAuthCache(cacheConfig);
		this._loader = loader ?? new AuthProviderLoader();
		this._authDelegate = authDelegate ?? null;
	}

	/**
	 * Clear the authn result cache.
	 * Called on config reload to invalidate stale results.
	 */
	clearCache () {
		this._cache.clear();
	}

	/**
	 * Run top-level authn for a request.
	 *
	 * Chain-splitting strategy:
	 * 1. Split the chain into operator-resident prefix and external suffix.
	 * 2. Run the operator-resident prefix inline. If a provider succeeds → return (cache result).
	 * 3. If operator-resident prefix exhausted without success and external suffix is non-empty:
	 *    a. If authDelegate is set → delegate external suffix to auth sub-process.
	 *    b. Otherwise → run external suffix inline (fallback, no auth sub-process configured).
	 * 4. Cache successful results.
	 *
	 * Returns an AuthnResult with identity and provider for use by the router.
	 * The router uses provider to evaluate route-group authn scalar filters.
	 *
	 * @param {Object} opts
	 * @param {string} opts.method - HTTP method
	 * @param {string} opts.url - Full request URL
	 * @param {Object} opts.headers - Request headers (plain object)
	 * @param {Array} [opts.topLevelAuthn] - Top-level authn array from config
	 * @returns {Promise<Object>} AuthnResult: { allow, identity, provider } or { allow: false, denyStatus, denyMessage }
	 */
	async runAuthn ({ method, url, headers, topLevelAuthn = [] }) {
		const authChain = topLevelAuthn ?? [];

		// No auth configured
		if (!authChain || authChain.length === 0) {
			return { allow: true, identity: null, provider: null };
		}

		// Try cache (keyed on the full chain's credential)
		const cacheKey = extractCacheKey(headers, authChain);
		if (cacheKey) {
			const cached = this._cache.get(cacheKey);
			if (cached) return cached;
		}

		// Split chain into operator-resident prefix and external suffix
		const { oprChain, extChain } = splitAuthChain(authChain);

		// Build auth context (used for inline runs)
		const ctx = buildAuthContext({ method, url, headers });

		// Step 1: Run operator-resident prefix inline
		if (oprChain.length > 0) {
			const oprResult = await runAuthnChain(ctx, oprChain, this._loader);

			if (!oprResult.allow) {
				// Explicit denial from operator-resident provider — stop immediately
				return oprResult;
			}

			if (oprResult.identity !== null || extChain.length === 0) {
				// Operator-resident provider succeeded (identity set) OR no external suffix to try
				// Cache and return
				if (oprResult.allow && cacheKey) {
					this._cache.set(cacheKey, oprResult);
				}
				return oprResult;
			}
			// oprResult.allow=true, identity=null → operator-resident prefix exhausted; try external suffix
		}

		// Step 2: Run external suffix (via delegate or inline fallback)
		if (extChain.length === 0) {
			// No external suffix — allow with null identity (all providers exhausted)
			return { allow: true, identity: null, provider: null };
		}

		let extResult;
		if (this._authDelegate) {
			// Delegate external suffix to auth sub-process
			extResult = await this._authDelegate.runAuthn({ method, url, headers, authChain: extChain });
		} else {
			// Fallback: run external suffix inline (no auth sub-process configured)
			extResult = await runAuthnChain(ctx, extChain, this._loader);
		}

		// Cache successful auth results (not denials)
		if (extResult.allow && cacheKey) {
			this._cache.set(cacheKey, extResult);
		}

		return extResult;
	}

	/**
	 * Set or replace the auth delegate (external auth sub-process).
	 * Called by the operator when the auth process pool is initialized or updated.
	 * @param {object|null} authDelegate - OperatorAuthDelegate instance, or null to disable
	 */
	setAuthDelegate (authDelegate) {
		this._authDelegate = authDelegate;
	}
}
