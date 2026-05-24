/**
 * E2E Tests for Configuration Reload
 *
 * Tests that the server correctly reloads its configuration when the SLID
 * config file is modified on disk. Uses a real config file (not in-memory
 * config) so that the FileMonitor file-watch path is exercised.
 *
 * Coverage:
 * - Route addition: new route becomes active after config file write
 * - Route removal: removed route returns 404 after reload
 * - Invalid config: server continues serving with old config; no crash
 * - Rapid successive writes: debounce works correctly
 * - SIGHUP: signal triggers config reload (same path as file-watch)
 */

import {
	assertEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';
import { OperatorProcess } from '../src/operator.esm.js';
import { Configuration } from '../src/configuration.esm.js';
import { fetchWithTimeout, waitFor } from './e2e-utils.esm.js';
import { NANOS } from '@nanos';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;
const RELOAD_WAIT_MS = DEBOUNCE_MS + 500; // debounce + propagation margin

/**
 * Write a SLID config file with the given routes and pool config.
 * httpPort=0 is intentionally omitted from the reloaded config so that
 * the port assignment from the initial start is preserved.
 */
async function writeConfig (configPath, config = {}) {
	const fullConfig = {
		noSSL: true,
		httpPort: 0,
		httpsPort: 0,
		hostname: 'localhost',
		logLevel: 'debug',
		...config,
	};
	const slid = NANOS.toSLID(fullConfig);

	await Deno.writeTextFile(configPath, slid);
}

/**
 * Create and start a server driven by a SLID config file.
 * Returns { operator, baseUrl, configPath, tmpDir }.
 */
async function createFileConfigServer (initialConfig) {
	const tmpDir = await Deno.makeTempDir({ prefix: 'jsmaws-e2e-reload-' });
	const configPath = join(tmpDir, 'jsmaws.slid');

	await writeConfig(configPath, initialConfig);

	// Load initial config via Configuration.fromFile() — same path as all reloads
	const config = await Configuration.fromFile(configPath);
	const operator = new OperatorProcess(config, configPath);
	operator.initializeLogger();

	await operator.start();

	const addr = operator.httpServer?.addr;
	if (!addr || typeof addr === 'string') {
		throw new Error('Failed to get server address');
	}
	const baseUrl = `http://localhost:${addr.port}`;

	// Give server a moment to fully initialize
	await new Promise((resolve) => setTimeout(resolve, 100));

	return { operator, baseUrl, configPath, tmpDir };
}

async function stopFileConfigServer (operator, tmpDir) {
	await operator.shutdown(5);
	await Deno.remove(tmpDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Config Reload - route addition becomes active after reload',
	sanitizeResources: false,
	sanitizeOps: false,
	async fn () {
		const { operator, baseUrl, configPath, tmpDir } = await createFileConfigServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: {
				fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
			},
		});

		try {
			// Verify initial route works
			const r1 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r1.status, 200);
			await r1.body?.cancel();

			// Verify /greet does not exist yet
			const r2 = await fetchWithTimeout(`${baseUrl}/greet`);
			assertEquals(r2.status, 404);
			await r2.body?.cancel();

			// Add /greet route to config file
			await writeConfig(configPath, {
				routes: [
					{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
					{ path: '/greet', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
				],
				pools: {
					fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
				},
			});

			// Wait for debounce + propagation, then poll until /greet is active
			await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));
			await waitFor(async () => {
				const r = await fetchWithTimeout(`${baseUrl}/greet`, {}, 2000);
				const ok = r.status === 200;
				await r.body?.cancel();
				return ok;
			}, 5000, 200);

		} finally {
			await stopFileConfigServer(operator, tmpDir);
		}
	},
});

