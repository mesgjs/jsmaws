/**
 * JSMAWS Configuration
 * Centralized configuration holder with scoped access
 * 
 * Provides hierarchical, lazy-loaded access to configuration with automatic
 * propagation of updates to all components holding a reference.
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';

/**
 * Configuration class
 * Holds all process configuration and provides scoped access
 */
export class Configuration {
	constructor (config = new NANOS()) {
		// Normalize config to NANOS if it's a plain object (from postMessage)
		if (config instanceof NANOS) {
			this.config = config;
		} else {
			// Recursively convert plain objects to NANOS
			this.config = new NANOS();
			this.config.setOpts({ transform: true });
			this.config.push(config);
		}

		this.processType = null; // 'operator', 'router', 'responder'
		this.processId = null;

		// Cached/computed values (invalidated on config update)
		this._routing = null;
		this._pools = null;
		this._ipc = null;
		this._logging = null;
		this._chunking = null;
		this._bidiFlowControl = null;
	}

	/**
	 * Get routing configuration
	 * @returns {Object} Routing context with root, appRoot, extensions, fsRouting
	 */
	get routing () {
		if (!this._routing) {
			const rootSpec = this.config.at('root', '');
			const appRootSpec = this.config.at('appRoot', '');
			const extensionsSpec = this.config.at('extensions', new NANOS(['.esm.js', '.js']));

			this._routing = {
				root: rootSpec.endsWith('/') ? rootSpec : (rootSpec ? rootSpec + '/' : ''),
				appRoot: appRootSpec.endsWith('/') ? appRootSpec : (appRootSpec ? appRootSpec + '/' : ''),
				extensions: extensionsSpec instanceof NANOS ? Array.from(extensionsSpec.values()) : ['.esm.js', '.js'],
				fsRouting: this.config.at('fsRouting', false)
			};
		}
		return this._routing;
	}

	/**
	 * Get pools configuration
	 * @returns {NANOS} Pools configuration
	 */
	get pools () {
		if (!this._pools) {
			this._pools = this.config.at('pools', new NANOS());
		}
		return this._pools;
	}

	/**
	 * Get specific pool configuration
	 * @param {string} poolName Pool name (e.g., '@router', 'standard', 'fast')
	 * @returns {NANOS|null} Pool configuration or null if not found
	 */
	getPoolConfig (poolName) {
		return this.pools.at(poolName, null);
	}

	/**
	 * Get IPC configuration
	 * @returns {Object} IPC context with timeout, bufferSize, etc.
	 */
	get ipc () {
		if (!this._ipc) {
			this._ipc = {
				timeout: this.config.at('ipcTimeout', 30000),
				bufferSize: this.config.at('ipcBufferSize', 65536),
			};
		}
		return this._ipc;
	}

	/**
	 * Get logging configuration
	 * @returns {Object} Logging context with level, destination, etc.
	 */
	get logging () {
		if (!this._logging) {
			this._logging = {
				level: this.config.at('logLevel', 'info'),
				destination: this.config.at('logDestination', 'console'),
				format: this.config.at('logFormat', 'apache'),
			};
		}
		return this._logging;
	}

	/**
	 * Get chunking configuration
	 * @returns {Object} Chunking context with thresholds and sizes
	 */
	get chunking () {
		if (!this._chunking) {
			this._chunking = {
				maxDirectWrite: this.config.at('maxDirectWrite', 65536),
				autoChunkThresh: this.config.at('autoChunkThresh', 10485760),
				chunkSize: this.config.at('chunkSize', 65536),
				maxWriteBuffer: this.config.at('maxWriteBuffer', 1048576),
				bpWriteTimeThresh: this.config.at('bpWriteTimeThresh', 50),
			};
		}
		return this._chunking;
	}

	/**
	 * Get bidirectional flow control configuration
	 * @returns {Object} Bidi flow control context with credit and buffer settings
	 */
	get bidiFlowControl () {
		if (!this._bidiFlowControl) {
			const bidiConfig = this.config.at('bidiFlowControl') || { at (_n, d) { return d; } };
			this._bidiFlowControl = {
				initialCredits: bidiConfig.at('initialCredits', 10),
				maxBufferSize: bidiConfig.at('maxBufferSize', 1048576),
				maxBytesPerSecond: bidiConfig.at('maxBytesPerSecond', 10485760),
				idleTimeout: bidiConfig.at('idleTimeout', 60)
			};
		}
		return this._bidiFlowControl;
	}

	/**
	 * Get MIME types configuration
	 * @returns {NANOS} MIME types mapping
	 */
	get mimeTypes () {
		return this.config.at('mimeTypes', new NANOS());
	}

	/**
	 * Get routes configuration
	 * @returns {NANOS} Routes configuration
	 */
	get routes () {
		return this.config.at('routes', new NANOS());
	}

	/**
	 * Update configuration (invalidates all caches)
	 * @param {NANOS|Object} newConfig New configuration (NANOS or plain object from postMessage)
	 */
	updateConfig (newConfig) {
		// Normalize config to NANOS if it's a plain object (from postMessage)
		if (newConfig instanceof NANOS) {
			this.config = newConfig;
		} else {
			// Recursively convert plain objects to NANOS
			this.config = new NANOS();
			this.config.setOpts({ transform: true });
			this.config.push(newConfig);
		}

		// Invalidate all cached values
		this._routing = null;
		this._pools = null;
		this._ipc = null;
		this._logging = null;
		this._chunking = null;
		this._bidiFlowControl = null;
	}

	/**
	 * Merge configuration update (for partial updates)
	 * @param {NANOS} configUpdate Configuration fields to update
	 */
	mergeConfig (configUpdate) {
		// Merge fields from update into existing config
		this.config.fromEntries(configUpdate.namedEntries());

		// Invalidate all cached values
		this._routing = null;
		this._pools = null;
		this._ipc = null;
		this._logging = null;
		this._chunking = null;
		this._bidiFlowControl = null;
	}

	/**
	 * Get raw configuration value
	 * @param {string|Array} path Path to configuration value
	 * @param {*} defaultValue Default value if not found
	 * @returns {*} Configuration value
	 */
	get (path, defaultValue = undefined) {
		return this.config.at(path, defaultValue);
	}

	/**
	 * Set configuration value
	 * @param {string} name Name of configuration value
	 * @param {*} value Value to set
	 */
	set (name, value) {
		this.config.set(name, value);

		// Invalidate caches that might be affected
		// (Could be more granular, but simple invalidation is safer)
		this._routing = null;
		this._pools = null;
		this._ipc = null;
		this._logging = null;
		this._chunking = null;
		this._bidiFlowControl = null;
	}

	/**
	 * Serialize configuration to SLID format
	 * @returns {string} SLID-formatted configuration string
	 */
	toSLID () {
		return this.config.toSLID();
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
}
