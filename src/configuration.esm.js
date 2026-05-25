/**
 * JSMAWS Configuration
 * Centralized configuration holder with scoped access
 *
 * Provides hierarchical, lazy-loaded access to configuration with automatic
 * propagation of updates to all components holding a reference.
 *
 * Configuration pipeline:
 *   SLID file → NANOS.parseSLID() → nanos.toObject({ array: true }) → plain JS object
 *   → ValueResolver.resolveObject() → resolved plain JS object → Configuration.updateConfig()
 *
 * Plain JS objects are used internally (not NANOS) for:
 * - Standard property access (no .at() calls)
 * - JSON-serializable for IPC transmission
 * - Consistent with section 12.3 of the PolyTransport refactoring spec
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from '@nanos';
import { DELETE_SENTINEL } from './value-resolver.esm.js';

// Default network port values
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

/**
 * Default pool configuration used when no pools are defined in the config file.
 * Returns a new object each time to prevent accidental mutation.
 * @returns {Object} Default pools configuration (plain object)
 */
function getDefaultPoolsConfig () {
	return {
		standard: {
			minProcs: 1,
			maxProcs: 20,
			maxWorkers: 4,
			maxReqs: 100,
			reqTimeout: 60,
			conTimeout: 300,
		},
	};
}

/**
 * Configuration class
 * Holds all process configuration and provides scoped access
 */
export class Configuration {
	constructor (config = {}) {
		// Cached/computed values (invalidated on config update)
		// Note: _pools is not cached since config.pools is always a plain object reference
		this._routing = null;
		this._logging = null;

		// Delegate to updateConfig() to avoid code duplication
		this.updateConfig(config);
	}

	/**
	 * Load and parse a SLID file, returning a new Configuration instance.
	 * @param {string} filePath Path to the SLID file
	 * @returns {Promise<Configuration>} Loaded configuration
	 */
	static async fromFile (filePath) {
		const text = await Deno.readTextFile(filePath);
		return Configuration.fromSLID(text);
	}

	/**
	 * Create Configuration from SLID string
	 * @param {string} slidString SLID-formatted configuration string
	 * @returns {Configuration} New Configuration instance
	 */
	static fromSLID (slidString) {
		const nanos = NANOS.parseSLID(slidString);
		return new Configuration(nanos);
	}

	/**
	 * Get ACME challenge directory path
	 * @returns {string|undefined}
	 */
	get acmeChallengeDir () {
		return this.config.acmeChallengeDir;
	}

	/**
	 * Get top-level authn configuration (site-level default authentication providers).
	 * Returns the authn array (list of provider config objects), or empty array if not set.
	 * Per-route-group authn overrides are in routeGroups[name].authn.
	 * @returns {Array} Authn provider config array
	 */
	get authn () {
		const authn = this.config.authn;
		if (!authn) return [];
		return Array.isArray(authn) ? authn : Object.values(authn);
	}

	/**
	 * Get SSL certificate file path
	 * @returns {string|undefined}
	 */
	get certFile () {
		return this.config.certFile;
	}

	/**
	 * Get chunk size for PolyTransport (maxChunkBytes).
	 * This is the only chunking parameter retained after the PolyTransport refactoring.
	 * @returns {number} Chunk size in bytes (default: 65536)
	 */
	get chunkSize () {
		return this.config.chunkSize ?? 65536;
	}

	/**
	 * Get raw configuration value
	 * @param {string|Array} path Path to configuration value
	 * @param {*} defaultValue Default value if not found
	 * @returns {*} Configuration value
	 */
	get (path, defaultValue = undefined) {
		if (Array.isArray(path)) {
			let cur = this.config;
			for (const key of path) {
				if (cur == null || typeof cur !== 'object') return defaultValue;
				cur = cur[key];
			}
			return cur ?? defaultValue;
		}
		return this.config[path] ?? defaultValue;
	}

