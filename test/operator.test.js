/**
 * Tests for JSMAWS Operator Process
 * 
 * The operator is the privileged process that:
 * - Binds to HTTP/HTTPS ports
 * - Manages configuration and SSL certificates
 * - Spawns and manages service processes (responders and routers)
 * - Routes requests to appropriate service processes via IPC
 * - Never executes user code directly
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { OperatorProcess, ServerConfig, loadConfig } from "../src/operator.esm.js";
import { NANOS } from '../src/vendor.esm.js';

// ============================================================================
// ServerConfig Tests
// ============================================================================

Deno.test("ServerConfig - creates with default values", () => {
	const config = new ServerConfig();
	assertEquals(config.httpPort, 80);
	assertEquals(config.httpsPort, 443);
	assertEquals(config.hostname, 'localhost');
	assertEquals(config.acmeChallengeDir, undefined);
	assertEquals(config.noSSL, false);
	assertEquals(config.sslCheckIntervalHours, 1);
});

Deno.test("ServerConfig - creates with custom values", () => {
	const config = new ServerConfig({
		httpPort: 8080,
		httpsPort: 8443,
		certFile: '/path/to/cert.pem',
		keyFile: '/path/to/key.pem',
		hostname: 'example.com',
		acmeChallengeDir: '/custom/acme',
		noSSL: true,
		sslCheckIntervalHours: 2,
	});

	assertEquals(config.httpPort, 8080);
	assertEquals(config.httpsPort, 8443);
	assertEquals(config.certFile, '/path/to/cert.pem');
	assertEquals(config.keyFile, '/path/to/key.pem');
	assertEquals(config.hostname, 'example.com');
	assertEquals(config.acmeChallengeDir, '/custom/acme');
	assertEquals(config.noSSL, true);
	assertEquals(config.sslCheckIntervalHours, 2);
});

Deno.test("ServerConfig - creates from NANOS with defaults", () => {
	const nanos = new NANOS();
	const config = ServerConfig.fromNANOS(nanos);

	assertEquals(config.httpPort, 80);
	assertEquals(config.httpsPort, 443);
	assertEquals(config.hostname, 'localhost');
	assertEquals(config.acmeChallengeDir, undefined);
	assertEquals(config.noSSL, false);
	assertEquals(config.sslCheckIntervalHours, 1);
});

Deno.test("ServerConfig - creates from NANOS with custom values", () => {
	const nanos = new NANOS({
		httpPort: 8080,
		httpsPort: 8443,
		certFile: '/path/to/cert.pem',
		keyFile: '/path/to/key.pem',
		hostname: 'example.com',
		acmeChallengeDir: '/custom/acme',
		noSSL: true,
		sslCheckIntervalHours: 2
	});

	const config = ServerConfig.fromNANOS(nanos);

	assertEquals(config.httpPort, 8080);
	assertEquals(config.httpsPort, 8443);
	assertEquals(config.certFile, '/path/to/cert.pem');
	assertEquals(config.keyFile, '/path/to/key.pem');
	assertEquals(config.hostname, 'example.com');
	assertEquals(config.acmeChallengeDir, '/custom/acme');
	assertEquals(config.noSSL, true);
	assertEquals(config.sslCheckIntervalHours, 2);
});

// ============================================================================
// Configuration Loading Tests
// ============================================================================

Deno.test("loadConfig - loads existing SLID file", async () => {
	const config = await loadConfig('jsmaws.slid');

	assertExists(config);
	assertEquals(config.at('httpPort'), 8080);
	assertEquals(config.at('httpsPort'), 8443);
	assertEquals(config.at('hostname'), 'localhost');
});

Deno.test("loadConfig - throws error for missing file", async () => {
	try {
		await loadConfig('nonexistent.slid');
		// If we get here, the test should fail
		throw new Error('Expected loadConfig to throw for missing file');
	} catch (error) {
		// Verify it's a NotFound error
		assert(error instanceof Deno.errors.NotFound, 'Expected Deno.errors.NotFound');
	}
});

// ============================================================================
// OperatorProcess Tests
// ============================================================================

Deno.test("OperatorProcess - creates instance", () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	assertExists(operator);
	assertEquals(operator.config, config);
	assertEquals(operator.httpServer, null);
	assertEquals(operator.httpsServer, null);
	assertEquals(operator.isShuttingDown, false);
	assertEquals(operator.isReloading, false);
});

Deno.test("OperatorProcess - initializes logger", () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	operator.initializeLogger();

	assertExists(operator.logger);
});

Deno.test("OperatorProcess - initializes router", () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	// Set up minimal config data
	operator.configData = new NANOS();
	operator.initializeLogger();
	operator.initializeRouter();

	assertExists(operator.router);
});

Deno.test("OperatorProcess - initializes process manager", () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	operator.configData = new NANOS();
	operator.initializeLogger();
	operator.initializeProcessManager();

	assertExists(operator.processManager);
});

// ============================================================================
// HTTP Request Handling Tests
// ============================================================================

Deno.test("OperatorProcess - HTTP redirect response", async () => {
	const config = new ServerConfig({ httpPort: 8080, noSSL: false });
	const operator = new OperatorProcess(config);
	operator.initializeLogger();

	const req = new Request('http://example.com/test/path?query=value');
	const response = await operator.handleHttpRequest(req);

	assertEquals(response.status, 301);
	assertEquals(response.headers.get('Location'), 'https://example.com/test/path?query=value');
});

Deno.test("OperatorProcess - ACME challenge path detection with configured dir", async () => {
	const config = new ServerConfig({ httpPort: 8080, acmeChallengeDir: '/tmp/acme-test' });
	const operator = new OperatorProcess(config);
	operator.initializeLogger();

	const req = new Request('http://example.com/.well-known/acme-challenge/test-token');
	const response = await operator.handleHttpRequest(req);

	// Should attempt to handle ACME challenge (will fail without actual file)
	assertEquals(response.status, 404);
});

Deno.test("OperatorProcess - ACME challenge path without configured dir redirects", async () => {
	const config = new ServerConfig({ httpPort: 8080, noSSL: false });
	const operator = new OperatorProcess(config);
	operator.initializeLogger();

	const req = new Request('http://example.com/.well-known/acme-challenge/test-token');
	const response = await operator.handleHttpRequest(req);

	// Without acmeChallengeDir configured, should redirect to HTTPS
	assertEquals(response.status, 301);
	assertEquals(response.headers.get('Location'), 'https://example.com/.well-known/acme-challenge/test-token');
});

Deno.test("OperatorProcess - HTTP request in noSSL mode", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.configData = new NANOS();
	operator.initializeLogger();
	operator.initializeRouter();

	const req = new Request('http://example.com/test');
	const response = await operator.handleHttpRequest(req);

	// In noSSL mode, should handle directly (will return 404 without routes)
	assertEquals(response.status, 404);
});

// ============================================================================
// HTTPS Request Handling Tests
// ============================================================================

Deno.test("OperatorProcess - HTTPS request without router returns 404", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.initializeLogger();

	const req = new Request('https://example.com/api/test');
	const response = await operator.handleHttpsRequest(req);

	assertEquals(response.status, 404);
	assertEquals(response.headers.get('Content-Type'), 'application/json');

	const body = await response.json();
	assertEquals(body.error, '404 Not Found');
	assertEquals(body.path, '/api/test');
});

Deno.test("OperatorProcess - HTTPS request with router but no match returns 404", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.configData = new NANOS();
	operator.initializeLogger();
	operator.initializeRouter();

	const req = new Request('https://example.com/nonexistent');
	const response = await operator.handleHttpsRequest(req);

	assertEquals(response.status, 404);
});

// ============================================================================
// Configuration Update Tests
// ============================================================================

Deno.test("OperatorProcess - handles configuration update", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.configData = new NANOS();
	operator.initializeLogger();
	operator.initializeRouter();
	operator.initializeProcessManager();

	// Mock process creation to avoid actual process creation in tests
	const originalCreate = operator.processManager.createProcess;
	operator.processManager.createProcess = async (processId, type, poolName, poolConfig) => {
		assertEquals(type, 'responder');
		assertEquals(poolName, 'standard');
		assertExists(poolConfig);
		// Return mock process in PoolManager format
		return {
			item: {
				id: processId,
				state: 'ready',
				availableWorkers: 1,
				totalWorkers: 1,
				ipcConn: {
					setRequestHandler: () => {},
					clearRequestHandler: () => {},
					writeMessage: async () => {}
				}
			},
			isWorker: false
		};
	};

	try {
		const newConfig = new NANOS({
			httpPort: 9090,
			httpsPort: 9443
		});

		await operator.handleConfigUpdate(newConfig);

		assertEquals(operator.config.httpPort, 9090);
		assertEquals(operator.config.httpsPort, 9443);
		assertExists(operator.router);
	} finally {
		// Clean up: shutdown pool managers to stop scaling timers and close processes
		for (const [poolName, poolManager] of operator.poolManagers) {
			await poolManager.shutdown(0);
		}

		// Restore original
		operator.processManager.createProcess = originalCreate;
	}
});

// ============================================================================
// Header Conversion Tests
// ============================================================================

Deno.test("OperatorProcess - converts NANOS headers to Headers", () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	const nanosHeaders = new NANOS({
		'content-type': 'application/json',
		'x-custom': 'value'
	});

	const headers = operator.convertHeaders(nanosHeaders);

	assertEquals(headers.get('content-type'), 'application/json');
	assertEquals(headers.get('x-custom'), 'value');
});

Deno.test("OperatorProcess - converts multi-valued NANOS headers", () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	// Include multi-valued header (e.g., Set-Cookie)
	const nanosHeaders = new NANOS({
		'content-type': 'application/json',
		'set-cookie': new NANOS('session=abc123', 'user=john')
	});

	const headers = operator.convertHeaders(nanosHeaders);

	assertEquals(headers.get('content-type'), 'application/json');

	// Get all Set-Cookie values
	const setCookieValues = headers.getSetCookie();
	assertEquals(setCookieValues.length, 2);
	assert(setCookieValues.includes('session=abc123'));
	assert(setCookieValues.includes('user=john'));
});

// ============================================================================
// Shutdown Tests
// ============================================================================

Deno.test("OperatorProcess - shutdown sets flag", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.initializeLogger();

	assertEquals(operator.isShuttingDown, false);

	// Start shutdown (will fail without servers running, but flag should be set)
	const shutdownPromise = operator.shutdown();

	assertEquals(operator.isShuttingDown, true);

	await shutdownPromise;
});

// ============================================================================
// SSL Manager Integration Tests
// ============================================================================

Deno.test("OperatorProcess - reload sets flag during reload", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.initializeLogger();

	assertEquals(operator.isReloading, false);

	// Attempt reload (will fail without HTTPS server, but flag should be set)
	try {
		await operator.reloadHttpsServer();
	} catch {
		// Expected to fail without running server
	}

	// Flag should be reset after attempt
	assertEquals(operator.isReloading, false);
});

// ============================================================================
// Process Pool Initialization Tests
// ============================================================================

Deno.test("OperatorProcess - initializeProcessPools with no pools config", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.configData = new NANOS();
	operator.initializeLogger();
	operator.initializeProcessManager();

	// Mock process creation to avoid actual process creation in tests
	const originalCreate = operator.processManager.createProcess;
	let createCalled = false;
	operator.processManager.createProcess = async (processId, type, poolName, poolConfig) => {
		createCalled = true;
		assertEquals(type, 'responder');
		assertEquals(poolName, 'standard');
		assertExists(poolConfig);
		// Return mock process in PoolManager format
		return {
			item: {
				id: processId,
				state: 'ready',
				availableWorkers: 1,
				totalWorkers: 1,
				ipcConn: {
					setRequestHandler: () => {},
					clearRequestHandler: () => {},
					writeMessage: async () => {}
				}
			},
			isWorker: false
		};
	};

	try {
		// Should create default pool when none configured
		await operator.initializeProcessPools();

		// Verify default pool was created
		assert(createCalled, 'Expected createProcess to be called for default pool');
		assertExists(operator.configData.at('pools'));
		assertExists(operator.configData.at('pools').at('standard'));

		// Verify PoolManager was created
		assertExists(operator.poolManagers.get('standard'), 'Expected PoolManager for standard pool');
	} finally {
		// Clean up: shutdown pool managers to stop scaling timers
		for (const [poolName, poolManager] of operator.poolManagers) {
			await poolManager.shutdown(0);
		}

		// Restore original
		operator.processManager.createProcess = originalCreate;
	}
});

Deno.test("OperatorProcess - initializeProcessPools with empty pools config", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	operator.configData = new NANOS();
	operator.configData.set('pools', new NANOS());
	operator.initializeLogger();
	operator.initializeProcessManager();

	// Should not throw with empty pools
	await operator.initializeProcessPools();
});
