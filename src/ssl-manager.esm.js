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
 * - Logs WARN if certificate expires within 30 days
 * - Logs ERROR if certificate is already expired
 * 
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

const HOURS_TO_MS = 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_HOURS = 1; // Check once per hour by default
const WARN_DAYS_BEFORE_EXPIRY = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ASN.1 tag constants
const ASN1_SEQUENCE = 0x30;
const ASN1_UTC_TIME = 0x17;
const ASN1_GENERALIZED_TIME = 0x18;

/**
 * Check certificate expiry and log appropriate warnings.
 * - Logs ERROR if certificate is already expired
 * - Logs WARN if certificate expires within WARN_DAYS_BEFORE_EXPIRY days
 * - Logs INFO with expiry date otherwise
 *
 * @param {string} certPem PEM-encoded certificate
 * @param {Object} logger Logger instance (must have .error(), .warn(), .info())
 * @param {string} [certFile] Optional file path for log context
 * @param {number|undefined} [now] Current time as ms-since-epoch number or undefined
 *   returning ms-since-epoch (default: Date.now()). Accepts a fixed number for testing.
 * @returns {Date|null} The notAfter date, or null if parsing failed
 */
export function checkCertificateExpiry (certPem, logger, certFile = '', now = Date.now()) {
	const notAfter = parseCertificateExpiry(certPem);
	const fileLabel = certFile ? ` (${certFile})` : '';

	if (!notAfter) {
		logger.warn(`SSL certificate${fileLabel}: could not parse expiry date`);
		return null;
	}

	const msUntilExpiry = notAfter.getTime() - now;
	const daysUntilExpiry = Math.floor(msUntilExpiry / MS_PER_DAY);

	if (msUntilExpiry <= 0) {
		logger.error(`SSL certificate${fileLabel} EXPIRED on ${notAfter.toISOString()} (${Math.abs(daysUntilExpiry)} day(s) ago)`);
	} else if (daysUntilExpiry < WARN_DAYS_BEFORE_EXPIRY) {
		logger.warn(`SSL certificate${fileLabel} expires in ${daysUntilExpiry} day(s) on ${notAfter.toISOString()}`);
	} else {
		logger.info(`SSL certificate${fileLabel} valid until ${notAfter.toISOString()} (${daysUntilExpiry} day(s) remaining)`);
	}

	return notAfter;
}

/**
 * Parse an ASN.1 UTCTime or GeneralizedTime string to a Date.
 * UTCTime:        YYMMDDHHMMSSZ
 * GeneralizedTime: YYYYMMDDHHMMSSZ
 * @param {string} timeStr
 * @param {number} tag ASN1_UTC_TIME or ASN1_GENERALIZED_TIME
 * @returns {Date|null}
 */
function parseAsn1Time (timeStr, tag) {
	const field = (from, to) => parseInt(timeStr.slice(from, to), 10);
	try {
		let year, month, day, hour, minute, second;
		if (tag === ASN1_UTC_TIME) {
			// YYMMDDHHMMSSZ — 2-digit year: 00-49 → 2000-2049, 50-99 → 1950-1999
			const yy = field(0, 2);
			year = yy >= 50 ? 1900 + yy : 2000 + yy;
			month = field(2, 4);
			day = field(4, 6);
			hour = field(6, 8);
			minute = field(8, 10);
			second = field(10, 12);
		} else {
			// YYYYMMDDHHMMSSZ
			year = field(0, 4);
			month = field(4, 6);
			day = field(6, 8);
			hour = field(8, 10);
			minute = field(10, 12);
			second = field(12, 14);
		}
		return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	} catch {
		return null;
	}
}

/**
 * Extract the notAfter date from a PEM-encoded X.509 certificate.
 *
 * X.509 structure (simplified):
 *   Certificate ::= SEQUENCE {
 *     tbsCertificate TBSCertificate,
 *     ...
 *   }
 *   TBSCertificate ::= SEQUENCE {
 *     version         [0] EXPLICIT INTEGER OPTIONAL,
 *     serialNumber    INTEGER,
 *     signature       AlgorithmIdentifier,
 *     issuer          Name,
 *     validity        Validity,
 *     ...
 *   }
 *   Validity ::= SEQUENCE {
 *     notBefore Time,
 *     notAfter  Time
 *   }
 *
 * We walk the outer SEQUENCE → inner SEQUENCE (TBSCertificate) → skip fields
 * until we reach the Validity SEQUENCE, then read notAfter.
 *
 * @param {string} certPem PEM-encoded certificate string
 * @returns {Date|null} notAfter date, or null if parsing fails
 */
