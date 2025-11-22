/**
 * JSMAWS Configuration Monitor
 * Monitors SLID configuration files for changes and triggers reloading
 *
 * Uses Deno's file watching capabilities to detect configuration updates
 * and notifies listeners when changes occur.
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
	}

	/**
	 * Start monitoring the configuration file
	 */
	async startMonitoring () {
		if (this.isMonitoring) {
			console.warn('Configuration monitor already running');
			return;
		}

		this.isMonitoring = true;
		console.log(`Starting configuration monitor for: ${this.configPath}`);

		try {
			// Get initial file modification time
			await this.updateLastModified();

			// Start watching the file
			this.watcher = Deno.watchFs([this.configPath]);

			// Process watch events in a separate task
			this.processWatchEvents();
		} catch (error) {
			console.error('Failed to start configuration monitor:', error.message);
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
				// Only process modify events
				if (event.kind === 'modify') {
					// Debounce rapid changes
					this.debounceConfigChange();
				}
			}
		} catch (error) {
			if (this.isMonitoring) {
				console.error('Error in configuration monitor:', error.message);
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
				console.error('Error handling configuration change:', error.message);
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

			console.log('Configuration file changed, reloading...');

			// Notify listener of configuration change
			if (this.onConfigChange) {
				await this.onConfigChange(newConfig);
			}
		} catch (error) {
			console.error('Failed to reload configuration:', error.message);
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
			console.error(`Failed to stat configuration file: ${error.message}`);
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
		console.log('Stopping configuration monitor');

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
