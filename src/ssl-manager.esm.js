/**
 * SSL Certificate Manager for JSMAWS
 * 
 * Monitors SSL certificate files for changes and triggers server reloads
 * when certificates are updated (e.g., by Let's Encrypt ACME client).
 * 
 * Features:
 * - Monitors certificate and key files for changes
 * - Detects symlink target changes (common with certbot)
 * - Triggers graceful server reload on certificate updates
 * - Supports "noSSL" mode for development/localhost
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

const HOURS_TO_MS = 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_HOURS = 1; // Check once per hour by default

/**
 * SSL Manager class
 * Monitors certificate files and triggers reload callbacks when they change
 */
export class SSLManager {
	constructor (options = {}) {
		this.certFile = options.certFile;
		this.keyFile = options.keyFile;
		this.noSSL = options.noSSL || false;
		this.reloadCallback = options.reloadCallback || null;

		// Check interval in hours (default: 1 hour)
		// Can be overridden with checkIntervalHours option
		this.checkIntervalHours = options.checkIntervalHours || DEFAULT_CHECK_INTERVAL_HOURS;
		this.checkIntervalMs = this.checkIntervalHours * HOURS_TO_MS;

		this.watcher = null;
		this.intervalId = null;
		this.lastCertMtime = null;
		this.lastKeyMtime = null;
		this.lastCertTarget = null;
		this.lastKeyTarget = null;
		this.isMonitoring = false;
	}

	/**
	 * Get file modification time and symlink target
	 * @param {string} filepath Path to file
	 * @returns {Promise<{mtime: Date|null, target: string|null}>}
	 */
	async getFileInfo (filepath) {
		try {
			// Get file stats
			const stat = await Deno.lstat(filepath);
			const mtime = stat.mtime;

			// Check if it's a symlink and get target
			let target = null;
			if (stat.isSymlink) {
				target = await Deno.readLink(filepath);
			}

			return { mtime, target };
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) {
				return { mtime: null, target: null };
			}
			throw error;
		}
	}

	/**
	 * Check if certificate files have changed
	 * @returns {Promise<boolean>} True if files changed
	 */
	async checkForChanges () {
		if (this.noSSL || !this.certFile || !this.keyFile) {
			return false;
		}

		try {
			const certInfo = await this.getFileInfo(this.certFile);
			const keyInfo = await this.getFileInfo(this.keyFile);

			// Check if files exist
			if (!certInfo.mtime || !keyInfo.mtime) {
				console.warn('SSL certificate files not found');
				return false;
			}

			// Initialize on first check
			if (this.lastCertMtime === null) {
				this.lastCertMtime = certInfo.mtime;
				this.lastKeyMtime = keyInfo.mtime;
				this.lastCertTarget = certInfo.target;
				this.lastKeyTarget = keyInfo.target;
				return false;
			}

			// Check for changes in modification time or symlink target
			const certChanged = 
				certInfo.mtime.getTime() !== this.lastCertMtime.getTime() ||
				certInfo.target !== this.lastCertTarget;

			const keyChanged = 
				keyInfo.mtime.getTime() !== this.lastKeyMtime.getTime() ||
				keyInfo.target !== this.lastKeyTarget;

			if (certChanged || keyChanged) {
				console.log('SSL certificate files changed:');
				if (certChanged) {
					console.log(`  Certificate: ${this.certFile}`);
					if (certInfo.target !== this.lastCertTarget) {
						console.log(`    Symlink target changed: ${this.lastCertTarget} -> ${certInfo.target}`);
					}
				}
				if (keyChanged) {
					console.log(`  Key: ${this.keyFile}`);
					if (keyInfo.target !== this.lastKeyTarget) {
						console.log(`    Symlink target changed: ${this.lastKeyTarget} -> ${keyInfo.target}`);
					}
				}

				// Update stored values
				this.lastCertMtime = certInfo.mtime;
				this.lastKeyMtime = keyInfo.mtime;
				this.lastCertTarget = certInfo.target;
				this.lastKeyTarget = keyInfo.target;

				return true;
			}

			return false;
		} catch (error) {
			console.error('Error checking certificate files:', error.message);
			return false;
		}
	}

	/**
	 * Start monitoring certificate files
	 */
	async startMonitoring () {
		if (this.isMonitoring) {
			console.warn('SSL monitoring already started');
			return;
		}

		if (this.noSSL) {
			console.log('SSL monitoring disabled (noSSL mode)');
			return;
		}

		if (!this.certFile || !this.keyFile) {
			console.log('SSL monitoring disabled (no certificate files configured)');
			return;
		}

		console.log('Starting SSL certificate monitoring...');
		console.log(`  Certificate: ${this.certFile}`);
		console.log(`  Key: ${this.keyFile}`);
		console.log(`  Check interval: ${this.checkIntervalHours} hour(s)`);

		this.isMonitoring = true;

		// Initialize file info
		await this.checkForChanges();

		// Set up periodic checking
		this.intervalId = setInterval(async () => {
			const changed = await this.checkForChanges();
			if (changed && this.reloadCallback) {
				console.log('Triggering server reload due to certificate update...');
				try {
					await this.reloadCallback();
				} catch (error) {
					console.error('Error during reload callback:', error.message);
				}
			}
		}, this.checkIntervalMs);

		console.log('SSL certificate monitoring started');
	}

	/**
	 * Stop monitoring certificate files
	 */
	stopMonitoring () {
		if (!this.isMonitoring) {
			return;
		}

		console.log('Stopping SSL certificate monitoring...');

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.isMonitoring = false;
		console.log('SSL certificate monitoring stopped');
	}

	/**
	 * Validate that certificate files exist and are readable
	 * @returns {Promise<{valid: boolean, error: string|null}>}
	 */
	async validateCertificates () {
		if (this.noSSL) {
			return { valid: true, error: null };
		}

		if (!this.certFile || !this.keyFile) {
			return { 
				valid: false, 
				error: 'Certificate or key file not configured' 
			};
		}

		try {
			// Try to read both files
			await Deno.readTextFile(this.certFile);
			await Deno.readTextFile(this.keyFile);
			return { valid: true, error: null };
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) {
				return { 
					valid: false, 
					error: `Certificate file not found: ${error.message}` 
				};
			}
			if (error instanceof Deno.errors.PermissionDenied) {
				return { 
					valid: false, 
					error: `Permission denied reading certificate files: ${error.message}` 
				};
			}
			return { 
				valid: false, 
				error: `Error reading certificate files: ${error.message}` 
			};
		}
	}
}

/**
 * Create an SSL manager from server configuration
 * @param {Object} config Server configuration object
 * @param {Function} reloadCallback Callback to trigger server reload
 * @returns {SSLManager}
 */
export function createSSLManager (config, reloadCallback) {
	return new SSLManager({
		certFile: config.certFile,
		keyFile: config.keyFile,
		noSSL: config.noSSL || false,
		reloadCallback,
		checkIntervalHours: config.sslCheckIntervalHours || DEFAULT_CHECK_INTERVAL_HOURS,
	});
}