export function parseCertificateExpiry (certPem) {
	try {
		// Extract base64 body from PEM
		const match = certPem.match(/-----BEGIN CERTIFICATE-----\s*([\s\S]+?)\s*-----END CERTIFICATE-----/);
		if (!match) return null;

		const b64 = match[1].replace(/\s+/g, '');
		const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

		let pos = 0;

		// Helper: read a TLV (tag, length, value) at pos; returns { tag, valueStart, valueLen, nextPos }
		const readTlv = (offset) => {
			const tag = der[offset];
			const { length, bytesRead } = readDerLength(der, offset + 1);
			const valueStart = offset + 1 + bytesRead;
			return { tag, valueStart, valueLen: length, nextPos: valueStart + length };
		};

		// Outer Certificate SEQUENCE
		const cert = readTlv(pos);
		if (cert.tag !== ASN1_SEQUENCE) return null;
		pos = cert.valueStart;

		// TBSCertificate SEQUENCE
		const tbs = readTlv(pos);
		if (tbs.tag !== ASN1_SEQUENCE) return null;
		pos = tbs.valueStart;
		const tbsEnd = tbs.nextPos;

		// Walk TBSCertificate fields to find Validity SEQUENCE.
		// Fields before Validity (in order):
		//   [0] version (optional, context tag 0xa0)
		//   INTEGER serialNumber
		//   SEQUENCE signature AlgorithmIdentifier
		//   SEQUENCE issuer Name
		//   SEQUENCE validity  ← this is what we want
		//
		// We skip fields until we find the 4th (or 5th if version present) SEQUENCE.
		// More robustly: skip until we've seen 3 SEQUENCEs (signature, issuer, validity).
		// Actually the simplest approach: skip version (if present), serialNumber, then
		// count SEQUENCEs: first = signature, second = issuer, third = validity.

		// Skip optional version [0] EXPLICIT
		if (der[pos] === 0xa0) {
			const v = readTlv(pos);
			pos = v.nextPos;
		}

		// Skip serialNumber INTEGER (tag 0x02)
		if (der[pos] === 0x02) {
			const sn = readTlv(pos);
			pos = sn.nextPos;
		}

		// Skip signature AlgorithmIdentifier SEQUENCE
		if (der[pos] === ASN1_SEQUENCE) {
			const sig = readTlv(pos);
			pos = sig.nextPos;
		}

		// Skip issuer Name SEQUENCE
		if (der[pos] === ASN1_SEQUENCE) {
			const issuer = readTlv(pos);
			pos = issuer.nextPos;
		}

		// Now at Validity SEQUENCE
		if (pos >= tbsEnd || der[pos] !== ASN1_SEQUENCE) return null;
		const validity = readTlv(pos);
		pos = validity.valueStart;

		// Skip notBefore Time (UTCTime or GeneralizedTime)
		const notBeforeTag = der[pos];
		if (notBeforeTag !== ASN1_UTC_TIME && notBeforeTag !== ASN1_GENERALIZED_TIME) return null;
		const notBefore = readTlv(pos);
		pos = notBefore.nextPos;

		// Read notAfter Time
		const notAfterTag = der[pos];
		if (notAfterTag !== ASN1_UTC_TIME && notAfterTag !== ASN1_GENERALIZED_TIME) return null;
		const notAfterTlv = readTlv(pos);
		const timeStr = new TextDecoder().decode(der.slice(notAfterTlv.valueStart, notAfterTlv.nextPos));

		return parseAsn1Time(timeStr, notAfterTag);
	} catch {
		return null;
	}
}

