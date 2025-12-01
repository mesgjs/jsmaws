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

Deno.test("loadConfig - returns empty NANOS for missing file", async () => {
	const config = await loadConfig('nonexistent.slid');

	assertExists(config);
	assertEquals(config.size, 0);
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
	assertExists(operator.pendingRequests);
	assertEquals(operator.pendingRequests.size, 0);
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

	const newConfig = new NANOS({
		httpPort: 9090,
		httpsPort: 9443
	});

	await operator.handleConfigUpdate(newConfig);

	assertEquals(operator.config.httpPort, 9090);
	assertEquals(operator.config.httpsPort, 9443);
	assertExists(operator.router);
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
// Response Handler Tests
// ============================================================================

Deno.test("OperatorProcess - handleFrameResponse creates proper Response", async () => {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);

	// Create a mock process with IPC connection
	const mockProcess = {
		id: 'test-process',
		ipcConn: {
			readMessage: async () => {
				// Return a final frame to close the stream
				const finalFrame = {
					type: 'WEB_FRAME',
					id: 'test-request',
					fields: new NANOS({ final: true, keepAlive: false }),
				};
				return { message: finalFrame, binaryData: new Uint8Array(0) };
			},
			unregisterStreamHandler: () => {}
		}
	};

	// Create first frame with response mode
	const firstFrame = {
		type: 'WEB_FRAME',
		id: 'test-request',
		fields: new NANOS({ mode: 'response', status: 200 }),
	};

	const headers = new NANOS({ 'content-type': 'text/plain' });
	firstFrame.fields.push({ headers: headers, final: true, keepAlive: false });

	const binaryData = new TextEncoder().encode('Hello, World!');

	const response = await operator.handleFrameResponse('test-request', firstFrame, binaryData, mockProcess, new Request('https://example.com/test'));

	assertEquals(response.status, 200);
	assertEquals(response.headers.get('content-type'), 'text/plain');

	const body = await response.text();
	assertEquals(body, 'Hello, World!');
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

	// Should not throw with no pools configured
	await operator.initializeProcessPools();
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