Deno.test({
	name: 'E2E Config Reload - route removal returns 404 after reload',
	sanitizeResources: false,
	sanitizeOps: false,
	async fn () {
		const { operator, baseUrl, configPath, tmpDir } = await createFileConfigServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
				{ path: '/bye', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: {
				fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
			},
		});

		try {
			// Verify both routes work initially
			const r1 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r1.status, 200);
			await r1.body?.cancel();

			const r2 = await fetchWithTimeout(`${baseUrl}/bye`);
			assertEquals(r2.status, 200);
			await r2.body?.cancel();

			// Remove /bye from config
			await writeConfig(configPath, {
				routes: [
					{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
				],
				pools: {
					fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
				},
			});

			// Wait for debounce + propagation, then poll until /bye returns 404
			await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));
			await waitFor(async () => {
				const r = await fetchWithTimeout(`${baseUrl}/bye`, {}, 2000);
				const ok = r.status === 404;
				await r.body?.cancel();
				return ok;
			}, 5000, 200);

			// /hello should still work
			const r3 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r3.status, 200);
			await r3.body?.cancel();

		} finally {
			await stopFileConfigServer(operator, tmpDir);
		}
	},
});

Deno.test({
	name: 'E2E Config Reload - invalid config does not crash server',
	sanitizeResources: false,
	sanitizeOps: false,
	async fn () {
		const { operator, baseUrl, configPath, tmpDir } = await createFileConfigServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: {
				fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
			},
		});

		try {
			// Verify initial route works
			const r1 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r1.status, 200);
			await r1.body?.cancel();

			// Write syntactically invalid SLID (unclosed bracket)
			await Deno.writeTextFile(configPath, '[( this is not valid SLID ');

			// Wait for debounce + propagation
			await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));

			// Server should still be running and serving the old config
			const r2 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r2.status, 200);
			await r2.body?.cancel();

		} finally {
			await stopFileConfigServer(operator, tmpDir);
		}
	},
});

Deno.test({
	name: 'E2E Config Reload - rapid successive writes debounce correctly',
	sanitizeResources: false,
	sanitizeOps: false,
	async fn () {
		const { operator, baseUrl, configPath, tmpDir } = await createFileConfigServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: {
				fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
			},
		});

		try {
			// Write the config file 5 times in rapid succession (within debounce window)
			for (let i = 0; i < 5; i++) {
				await writeConfig(configPath, {
					routes: [
						{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
						{ path: `/v${i}`, app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
					],
					pools: {
						fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
					},
				});
				await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms between writes
			}

			// Wait for debounce to settle (the last write wins)
			await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));

			// Only the last route (/v4) should be active; earlier ones (/v0-/v3) may or may not be
			await waitFor(async () => {
				const r = await fetchWithTimeout(`${baseUrl}/v4`, {}, 2000);
				const ok = r.status === 200;
				await r.body?.cancel();
				return ok;
			}, 5000, 200);

			// Server should still be healthy
			const r = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r.status, 200);
			await r.body?.cancel();

		} finally {
			await stopFileConfigServer(operator, tmpDir);
		}
	},
});

Deno.test({
	name: 'E2E Config Reload - SIGHUP triggers config reload',
	sanitizeResources: false,
	sanitizeOps: false,
	async fn () {
		const { operator, baseUrl, configPath, tmpDir } = await createFileConfigServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: {
				fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
			},
		});

		// Register the SIGHUP handler so the test process responds to SIGHUP
		operator.registerSighupHandler();

		try {
			// Verify initial route works
			const r1 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r1.status, 200);
			await r1.body?.cancel();

			// Verify /sighup-route does not exist yet
			const r2 = await fetchWithTimeout(`${baseUrl}/sighup-route`);
			assertEquals(r2.status, 404);
			await r2.body?.cancel();

			// Write new config with /sighup-route added
			await writeConfig(configPath, {
				routes: [
					{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
					{ path: '/sighup-route', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
				],
				pools: {
					fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 5 },
				},
			});

			// Send SIGHUP to the current process to trigger reload
			Deno.kill(Deno.pid, 'SIGHUP');

			// Poll until /sighup-route becomes active (SIGHUP reload is immediate, no debounce)
			await waitFor(async () => {
				const r = await fetchWithTimeout(`${baseUrl}/sighup-route`, {}, 2000);
				const ok = r.status === 200;
				await r.body?.cancel();
				return ok;
			}, 5000, 200);

			// /hello should still work
			const r3 = await fetchWithTimeout(`${baseUrl}/hello`);
			assertEquals(r3.status, 200);
			await r3.body?.cancel();

		} finally {
			await stopFileConfigServer(operator, tmpDir);
		}
	},
});
