/**
 * JSMAWS File Monitor
 * Monitors a file for changes and notifies a callback when the file is modified.
 *
 * Uses Deno's file watching capabilities to detect file updates.
 * The callback receives the file path (a string); the caller is responsible
 * for reading and interpreting the new file content.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * File monitor for watching a single file for changes
 */
export class FileMonitor {
	constructor (filePath, onChange, { debounceDelay = 500 } = {}) {
		this.filePath = filePath;
		this.onChange = onChange;
		this.watcher = null;
		this.isMonitoring = false;
		this.lastRead = Date.now(); // When the file was last read
		this.lastModified = null; // When the file was last modified
		this.debounceTimer = null;
		this.debounceDelay = debounceDelay; // ms - debounce rapid file changes

		// Extract directory and filename for watching
		// Watch directory instead of file to handle atomic writes (rename operations)
		const pathParts = filePath.split('/');
		this.filename = pathParts[pathParts.length - 1];
		this.dir = pathParts.slice(0, -1).join('/') || '.';
	}

	/**
	 * Start monitoring the file
	 */
	async startMonitoring () {
		if (this.isMonitoring) {
			console.warn(`File monitor already running for: ${this.filePath}`);
			return;
		}

		this.isMonitoring = true;
		console.info(`Starting file monitor for: ${this.filePath}`);

		try {
			// Watch both the directory (for atomic writes/renames) and the file itself
			// (for in-place edits). Use non-recursive watching to avoid permission issues
			// with unreadable subdirectories. We check the file's mod time when either changes.
			this.watcher = Deno.watchFs([this.dir, this.filePath], { recursive: false });

			// Process watch events in a separate task
			this.processWatchEvents();
		} catch (error) {
			console.error('Failed to start file monitor:', error.message);
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

				// We're watching the file and its directory (non-recursive).
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
				console.error('Error in file monitor:', error.message);
			}
		}
	}

	/**
	 * Debounce file change detection
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
				await this.handleFileChange();
			} catch (error) {
				console.error('Error handling file change:', error.message);
			}
		}, this.debounceDelay);
	}

	/**
	 * Handle file change — notify the callback with the file path
	 */
	async handleFileChange () {
		if (this.lastRead >= this.lastModified) return; // Already read since last change
		this.lastRead = Date.now();

		console.info(`File changed: ${this.filePath}`);

		if (this.onChange) {
			try {
				await this.onChange(this.filePath);
			} catch (callbackError) {
				console.error('Error in file change callback:', callbackError.message);
			}
		}
	}

	/**
	 * Get file modification time
	 */
	async getFileModificationTime () {
		try {
			const stat = await Deno.stat(this.filePath);
			return stat.mtime ? stat.mtime.getTime() : null;
		} catch (error) {
			console.error(`Failed to stat file: ${error.message}`);
			return null;
		}
	}

	/**
	 * Stop monitoring the file
	 */
	stopMonitoring () {
		if (!this.isMonitoring) {
			return;
		}

		this.isMonitoring = false;
		console.info('Stopping file monitor');

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
