/**
 * Tests for SSL certificate expiry checking.
 *
 * Uses a reference certificate with a fixed validity range:
 *   notBefore: May 25 03:25:07 2026 GMT
 *   notAfter:  Jul 24 03:25:07 2026 GMT
 *
 * Tests pass a fixed `now` value to checkCertificateExpiry() so they remain
 * valid regardless of when they run.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertMatch, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseCertificateExpiry, checkCertificateExpiry, SSLManager } from '../src/ssl-manager.esm.js';

// ---------------------------------------------------------------------------
// Reference certificate
// notBefore: May 25 03:25:07 2026 GMT
// notAfter:  Jul 24 03:25:07 2026 GMT
// ---------------------------------------------------------------------------
const REF_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUNcu0yEo6VJmgZgIf1oaYyufcyQcwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPanNtYXdzLXRlc3QtcmVmMB4XDTI2MDUyNTAzMjUwN1oX
DTI2MDcyNDAzMjUwN1owGjEYMBYGA1UEAwwPanNtYXdzLXRlc3QtcmVmMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwhOTxxNuzEi3cjDlAc9nRShXFXGJ
Eh3DkNmUnT9MPEGs+PZRb/Mu1Pq1tlWoetRpB47iSyZk/dAlE2dAlamDEBJ8PkBv
cfFobhPNLolgmrDigjI9OrElGEmXD1Cd213tgbZOVnNTw+eN9QEew+IHQyjIzhy3
7hzrB911qQalzecEpqfb0++4+BoUcOeOw3295XodsPSQ7NDt+gV0DJ2Y1qT2Fe40
qq7vX8XcR+Y8SekDmBRpCajAM/DdPSt/lp99xhthzVQ/x+kGrznlHQuEXCyWWj7w
oROFwuHy6rA87NcF49YdWw83zFbiDSFrejGiGRqUsWmpKubGXnRhyHYBhwIDAQAB
o1MwUTAdBgNVHQ4EFgQUnfLFxUPNO3tD4GQ6XmpXFb4aWqIwHwYDVR0jBBgwFoAU
nfLFxUPNO3tD4GQ6XmpXFb4aWqIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAbMk9ZvuV8t80TSd4HTWurIyXGCODl7q9afXHo2kDSsVmm4MC5s5b
2Rsmu+I8qIoMK1yTNpK/De5griYj5sYyC43NB1dCnLSrjVhicbwznbJnooKneobq
ismkvkxKGatghZ6ej8Un4HlgjAk7IP3mUqIDoLXdFZabw2vreIHVHMKBADHdQUQI
rj7aNzhoiHA98hsZ8HHxlA0zuVpAcAAu7+jjVQiNagNwds5wpnkwK+kUhyPpyhoe
rGWpyjWWo7ka4Fl9GSgvpR4zI2/Od6b/Fv4FGfSRLvzE7HPa0SVraSufHo0koPGP
SRQP0DzHzA17koIqEDjNe+GBKEt6J+JFvg==
-----END CERTIFICATE-----`;

// notAfter timestamp: Jul 24 03:25:07 2026 UTC
const NOT_AFTER_MS = new Date('2026-07-24T03:25:07Z').getTime();

// Fixed "now" values for testing
const NOW_EXPIRED     = NOT_AFTER_MS + 10 * 24 * 60 * 60 * 1000; // 10 days after expiry
const NOW_NEAR_EXPIRY = NOT_AFTER_MS - 15 * 24 * 60 * 60 * 1000; // 15 days before expiry
const NOW_VALID       = NOT_AFTER_MS - 60 * 24 * 60 * 60 * 1000; // 60 days before expiry

// ---------------------------------------------------------------------------
// Helper: create a simple mock logger
// ---------------------------------------------------------------------------
function makeLogger () {
	const messages = { info: [], warn: [], error: [] };
	return {
		messages,
		info:  (msg) => messages.info.push(msg),
		warn:  (msg) => messages.warn.push(msg),
		error: (msg) => messages.error.push(msg),
	};
}

// ---------------------------------------------------------------------------
// parseCertificateExpiry tests
// ---------------------------------------------------------------------------

Deno.test('parseCertificateExpiry - returns null for invalid PEM', () => {
	assertEquals(parseCertificateExpiry('not a certificate'), null);
	assertEquals(parseCertificateExpiry(''), null);
	assertEquals(parseCertificateExpiry('-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'), null);
});

Deno.test('parseCertificateExpiry - parses notAfter from reference cert', () => {
	const notAfter = parseCertificateExpiry(REF_CERT_PEM);
	assertExists(notAfter);
	assertEquals(notAfter.getTime(), NOT_AFTER_MS);
});

// ---------------------------------------------------------------------------
// checkCertificateExpiry tests
// ---------------------------------------------------------------------------

Deno.test('checkCertificateExpiry - logs INFO for cert with >30 days remaining', () => {
	const logger = makeLogger();
	const result = checkCertificateExpiry(REF_CERT_PEM, logger, '/path/to/cert.pem', NOW_VALID);

	assertExists(result, 'Should return notAfter date');
	assertEquals(logger.messages.error.length, 0, 'Should not log error');
	assertEquals(logger.messages.warn.length, 0, 'Should not log warning');
	assertEquals(logger.messages.info.length, 1, 'Should log one info message');
	assertMatch(logger.messages.info[0], /valid until/);
	assertMatch(logger.messages.info[0], /\/path\/to\/cert\.pem/);
});

Deno.test('checkCertificateExpiry - logs WARN for cert expiring within 30 days', () => {
	const logger = makeLogger();
	const result = checkCertificateExpiry(REF_CERT_PEM, logger, '/path/to/cert.pem', NOW_NEAR_EXPIRY);

	assertExists(result, 'Should return notAfter date');
	assertEquals(logger.messages.error.length, 0, 'Should not log error');
	assertEquals(logger.messages.warn.length, 1, 'Should log one warning');
	assertEquals(logger.messages.info.length, 0, 'Should not log info');
	assertMatch(logger.messages.warn[0], /expires in/);
	assertMatch(logger.messages.warn[0], /\/path\/to\/cert\.pem/);
	assertMatch(logger.messages.warn[0], /15 day\(s\)/);
});

Deno.test('checkCertificateExpiry - logs ERROR for expired cert', () => {
	const logger = makeLogger();
	const result = checkCertificateExpiry(REF_CERT_PEM, logger, '/path/to/cert.pem', NOW_EXPIRED);

	assertExists(result, 'Should return notAfter date even for expired cert');
	assertEquals(logger.messages.error.length, 1, 'Should log one error');
	assertEquals(logger.messages.warn.length, 0, 'Should not log warning');
	assertEquals(logger.messages.info.length, 0, 'Should not log info');
	assertMatch(logger.messages.error[0], /EXPIRED/);
	assertMatch(logger.messages.error[0], /\/path\/to\/cert\.pem/);
	assertMatch(logger.messages.error[0], /10 day\(s\) ago/);
});

Deno.test('checkCertificateExpiry - logs WARN for unparseable cert', () => {
	const logger = makeLogger();
	const result = checkCertificateExpiry('not a cert', logger);

	assertEquals(result, null);
	assertEquals(logger.messages.warn.length, 1, 'Should log one warning');
	assertMatch(logger.messages.warn[0], /could not parse expiry date/);
});

Deno.test('checkCertificateExpiry - works without certFile label', () => {
	const logger = makeLogger();
	checkCertificateExpiry(REF_CERT_PEM, logger, '', NOW_VALID);

	assertEquals(logger.messages.info.length, 1);
	assertMatch(logger.messages.info[0], /SSL certificate valid until/);
});

Deno.test('checkCertificateExpiry - uses real time when now not provided', () => {
	// The reference cert expires in the future (Jul 2026) relative to when it was created.
	// We can't know exactly what "now" will be when this test runs, but we can verify
	// that the function runs without error and returns the correct notAfter date.
	const logger = makeLogger();
	const result = checkCertificateExpiry(REF_CERT_PEM, logger);

	assertExists(result);
	assertEquals(result.getTime(), NOT_AFTER_MS);
	// Exactly one log message should have been emitted (info, warn, or error)
	const total = logger.messages.info.length + logger.messages.warn.length + logger.messages.error.length;
	assertEquals(total, 1, 'Should log exactly one message');
});

// ---------------------------------------------------------------------------
// SSLManager.checkExpiry integration tests
// ---------------------------------------------------------------------------

Deno.test('SSLManager.checkExpiry - returns null when no certFile configured', async () => {
	const manager = new SSLManager({ logger: console });
	const result = await manager.checkExpiry();
	assertEquals(result, null);
});

Deno.test('SSLManager.checkExpiry - logs warning for near-expiry cert file', async () => {
	const tmpDir = await Deno.makeTempDir();
	const certPath = `${tmpDir}/cert.pem`;

	try {
		await Deno.writeTextFile(certPath, REF_CERT_PEM);

		const logger = makeLogger();
		const manager = new SSLManager({
			certFile: certPath,
			logger,
			certRefTime: NOW_NEAR_EXPIRY,
		});
		const result = await manager.checkExpiry();

		assertExists(result);
		assertEquals(logger.messages.warn.length, 1);
		assertMatch(logger.messages.warn[0], /expires in/);
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('SSLManager.checkExpiry - logs error for expired cert file', async () => {
	const tmpDir = await Deno.makeTempDir();
	const certPath = `${tmpDir}/cert.pem`;

	try {
		await Deno.writeTextFile(certPath, REF_CERT_PEM);

		const logger = makeLogger();
		const manager = new SSLManager({
			certFile: certPath,
			logger,
			certRefTime: NOW_EXPIRED,
		});
		const result = await manager.checkExpiry();

		assertExists(result);
		assertEquals(logger.messages.error.length, 1);
		assertMatch(logger.messages.error[0], /EXPIRED/);
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('SSLManager.checkExpiry - logs info for valid cert file', async () => {
	const tmpDir = await Deno.makeTempDir();
	const certPath = `${tmpDir}/cert.pem`;

	try {
		await Deno.writeTextFile(certPath, REF_CERT_PEM);

		const logger = makeLogger();
		const manager = new SSLManager({
			certFile: certPath,
			logger,
			certRefTime: NOW_VALID,
		});
		const result = await manager.checkExpiry();

		assertExists(result);
		assertEquals(logger.messages.info.length, 1);
		assertMatch(logger.messages.info[0], /valid until/);
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('SSLManager.checkExpiry - logs warning for missing cert file', async () => {
	const logger = makeLogger();
	const manager = new SSLManager({ certFile: '/nonexistent/cert.pem', logger });
	const result = await manager.checkExpiry();

	assertEquals(result, null);
	assertEquals(logger.messages.warn.length, 1);
	assertMatch(logger.messages.warn[0], /could not read file/);
});