	/**
	 * Get allowed response types for a pool
	 * @param {string} poolName Pool name
	 * @returns {Set<string>} Set of allowed response types ('response', 'stream', 'bidi')
	 */
	getAllowedResponseTypes (poolName) {
		const poolConfig = this.getPoolConfig(poolName);
		const resType = poolConfig?.resType;

		if (!resType) {
			// Default: all types allowed (backward compatible)
			return new Set(['response', 'stream', 'bidi']);
		}

		// resType is a plain array (from toObject({ array: true })) or object
		if (Array.isArray(resType)) {
			return new Set(resType);
		}
		return new Set(Object.values(resType));
	}

	/**
	 * Get bidirectional connection parameters.
	 * Returns only maxChunkSize — the only bidi param needed by PolyTransport.
	 * Hierarchy: route > pool > global.
	 *
	 * @param {Object} options - Options object
	 * @param {string} [options.poolName] - Pool name (optional if routeSpec has pool field)
	 * @param {Object|null} [options.routeSpec] - Route specification (optional, plain object)
	 * @returns {{ maxChunkSize: number }} Bidi parameters
	 */
	getBidiParams ({ poolName, routeSpec } = {}) {
		// Extract poolName from routeSpec if not explicitly provided
		if (!poolName && routeSpec) {
			poolName = routeSpec.pool;
		}
		poolName = poolName || 'standard';

		const poolConfig = this.getPoolConfig(poolName);

		// Route > pool > global for maxChunkSize
		const routeMaxChunkSize = routeSpec?.maxChunkSize;
		const poolMaxChunkSize = poolConfig?.maxChunkSize;

		return {
			maxChunkSize: routeMaxChunkSize ?? poolMaxChunkSize ?? this.chunkSize,
		};
	}

	/**
	 * Get the effective appEnv for a request by merging global, pool, and route
	 * appEnv blocks. More-specific scopes override less-specific ones (route > pool > global).
	 *
	 * Merge rules (applied at each scope level):
	 *   - '*=:delete:' (DELETE_SENTINEL under key '*') clears all accumulated keys first
	 *   - Other DELETE_SENTINEL values remove the named key
	 *   - All other values override or add keys (coerced to strings)
	 *
	 * Values are already resolved strings (or DELETE_SENTINEL) at this point —
	 * no async resolution is needed here.
	 *
	 * @param {Object|null} routeSpec - Route specification (plain object, or null)
	 * @param {string} [poolName] - Pool name (falls back to routeSpec.pool, then 'standard')
	 * @returns {Object} Merged appEnv as a plain object with string values only
	 */
	getEffectiveAppEnv (routeSpec, poolName) {
		// Resolve pool name
		const resolvedPoolName = poolName ?? routeSpec?.pool ?? 'standard';
		const poolConfig = this.getPoolConfig(resolvedPoolName);

		// Collect the three appEnv blocks (may be undefined/null)
		const globalAppEnv = this.config.appEnv ?? null;
		const poolAppEnv = poolConfig?.appEnv ?? null;
		const routeAppEnv = routeSpec?.appEnv ?? null;

		// Merge in order: global → pool → route
		let merged = {};
		for (const block of [globalAppEnv, poolAppEnv, routeAppEnv]) {
			if (!block || typeof block !== 'object') continue;
			merged = this.#mergeAppEnvBlock(merged, block);
		}

		return merged;
	}

	/**
	 * Get specific pool configuration
	 * @param {string} poolName Pool name (e.g., '@router', 'standard', 'fast')
	 * @returns {Object|null} Pool configuration or null if not found
	 */
	getPoolConfig (poolName) {
		return this.pools[poolName] ?? null;
	}

