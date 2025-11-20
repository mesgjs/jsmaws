/**
 * Tests for JSMAWS server
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { JsmawsServer, ServerConfig, loadConfig } from "../src/server.esm.js";
import { NANOS } from '../src/vendor.esm.js';

Deno.test("ServerConfig - creates with default values", () => {
	const config = new ServerConfig();
	assertEquals(config.httpPort, 80);
	assertEquals(config.httpsPort, 443);
	assertEquals(config.hostname, 'localhost');
	assertEquals(config.acmeChallengeDir, '/var/www/acme-challenge');
});

Deno.test("ServerConfig - creates with custom values", () => {
	const config = new ServerConfig({
		httpPort: 8080,
		httpsPort: 8443,
		certFile: '/path/to/cert.pem',
		keyFile: '/path/to/key.pem',
		hostname: 'example.com',
		acmeChallengeDir: '/custom/acme',
	});

	assertEquals(config.httpPort, 8080);
	assertEquals(config.httpsPort, 8443);
	assertEquals(config.certFile, '/path/to/cert.pem');
	assertEquals(config.keyFile, '/path/to/key.pem');
	assertEquals(config.hostname, 'example.com');
	assertEquals(config.acmeChallengeDir, '/custom/acme');
});

Deno.test("JsmawsServer - creates instance", () => {
	const config = new ServerConfig();
	const server = new JsmawsServer(config);

	assertExists(server);
	assertEquals(server.config, config);
	assertEquals(server.httpServer, null);
	assertEquals(server.httpsServer, null);
	assertEquals(server.isShuttingDown, false);
});

Deno.test("JsmawsServer - HTTP redirect response", async () => {
	const config = new ServerConfig({ httpPort: 8080 });
	const server = new JsmawsServer(config);

	// Create a mock request
	const req = new Request('http://example.com/test/path?query=value');
	const response = await server.handleHttpRequest(req);

	assertEquals(response.status, 301);
	assertEquals(response.headers.get('Location'), 'https://example.com/test/path?query=value');
});

Deno.test("JsmawsServer - ACME challenge path detection", async () => {
	const config = new ServerConfig({ httpPort: 8080 });
	const server = new JsmawsServer(config);

	// Create a mock ACME challenge request
	const req = new Request('http://example.com/.well-known/acme-challenge/test-token');
	const response = await server.handleHttpRequest(req);

	// Should attempt to handle ACME challenge (will fail without actual file)
	assertEquals(response.status, 404); // File doesn't exist in test
});

Deno.test("JsmawsServer - HTTPS basic response", async () => {
	const config = new ServerConfig();
	const server = new JsmawsServer(config);

	// Create a mock HTTPS request
	const req = new Request('https://example.com/api/test');
	const response = await server.handleHttpsRequest(req);

	assertEquals(response.status, 200);
	assertEquals(response.headers.get('Content-Type'), 'application/json');

	const body = await response.json();
	assertEquals(body.message, 'JSMAWS Server');
	assertEquals(body.path, '/api/test');
	assertEquals(body.method, 'GET');
});

Deno.test("ServerConfig - creates from NANOS with defaults", () => {
	const nanos = new NANOS();
	const config = ServerConfig.fromNANOS(nanos);

	assertEquals(config.httpPort, 80);
	assertEquals(config.httpsPort, 443);
	assertEquals(config.hostname, 'localhost');
	assertEquals(config.acmeChallengeDir, '/var/www/acme-challenge');
});

Deno.test("ServerConfig - creates from NANOS with custom values", () => {
	const nanos = new NANOS();
	nanos.set('httpPort', 8080);
	nanos.set('httpsPort', 8443);
	nanos.set('certFile', '/path/to/cert.pem');
	nanos.set('keyFile', '/path/to/key.pem');
	nanos.set('hostname', 'example.com');
	nanos.set('acmeChallengeDir', '/custom/acme');

	const config = ServerConfig.fromNANOS(nanos);

	assertEquals(config.httpPort, 8080);
	assertEquals(config.httpsPort, 8443);
	assertEquals(config.certFile, '/path/to/cert.pem');
	assertEquals(config.keyFile, '/path/to/key.pem');
	assertEquals(config.hostname, 'example.com');
	assertEquals(config.acmeChallengeDir, '/custom/acme');
});

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
