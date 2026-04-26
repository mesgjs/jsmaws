/**
 * JSMAWS Configuration
 * Centralized configuration holder with scoped access
 *
 * Provides hierarchical, lazy-loaded access to configuration with automatic
 * propagation of updates to all components holding a reference.
 *
 * Configuration pipeline:
 *   SLID file → NANOS.parseSLID() → nanos.toObject({ array: true }) → plain JS object
 *
 * Plain JS objects are used internally (not NANOS) for:
 * - Standard property access (no .at() calls)
 * - JSON-serializable for IPC transmission
 * - Consistent with section 12.3 of the PolyTransport refactoring spec
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from '@nanos';

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
	 * Get server hostname
	 * @returns {string}
	 */
	get hostname () {
		return this.config.hostname ?? 'localhost';
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
	 * Get noSSL flag (HTTP-only mode)
	 * @returns {boolean}
	 */
	get noSSL () {
		return this.config.noSSL ?? false;
	}

	/**
	 * Get SSL certificate check interval in hours
	 * @returns {number}
	 */
	get sslCheckIntervalHours () {
		return this.config.sslCheckIntervalHours ?? 1;
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
	 * Get pools configuration.
	 * Default pool configuration is applied by updateConfig() when no pools are defined,
	 * so this getter always returns the effective pools (never null/undefined).
	 * @returns {Object} Pools configuration (plain object)
	 */
	get pools () {
		return this.config.pools;
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
	 * Serialize configuration to SLID format
	 * @returns {string} SLID-formatted configuration string
	 */
	toSLID () {
		// Convert plain object back to NANOS for SLID serialization
		const nanos = new NANOS();
		nanos.setOpts({ transform: true });
		nanos.push(this.config);
		return nanos.toSLID();
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