	/**
	 * Get timeout configuration with hierarchy: route > pool > global
	 * @param {string} poolName Pool name
	 * @param {Object|null} routeSpec Route specification (optional, plain object)
	 * @returns {Object} Timeout configuration with reqTimeout, idleTimeout, conTimeout
	 */
	getTimeoutConfig (poolName, routeSpec = null) {
		// Global defaults (lowest priority)
		const defaults = {
			reqTimeout: this.config.reqTimeout ?? 30,
			idleTimeout: this.config.idleTimeout ?? 0,
			conTimeout: this.config.conTimeout ?? 0,
		};

		// Pool overrides (medium priority)
		const poolConfig = this.getPoolConfig(poolName);
		const poolTimeouts = {
			reqTimeout: poolConfig?.reqTimeout ?? defaults.reqTimeout,
			idleTimeout: poolConfig?.idleTimeout ?? defaults.idleTimeout,
			conTimeout: poolConfig?.conTimeout ?? defaults.conTimeout,
		};

		// Route overrides (highest priority)
		if (routeSpec) {
			return {
				reqTimeout: routeSpec.reqTimeout ?? poolTimeouts.reqTimeout,
				idleTimeout: routeSpec.idleTimeout ?? poolTimeouts.idleTimeout,
				conTimeout: routeSpec.conTimeout ?? poolTimeouts.conTimeout,
			};
		}

		return poolTimeouts;
	}

	/**
	 * Get server hostname
	 * @returns {string}
	 */
	get hostname () {
		return this.config.hostname ?? 'localhost';
	}

	/**
	 * Get hostRoutes configuration for multi-host SNI routing.
	 * Returns the hostRoutes object (hostname → routes/alias), or null if not set.
	 * When present, host-specific routing is used instead of top-level routes.
	 * @returns {Object|null} hostRoutes configuration (plain object) or null
	 */
	get hostRoutes () {
		return this.config.hostRoutes ?? null;
	}

	/**
	 * Get HTTP port
	 * @returns {number}
	 */
	get httpPort () {
		return this.config.httpPort ?? DEFAULT_HTTP_PORT;
	}

	/**
	 * Get HTTPS port
	 * @returns {number}
	 */
	get httpsPort () {
		return this.config.httpsPort ?? DEFAULT_HTTPS_PORT;
	}

	/**
	 * Get SSL private key file path
	 * @returns {string|undefined}
	 */
	get keyFile () {
		return this.config.keyFile;
	}

	/**
	 * Get logging configuration
	 * @returns {Object} Logging context with level, destination, format
	 */
	get logging () {
		if (!this._logging) {
			this._logging = {
				level: this.config.logLevel ?? 'info',
				destination: this.config.logDestination ?? 'console',
				format: this.config.logFormat ?? 'apache',
			};
		}
		return this._logging;
	}

	/**
	 * Merge one appEnv block into an accumulated result object.
	 * Applies wildcard-delete ('*') first, then per-key deletes and overrides.
	 * Values are coerced to strings; DELETE_SENTINEL values remove the key.
	 *
	 * @param {Object} accumulated - Current merged result (will not be mutated)
	 * @param {Object} block - appEnv block to merge in (already-resolved values)
	 * @returns {Object} New merged object
	 * @private
	 */
	#mergeAppEnvBlock (accumulated, block) {
		// Start empty on wildcard-delete; copy accumulated otherwise
		const result = (block['*'] === DELETE_SENTINEL) ? {} : { ...accumulated };

		// Process all other entries
		for (const [key, value] of Object.entries(block)) {
			if (key === '*') continue; // Already handled above

			if (value === DELETE_SENTINEL) {
				delete result[key];
			} else {
				// Coerce to string (SLID values may be numbers, booleans, etc.)
				result[key] = String(value);
			}
		}

