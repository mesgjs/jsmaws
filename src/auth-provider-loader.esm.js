/**
 * JSMAWS Auth Provider Loader
 * Loads and caches auth provider modules, resolves built-in provider aliases.
 *
 * Built-in provider aliases:
 *   @test-identity   → src/auth/test-identity.esm.js
 *   @jwt             → src/auth/jwt.esm.js
 *   @api-key         → src/auth/api-key.esm.js
 *   @basic           → src/auth/basic.esm.js
 *   @session         → src/auth/session.esm.js
 *   @oauth-is        → src/auth/oauth-introspect.esm.js
 *
 * Note: @allow-all and @deny-all are routing-layer constructs (scalar filters in
 * route-group authn), not provider modules. They are not loadable via this loader.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Map of built-in provider aliases to their module paths (relative to this file).
 */
const BUILTIN_PROVIDERS = {
	'@test-identity': './auth/test-identity.esm.js',
	'@jwt': './auth/jwt.esm.js',
	'@api-key': './auth/api-key.esm.js',
	'@basic': './auth/basic.esm.js',
	'@session': './auth/session.esm.js',
	'@oauth-is': './auth/oauth-introspect.esm.js',
};

/**
 * Required methods on an auth provider module.
 */
const REQUIRED_METHODS = ['authCheck'];

/**
 * AuthProviderLoader
 * Loads and caches auth provider modules.
 * Thread-safe: uses a promise-based cache to avoid duplicate loads.
 */
export class AuthProviderLoader {
	constructor () {
		// Cache: providerPath → Promise<provider module>
		this._cache = new Map();
	}

	/**
	 * Clear the provider cache.
	 * Useful for testing or after configuration reload.
	 */
	clearCache () {
		this._cache.clear();
	}

	/**
	 * Load an auth provider module by path or built-in alias.
	 * Results are cached after the first load.
	 *
	 * @param {string} providerSpec - Provider path or built-in alias (e.g. '@jwt', './auth/my-provider.esm.js')
	 * @param {string} [baseUrl] - Base URL for resolving relative paths (defaults to import.meta.url)
	 * @returns {Promise<Object>} Auth provider module (with authCheck method)
	 */
	async load (providerSpec, baseUrl = import.meta.url) {
		// Resolve built-in alias to module path
		const resolvedPath = BUILTIN_PROVIDERS[providerSpec] ?? providerSpec;

		// Use cache key based on the resolved path
		const cacheKey = resolvedPath;

		if (this._cache.has(cacheKey)) {
			return await this._cache.get(cacheKey);
		}

		// Create a promise for this load and cache it immediately to prevent
		// duplicate concurrent loads of the same provider.
		const loadPromise = this._loadModule(resolvedPath, baseUrl);
		this._cache.set(cacheKey, loadPromise);

		try {
			const provider = await loadPromise;
			return provider;
		} catch (error) {
			// Remove failed load from cache so it can be retried
			this._cache.delete(cacheKey);
			throw error;
		}
	}

	/**
	 * Load and validate a provider module.
	 * @param {string} resolvedPath - Resolved module path or URL
	 * @param {string} baseUrl - Base URL for relative path resolution
	 * @returns {Promise<Object>} Validated provider module
	 * @private
	 */
	async _loadModule (resolvedPath, baseUrl) {
		// Resolve the module URL
		let moduleUrl;
		if (resolvedPath.startsWith('https://') || resolvedPath.startsWith('http://') || resolvedPath.startsWith('file://')) {
			moduleUrl = resolvedPath;
		} else if (resolvedPath.startsWith('/')) {
			moduleUrl = `file://${resolvedPath}`;
		} else {
			// Relative path: resolve against baseUrl
			moduleUrl = new URL(resolvedPath, baseUrl).href;
		}

		let module;
		try {
			module = await import(moduleUrl);
		} catch (error) {
			throw new Error(`Failed to load auth provider "${resolvedPath}": ${error.message}`);
		}

		// Auth providers export a default object with authCheck method
		const provider = module.default ?? module;

		if (!provider || typeof provider !== 'object') {
			throw new Error(`Auth provider "${resolvedPath}" must export a default object`);
		}

		// Validate required methods
		for (const method of REQUIRED_METHODS) {
			if (typeof provider[method] !== 'function') {
				throw new Error(`Auth provider "${resolvedPath}" is missing required method: ${method}()`);
			}
		}

		return provider;
	}
}

/**
 * Singleton loader instance for use in production code.
 * Tests should create their own instances.
 */
export const authProviderLoader = new AuthProviderLoader();
