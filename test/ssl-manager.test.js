/**
 * Tests for SSL Certificate Manager
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { SSLManager, createSSLManager } from '../src/ssl-manager.esm.js';

Deno.test('SSLManager - constructor initializes with defaults', () => {
	const manager = new SSLManager();

	assertEquals(manager.certFile, undefined);
	assertEquals(manager.keyFile, undefined);
	assertEquals(manager.noSSL, false);
	assertEquals(manager.checkIntervalHours, 1);
	assertEquals(manager.isMonitoring, false);
});

Deno.test('SSLManager - constructor accepts custom options', () => {
	const manager = new SSLManager({
		certFile: '/path/to/cert.pem',
		keyFile: '/path/to/key.pem',
		noSSL: true,
		checkIntervalHours: 2,
	});

	assertEquals(manager.certFile, '/path/to/cert.pem');
	assertEquals(manager.keyFile, '/path/to/key.pem');
	assertEquals(manager.noSSL, true);
	assertEquals(manager.checkIntervalHours, 2);
});

Deno.test('SSLManager - validateCertificates returns valid in noSSL mode', async () => {
	const manager = new SSLManager({ noSSL: true });
	const result = await manager.validateCertificates();

	assertEquals(result.valid, true);
	assertEquals(result.error, null);
});

Deno.test('SSLManager - validateCertificates fails without cert files', async () => {
	const manager = new SSLManager();
	const result = await manager.validateCertificates();

	assertEquals(result.valid, false);
	assertExists(result.error);
});

Deno.test('SSLManager - validateCertificates fails with non-existent files', async () => {
	const manager = new SSLManager({
		certFile: '/nonexistent/cert.pem',
		keyFile: '/nonexistent/key.pem',
	});
	const result = await manager.validateCertificates();

	assertEquals(result.valid, false);
	assertExists(result.error);
});

Deno.test('SSLManager - startMonitoring does nothing in noSSL mode', async () => {
	const manager = new SSLManager({ noSSL: true });
	await manager.startMonitoring();

	assertEquals(manager.isMonitoring, false);
});

Deno.test('SSLManager - startMonitoring does nothing without cert files', async () => {
	const manager = new SSLManager();
	await manager.startMonitoring();

	assertEquals(manager.isMonitoring, false);
});

Deno.test('SSLManager - createSSLManager creates instance from config', () => {
	const config = {
		certFile: '/path/to/cert.pem',
		keyFile: '/path/to/key.pem',
		noSSL: false,
		sslCheckIntervalHours: 3,
	};

	const callback = () => {};
	const manager = createSSLManager(config, callback);

	assertExists(manager);
	assertEquals(manager.certFile, config.certFile);
	assertEquals(manager.keyFile, config.keyFile);
	assertEquals(manager.noSSL, config.noSSL);
	assertEquals(manager.checkIntervalHours, 3);
	assertEquals(manager.reloadCallback, callback);
});

Deno.test('SSLManager - getFileInfo returns null for non-existent file', async () => {
	const manager = new SSLManager();
	const info = await manager.getFileInfo('/nonexistent/file.txt');

	assertEquals(info.mtime, null);
	assertEquals(info.target, null);
});

Deno.test('SSLManager - checkForChanges returns false in noSSL mode', async () => {
	const manager = new SSLManager({ noSSL: true });
	const changed = await manager.checkForChanges();

	assertEquals(changed, false);
});

Deno.test('SSLManager - checkForChanges returns false without cert files', async () => {
	const manager = new SSLManager();
	const changed = await manager.checkForChanges();

	assertEquals(changed, false);
});

Deno.test('SSLManager - stopMonitoring is safe when not monitoring', () => {
	const manager = new SSLManager();
	manager.stopMonitoring(); // Should not throw

	assertEquals(manager.isMonitoring, false);
});
