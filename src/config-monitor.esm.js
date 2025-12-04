/**
 * JSMAWS Configuration Monitor
 * Monitors SLID configuration files for changes and triggers reloading
 *
 * Uses Deno's file watching capabilities to detect configuration updates
 * and notifies listeners when changes occur.
 *
 * Since logging depends on configuration, this module logs to the console.
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { parseSLID } from './vendor.esm.js';

/**
 * Configuration monitor for watching SLID files
 */
class ConfigMonitor {
	constructor (configPath, onConfigChange) {
		this.configPath = configPath;
		this.onConfigChange = onConfigChange;
		this.watcher = null;
		this.isMonitoring = false;
		this.lastModified = null;
		this.debounceTimer = null;
		this.debounceDelay = 500; // ms - debounce rapid file changes

		// Extract directory and filename for watching
		// Watch directory instead of file to handle atomic writes (rename operations)
		const pathParts = configPath.split('/');
		this.configFilename = pathParts[pathParts.length - 1];
		this.configDir = pathParts.slice(0, -1).join('/') || '.';
	}

	/**
	 * Start monitoring the configuration file
	 */
	async startMonitoring () {
		if (this.isMonitoring) {
			console.warn('[operator] Configuration monitor already running');
			return;
		}

		this.isMonitoring = true;
		console.info(`[operator] Starting configuration monitor for: ${this.configPath}`);

		try {
			// Get initial file modification time
			await this.updateLastModified();

			// Watch both the directory (for atomic writes/renames) and the file itself
			// (for in-place edits). Use non-recursive watching to avoid permission issues
			// with unreadable subdirectories. We check the file's mod time when either changes.
			this.watcher = Deno.watchFs([this.configDir, this.configPath], { recursive: false });

			// Process watch events in a separate task
			this.processWatchEvents();
		} catch (error) {
			console.error('[operator] Failed to start configuration monitor:', error.message);
			this.isMonitoring = false;
			throw error;
		}
	}

	/**
	 * Process file watch events
	 */
	async processWatchEvents () {
		try {
			for await (const event of this.watcher) {
				// Break if monitoring stopped
				if (!this.isMonitoring) {
					break;
				}

				// We're watching the config file and its directory (non-recursive).
				// Any modify or create event could be relevant (in-place edit or atomic write).
				// handleConfigChange will check the actual file mod time to confirm real changes.
				if (event.kind === 'modify' || event.kind === 'create') {
					// Debounce rapid changes
					this.debounceConfigChange();
				}
			}
		} catch (error) {
			// Ignore errors after monitoring stopped (watcher closed)
			if (this.isMonitoring) {
				console.error('[operator] Error in configuration monitor:', error.message);
			}
		}
	}

	/**
	 * Debounce configuration change detection
	 */
	debounceConfigChange () {
		// Clear existing timer
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		// Set new timer
		this.debounceTimer = setTimeout(async () => {
			try {
				await this.handleConfigChange();
			} catch (error) {
				console.error('[operator] Error handling configuration change:', error.message);
			}
		}, this.debounceDelay);
	}

	/**
	 * Handle configuration file change
	 */
	async handleConfigChange () {
		try {
			// Check if file was actually modified
			const newModified = await this.getFileModificationTime();
			if (newModified === this.lastModified) {
				return; // No actual change
			}

			this.lastModified = newModified;

			// Load new configuration
			const configText = await Deno.readTextFile(this.configPath);
			const newConfig = parseSLID(configText);

			console.info('[operator] Configuration file changed, reloading...');

			// Notify listener of configuration change
			if (this.onConfigChange) {
				try {
					await this.onConfigChange(newConfig);
				} catch (callbackError) {
					console.error('[console] Error in configuration change callback:', callbackError.message);
				}
			}
		} catch (error) {
			console.error('[console] Failed to reload configuration:', error.message);
		}
	}

	/**
	 * Update last modified time
	 */
	async updateLastModified () {
		this.lastModified = await this.getFileModificationTime();
	}

	/**
	 * Get file modification time
	 */
	async getFileModificationTime () {
		try {
			const stat = await Deno.stat(this.configPath);
			return stat.mtime ? stat.mtime.getTime() : null;
		} catch (error) {
			console.error(`[console] Failed to stat configuration file: ${error.message}`);
			return null;
		}
	}

	/**
	 * Stop monitoring the configuration file
	 */
	stopMonitoring () {
		if (!this.isMonitoring) {
			return;
		}

		this.isMonitoring = false;
		console.info('[console] Stopping configuration monitor');

		// Clear debounce timer
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		// Close watcher
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}
}

/**
 * Factory function to create a configuration monitor
 * @param {string} configPath Path to SLID configuration file
 * @param {Function} onConfigChange Callback when configuration changes
 * @returns {ConfigMonitor} Configuration monitor instance
 */
function createConfigMonitor (configPath, onConfigChange) {
	return new ConfigMonitor(configPath, onConfigChange);
}

export { ConfigMonitor, createConfigMonitor };