/**
 * Read an ASN.1 DER length field starting at offset in a Uint8Array.
 * Returns { length, bytesRead }.
 * @param {Uint8Array} der
 * @param {number} offset
 * @returns {{ length: number, bytesRead: number }}
 */
function readDerLength (der, offset) {
	const first = der[offset];
	if (first < 0x80) {
		return { length: first, bytesRead: 1 };
	}
	const numBytes = first & 0x7f;
	let length = 0;
	for (let i = 0; i < numBytes; i++) {
		length = (length << 8) | der[offset + 1 + i];
	}
	return { length, bytesRead: 1 + numBytes };
}

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
		this.logger = options.logger || console;
		// Certificate validity-check reference time (ms from epoch) for testing
		// Default is undefined (certificate check will use real time)
		this.certRefTime = options.certRefTime ?? undefined;

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
	 * Check certificate expiry and log warnings if needed.
	 * Reads the certificate file and calls checkCertificateExpiry().
	 * No-op if logger is not set or certFile is not configured.
	 * @returns {Promise<Date|null>} The notAfter date, or null if unavailable
	 */
	async checkExpiry () {
		if (!this.logger || !this.certFile) return null;

		try {
			const certPem = await Deno.readTextFile(this.certFile);
			return checkCertificateExpiry(certPem, this.logger, this.certFile, this.certRefTime);
		} catch (error) {
			this.logger.warn(`SSL certificate (${this.certFile}): could not read file for expiry check: ${error.message}`);
			return null;
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
				console.error('SSL certificate files not found');
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
				console.info('SSL certificate files changed');
				if (certChanged) {
					console.debug(`  Certificate: ${this.certFile}`);
					if (certInfo.target !== this.lastCertTarget) {
						console.debug(`    Symlink target changed: ${this.lastCertTarget} -> ${certInfo.target}`);
					}
				}
				if (keyChanged) {
					console.debug(`  Key: ${this.keyFile}`);
					if (keyInfo.target !== this.lastKeyTarget) {
						console.debug(`    Symlink target changed: ${this.lastKeyTarget} -> ${keyInfo.target}`);
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
	 * Start monitoring certificate files
	 */
	async startMonitoring () {
		if (this.isMonitoring) {
			console.warn('SSL monitoring already started');
			return;
		}

		if (this.noSSL) {
			console.info('SSL monitoring disabled (noSSL mode)');
			return;
		}

		if (!this.certFile || !this.keyFile) {
			console.warn('SSL monitoring disabled (no certificate files configured)');
			return;
		}

		console.info('Starting SSL certificate monitoring...');
		console.info(`  Certificate: ${this.certFile}`);
		console.info(`  Key: ${this.keyFile}`);
		console.info(`  Check interval: ${this.checkIntervalHours} hour(s)`);

		this.isMonitoring = true;

		// Initialize file info and check expiry on startup
		await this.checkForChanges();
		await this.checkExpiry();

		// Set up periodic checking
		this.intervalId = setInterval(async () => {
			const changed = await this.checkForChanges();
			if (changed) {
				// Re-check expiry whenever the certificate changes
				await this.checkExpiry();
				if (this.reloadCallback) {
					console.info('Triggering server reload due to certificate update...');
					try {
						await this.reloadCallback();
					} catch (error) {
						console.error('Error during reload callback:', error.message);
					}
				}
			}
		}, this.checkIntervalMs);

		console.debug('SSL certificate monitoring started');
	}

	/**
	 * Stop monitoring certificate files
	 */
	stopMonitoring () {
		if (!this.isMonitoring) {
			return;
		}

		console.info('Stopping SSL certificate monitoring...');

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.isMonitoring = false;
		console.debug('SSL certificate monitoring stopped');
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
 * @param {Object} [logger] Logger instance for expiry warnings
 * @returns {SSLManager}
 */
export function createSSLManager (config, reloadCallback, logger = null) {
	return new SSLManager({
		certFile: config.certFile,
		keyFile: config.keyFile,
		noSSL: config.noSSL || false,
		reloadCallback,
		checkIntervalHours: config.sslCheckIntervalHours || DEFAULT_CHECK_INTERVAL_HOURS,
		logger,
	});
}