		return result;
	}

	/**
	 * Merge configuration update (for partial updates)
	 * @param {Object} configUpdate Configuration fields to update (plain object)
	 */
	mergeConfig (configUpdate) {
		// Merge fields from update into existing config
		Object.assign(this.config, configUpdate);

		// Invalidate computed caches
		this._routing = null;
		this._logging = null;
	}

	/**
	 * Get MIME types configuration
	 * @returns {Object} MIME types mapping (plain object)
	 */
	get mimeTypes () {
		return this.config.mimeTypes ?? {};
	}

	/**
	 * Get noSSL flag (HTTP-only mode)
	 * @returns {boolean}
	 */
	get noSSL () {
		return this.config.noSSL ?? false;
	}

	/**
	 * Get pools configuration.
	 * Default pool configuration is applied by updateConfig() when no pools are defined,
	 * so this getter always returns the effective pools (never null/undefined).
	 * @returns {Object} Pools configuration (plain object)
	 */
	get pools () {
		return this.config.pools;
	}

	/**
	 * Get routeGroups configuration (named, reusable routing groups).
	 * Returns the routeGroups object (name → group definition), or empty object if not set.
	 * @returns {Object} routeGroups configuration (plain object)
	 */
	get routeGroups () {
		return this.config.routeGroups ?? {};
	}

	/**
	 * Get routes configuration
	 * @returns {Array} Routes configuration (plain array)
	 */
	get routes () {
		return this.config.routes ?? [];
	}

	/**
	 * Get routing configuration
	 * @returns {Object} Routing context with root, appRoot, extensions, fsRouting
	 */
	get routing () {
		if (!this._routing) {
			const rootSpec = this.config.root ?? '';
			const appRootSpec = this.config.appRoot ?? '';
			const extensionsSpec = this.config.extensions ?? ['.esm.js', '.js'];

			this._routing = {
				root: rootSpec.endsWith('/') ? rootSpec : (rootSpec ? rootSpec + '/' : ''),
				appRoot: appRootSpec.endsWith('/') ? appRootSpec : (appRootSpec ? appRootSpec + '/' : ''),
				extensions: Array.isArray(extensionsSpec) ? extensionsSpec : Object.values(extensionsSpec),
				fsRouting: this.config.fsRouting ?? false,
			};
		}
		return this._routing;
	}

	/**
	 * Set configuration value
	 * @param {string|Array} path Path to configuration value
	 * @param {*} value Value to set
	 */
	set (path, value) {
		if (Array.isArray(path)) {
			let cur = this.config;
			for (let i = 0; i < path.length - 1; i++) {
				if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') {
					cur[path[i]] = {};
				}
				cur = cur[path[i]];
			}
			cur[path[path.length - 1]] = value;
		} else {
			this.config[path] = value;
		}

		// Invalidate computed caches
		this._routing = null;
		this._logging = null;
	}

	/**
	 * Get shutdown delay in seconds.
	 * @returns {number} Shutdown delay in seconds (default: 30)
	 */
	get shutdownDelay () {
		return this.config.shutdownDelay ?? 30;
	}

	/**
	 * Get shutdown spread in seconds (normalized from config).
	 * Config value may be:
	 *   - 0 (or absent): no spread
	 *   - >= 1: spread in seconds (used as-is)
	 *   - 0 < value < 1: fraction of shutdownDelay (converted to seconds, minimum 1s)
	 * @returns {number} Spread in seconds (default: 0)
	 */
	get shutdownSpread () {
		const raw = this.config.shutdownSpread ?? 0;
		if (raw === 0) return 0;
		if (raw >= 1) return raw;
		// Fraction of shutdownDelay, minimum 1 second
		return Math.max(1, Math.round(raw * this.shutdownDelay));
	}

	/**
	 * Get SSL certificate check interval in hours
	 * @returns {number}
	 */
	get sslCheckIntervalHours () {
		return this.config.sslCheckIntervalHours ?? 1;
	}

	/**
	 * Update configuration (invalidates all caches).
	 * Applies default pool configuration when no pools are defined in the config.
	 * An explicitly empty pools object ({}) is respected as-is (no pools configured).
	 * @param {NANOS|Object} newConfig New configuration (NANOS or plain object from JSON.parse)
	 */
	updateConfig (newConfig) {
		if (newConfig instanceof NANOS) {
			this.config = newConfig.toObject({ array: true });
		} else {
			this.config = newConfig ?? {}; // Already a plain object (from JSON.parse or test)
		}

		// Apply default pool config if no pools are defined.
		// An explicitly empty pools object ({}) is respected as-is.
		if (this.config.pools == null) {
			this.config.pools = getDefaultPoolsConfig();
		}

		// Invalidate computed caches
		this._routing = null;
		this._logging = null;
	}
}
