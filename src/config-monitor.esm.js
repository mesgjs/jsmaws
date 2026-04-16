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

import { parseSLID } from '@nanos';

/**
 * Configuration monitor for watching SLID files
 */
class ConfigMonitor {
	constructor (configPath, onChange, { debounceDelay = 500 } = {}) {
		this.configPath = configPath;
		this.onChange = onChange;
		this.watcher = null;
		this.isMonitoring = false;
		this.lastRead = Date.now(); // When the configuration was last read
		this.lastModified = null; // When the file was last modified
		this.debounceTimer = null;
		this.debounceDelay = debounceDelay; // ms - debounce rapid file changes

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
				// Any create/modify/rename event could be relevant (in-place edit or atomic write).
				// debounceChanges will check the actual file mod time to confirm real changes.
				switch (event.kind) {
				case 'create':
				case 'modify':
				case 'rename':
					// console.debug('fs change:', event);
					await this.debounceChanges();
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
	async debounceChanges () {
		// Maintain the status quo if the file is present and hasn't changed.
		const curModTime = await this.getFileModificationTime();
		if (curModTime && curModTime === this.lastModified) return;

		// The file changed or went away. Clear the existing timer.
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		if (!curModTime || !this.isMonitoring) return;
		// The file is present, the modification time has changed (and we're still monitoring).
		this.lastModified = curModTime;

		// Set the debounce timer to check for more changes.
		this.debounceTimer = setTimeout(async () => {
			try {
				this.debounceTimer = null;
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
		if (this.lastRead >= this.lastModified) return; // Already read since last change
		try {
			// Load new configuration
			const configText = await Deno.readTextFile(this.configPath);
			this.lastread = Date.now();
			const newConfig = parseSLID(configText);

			console.info('[operator] Configuration file changed, reloading...');

			// Notify listener of configuration change
			if (this.onChange) {
				try {
					await this.onChange(newConfig);
				} catch (callbackError) {
					console.error('[console] Error in configuration change callback:', callbackError.message);
				}
			}
		} catch (error) {
			console.error('[console] Failed to reload configuration:', error.message);
		}
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
 * @param {Function} onChange Callback when configuration changes
 * @returns {ConfigMonitor} Configuration monitor instance
 */
function createConfigMonitor (configPath, onChange) {
	return new ConfigMonitor(configPath, onChange);
}

export { ConfigMonitor, createConfigMonitor };
