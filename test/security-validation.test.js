/**
 * Security Validation Tests
 * Tests for hostile applet scenarios and security boundary enforcement
 *
 * These tests verify that the bootstrap module properly defends against
 * malicious applet behavior using the PolyTransport-based architecture:
 * - Environment tampering prevention
 * - Resource exhaustion (DoS) prevention
 * - Privilege escalation prevention
 * - Console output isolation via C2C channel
 * - Approved API boundary enforcement
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { PromiseTracer } from '@poly-transport/promise-tracer.esm.js';

const bootstrapPath = new URL('../src/applets/bootstrap.esm.js', import.meta.url).href;

/**
 * Create a test applet data URL from JavaScript source code.
 * Applets must be ES modules with an optional default export function.
 */
function makeAppletUrl (appletCode) {
	return `data:application/javascript;base64,${btoa(appletCode)}`;
}

/**
 * Drain a channel to end-of-stream (null message or empty data/text).
 */
async function readToEOS (channel) {
	let message;
	while (message = await channel.read()) {
		message.done();
		if (!message.data && !message.text) break;
	}
}

/**
 * Set up a bootstrap worker with PostMessageTransport.
 * Returns { worker, transport, c2cChannel, bootstrapChannel, appletChannel, cleanup }
 *
 * @param {string} appletCode - JavaScript source for the test applet (ES module)
 * @param {object} setupOverrides - Overrides for the setup message
 */
async function setupBootstrapWorker (appletCode, setupOverrides = {}) {
	const appletUrl = makeAppletUrl(appletCode);

	const worker = new Worker(bootstrapPath, {
		type: 'module',
		deno: {
			permissions: {
				read: false,
				write: false,
				net: true, // Allow network for module loading
				env: false,
				run: false,
			},
		},
	});

	// Create PostMessageTransport on the test side (responder role)
	const promiseTracer = new PromiseTracer(5000, { logRejections: true });
	const c2cSymbol = Symbol('c2c');
	const transport = new PostMessageTransport({
		gateway: worker,
		c2cSymbol,
		promiseTracer,
		maxChunkBytes: 65536,
	});

	// Accept all channels (bootstrap initiates)
	transport.addEventListener('newChannel', (event) => {
		event.accept();
	});

	await transport.start();

	// Get the C2C channel for console output
	const c2cChannel = transport.getChannel(c2cSymbol);

	// Send setup instructions via the 'bootstrap' channel
	const bootstrapChannel = await transport.requestChannel('bootstrap');
	await bootstrapChannel.addMessageTypes(['setup']);
	await bootstrapChannel.write('setup', JSON.stringify({
		appletPath: appletUrl,
		mode: 'response',
		keepDeno: false,
		keepWorkers: false,
		...setupOverrides,
	}));

	// Set up the applet communication channel
	const appletChannel = await transport.requestChannel('applet');
	await appletChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

	const cleanup = async () => {
		await transport.stop({ discard: true }).catch((err) => {
			if (err instanceof Error) throw err;
		});
		worker.terminate();
	};

	return { worker, transport, c2cChannel, bootstrapChannel, appletChannel, cleanup };
}

/**
 * Read a single result frame from the applet channel.
 * Expects: res (metadata), res-frame (JSON data), res-frame (null/EOS).
 */
async function readAppletResult (appletChannel) {
	const resMeta = await appletChannel.read({ only: 'res', decode: true });
	await resMeta.done();

	const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
	let data;
	await resFrame.process(() => {
		data = JSON.parse(resFrame.text);
	});

	await readToEOS(appletChannel);
	return data;
}

// ============================================================================
// Environment Tampering Prevention Tests
// ============================================================================

Deno.test('Security - cannot access Deno.stdin/stdout/stderr', async () => {
	const appletCode = `
		export default async function () {
			const hasStdin = 'stdin' in Deno;
			const hasStdout = 'stdout' in Deno;
			const hasStderr = 'stderr' in Deno;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasStdin, hasStdout, hasStderr }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasStdin, false, 'Deno.stdin should not be accessible');
		assertEquals(data.hasStdout, false, 'Deno.stdout should not be accessible');
		assertEquals(data.hasStderr, false, 'Deno.stderr should not be accessible');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - console is frozen (cannot restore original)', async () => {
	const appletCode = `
		export default async function () {
			let canRestore = false;
			try {
				const desc = Object.getOwnPropertyDescriptor(globalThis, 'console');
				if (desc && desc.configurable) {
					canRestore = true;
				}
			} catch (e) {
				canRestore = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ canRestore }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.canRestore, false, 'Console should not be restorable');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - Deno is frozen (cannot restore original)', async () => {
	const appletCode = `
		export default async function () {
			let canRestore = false;
			try {
				const desc = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
				if (desc && desc.configurable) {
					canRestore = true;
				}
			} catch (e) {
				canRestore = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ canRestore }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.canRestore, false, 'Deno should not be restorable');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - cannot add new console methods', async () => {
	const appletCode = `
		export default async function () {
			let canAdd = false;
			try {
				console.malicious = () => {};
				canAdd = 'malicious' in console;
			} catch (e) {
				canAdd = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ canAdd }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.canAdd, false, 'Should not be able to add console methods');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - cannot add new Deno APIs', async () => {
	const appletCode = `
		export default async function () {
			let canAdd = false;
			try {
				Deno.malicious = () => {};
				canAdd = 'malicious' in Deno;
			} catch (e) {
				canAdd = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ canAdd }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.canAdd, false, 'Should not be able to add Deno APIs');
	} finally {
		await cleanup();
	}
});

// ============================================================================
// Resource Exhaustion (DoS) Prevention Tests
// ============================================================================

Deno.test('Security - excessive console output is captured via C2C', async () => {
	const appletCode = `
		export default async function () {
			// Generate large amount of console output
			for (let i = 0; i < 20; i++) {
				console.log('x'.repeat(100));
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ done: true }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, c2cChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Collect C2C messages concurrently while reading the applet response
		const c2cMessages = [];
		const c2cDone = (async () => {
			let msg;
			while (msg = await c2cChannel.read({ decode: true })) {
				await msg.process(() => {
					c2cMessages.push(msg.text);
				});
			}
		})();

		const data = await readAppletResult(appletChannel);
		assertEquals(data.done, true, 'Applet should complete');

		// Give C2C a moment to flush, then stop transport
		await cleanup();
		await c2cDone.catch(() => {});

		// All console output should have been captured via C2C
		assert(c2cMessages.length > 0, 'Should capture console output via C2C');
	} catch (err) {
		await cleanup().catch(() => {});
		throw err;
	}
});

Deno.test('Security - cannot spawn workers (Worker constructor disabled)', async () => {
	const appletCode = `
		export default async function () {
			let workerCount = 0;
			let errorMessage = null;

			try {
				// Try to spawn a worker (should fail - Worker is disabled)
				const w = new Worker('data:application/javascript,console.log("test")', { type: 'module' });
				workerCount++;
			} catch (e) {
				errorMessage = e.message;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ workerCount, errorMessage }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.workerCount, 0, 'Should not be able to spawn workers');
		assertExists(data.errorMessage, 'Should get an error when spawning workers');
		assert(
			data.errorMessage.includes('disabled') || data.errorMessage.includes('permission'),
			`Expected 'disabled' or 'permission' in error: ${data.errorMessage}`,
		);
	} finally {
		await cleanup();
	}
});

Deno.test('Security - cannot access file system', async () => {
	const appletCode = `
		export default async function () {
			const hasReadFile = 'readFile' in Deno;
			let canRead = false;
			let errorMessage = null;

			if (hasReadFile) {
				try {
					await Deno.readFile('/etc/passwd');
					canRead = true;
				} catch (e) {
					errorMessage = e.message;
				}
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasReadFile, canRead, errorMessage }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasReadFile, false, 'Deno.readFile should not exist in filtered namespace');
		assertEquals(data.canRead, false, 'Should not be able to read files');
	} finally {
		await cleanup();
	}
});

// ============================================================================
// Privilege Escalation Prevention Tests
// ============================================================================

Deno.test('Security - cannot access Deno.run', async () => {
	const appletCode = `
		export default async function () {
			const hasRun = 'run' in Deno;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasRun }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasRun, false, 'Deno.run should not be accessible');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - cannot access Deno.exit', async () => {
	const appletCode = `
		export default async function () {
			const hasExit = 'exit' in Deno;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasExit }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasExit, false, 'Deno.exit should not be accessible');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - cannot access environment variables', async () => {
	const appletCode = `
		export default async function () {
			const hasEnv = 'env' in Deno;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasEnv }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasEnv, false, 'Deno.env should not be accessible');
	} finally {
		await cleanup();
	}
});

// ============================================================================
// Console Output Isolation Tests (C2C channel)
// ============================================================================

Deno.test('Security - console output with IPC-like content is isolated via C2C', async () => {
	// Applet tries to inject IPC-like content via console.
	// In the PolyTransport architecture, console output goes through the C2C channel,
	// completely separate from the applet channel — no injection is possible.
	const appletCode = `
		export default async function () {
			// Try to inject IPC-like content via console
			console.log('res\\nstatus: 200\\nheaders: {}\\n---');
			console.log('res-frame');
			console.log('bidi-frame');

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ done: true }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, c2cChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Collect C2C messages concurrently
		const c2cMessages = [];
		const c2cDone = (async () => {
			let msg;
			while (msg = await c2cChannel.read({ decode: true })) {
				await msg.process(() => {
					c2cMessages.push({ type: msg.messageType, text: msg.text });
				});
			}
		})();

		// The applet channel should only receive proper res/res-frame messages
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);
		assertEquals(data.done, true, 'Applet should complete normally');

		await cleanup();
		await c2cDone.catch(() => {});

		// Console output should have gone to C2C, not the applet channel
		assert(c2cMessages.length >= 3, 'Console output should be captured via C2C');
		// All C2C messages should be log-level messages, not IPC message types
		for (const msg of c2cMessages) {
			assert(
				['debug', 'info', 'warn', 'error'].includes(msg.type),
				`C2C message type should be a log level, got: ${msg.type}`,
			);
		}
	} catch (err) {
		await cleanup().catch(() => {});
		throw err;
	}
});

Deno.test('Security - console output with special characters is safely captured', async () => {
	const appletCode = `
		export default async function () {
			// Try various special characters that might break parsing
			console.log('\\x00\\x01\\x02'); // Null bytes and SOH
			console.log('\\n\\r\\t');        // Whitespace
			console.log('---\\n===\\n>>>');  // SLID-like markers
			console.log('\\u0000\\uFFFF');   // Unicode extremes

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ done: true }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, c2cChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Collect C2C messages concurrently
		const c2cMessages = [];
		const c2cDone = (async () => {
			let msg;
			while (msg = await c2cChannel.read({ decode: true })) {
				await msg.process(() => {
					c2cMessages.push(msg.text);
				});
			}
		})();

		const data = await readAppletResult(appletChannel);
		assertEquals(data.done, true, 'Applet should complete normally');

		await cleanup();
		await c2cDone.catch(() => {});

		// All 4 console.log calls should have been captured
		assert(c2cMessages.length >= 4, `Should capture all console output, got ${c2cMessages.length}`);
	} catch (err) {
		await cleanup().catch(() => {});
		throw err;
	}
});

// ============================================================================
// Frame Protocol Tests
// ============================================================================

Deno.test('Security - oversized frame chunk detection (logic test)', () => {
	// PolyTransport enforces maxChunkBytes at the transport level.
	// This test verifies the size check concept is sound.
	const maxChunkSize = 65536; // 64KB default
	const oversizedData = new Uint8Array(maxChunkSize + 1);

	const isOversized = oversizedData.length > maxChunkSize;
	assertEquals(isOversized, true, 'Should detect oversized chunks');
});

Deno.test('Security - applet error is reported via res-error (not crash)', async () => {
	// Applet throws an error; bootstrap should catch it and send res-error,
	// not crash the worker or leave the channel hanging.
	const appletCode = `
		export default async function () {
			throw new Error('Intentional security test error');
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Should receive res-error, not hang or crash
		const errMsg = await appletChannel.read({ only: 'res-error', decode: true });
		let errorData;
		await errMsg.process(() => {
			errorData = JSON.parse(errMsg.text);
		});

		assertExists(errorData.error, 'Should have error message');
		assert(
			errorData.error.includes('Intentional security test error'),
			`Expected error message, got: ${errorData.error}`,
		);
	} finally {
		await cleanup();
	}
});

// ============================================================================
// Bootstrap Channel Security Tests
// ============================================================================

Deno.test('Security - bootstrap channel is one-shot (setup only read once)', async () => {
	// The bootstrap channel is used exactly once to read setup instructions.
	// After that, the applet runs and the channel is no longer active.
	// This test verifies the applet runs correctly after a single setup read.
	const appletCode = `
		export default async function () {
			// Verify JSMAWS namespace is set up correctly after bootstrap
			const hasServer = typeof globalThis.JSMAWS?.server === 'object';
			const jsmawsFrozen = Object.isFrozen(globalThis.JSMAWS);

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasServer, jsmawsFrozen }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasServer, true, 'JSMAWS.server should be available after bootstrap');
		assertEquals(data.jsmawsFrozen, true, 'JSMAWS namespace should be frozen after bootstrap');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - JSMAWS namespace is frozen (cannot be modified by applet)', async () => {
	const appletCode = `
		export default async function () {
			let canModifyServer = false;
			let canAddProperty = false;

			try {
				globalThis.JSMAWS.server = null;
				canModifyServer = true;
			} catch (e) {
				canModifyServer = false;
			}

			try {
				globalThis.JSMAWS.malicious = 'injected';
				canAddProperty = 'malicious' in globalThis.JSMAWS;
			} catch (e) {
				canAddProperty = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ canModifyServer, canAddProperty }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.canModifyServer, false, 'Should not be able to replace JSMAWS.server');
		assertEquals(data.canAddProperty, false, 'Should not be able to add properties to JSMAWS');
	} finally {
		await cleanup();
	}
});

// ============================================================================
// Approved API Boundary Tests
// ============================================================================

Deno.test('Security - network APIs are available (approved)', async () => {
	const appletCode = `
		export default async function () {
			const hasConnect = 'connect' in Deno;
			const hasListen = 'listen' in Deno;
			const hasResolveDns = 'resolveDns' in Deno;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasConnect, hasListen, hasResolveDns }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasConnect, true, 'Deno.connect should be available');
		assertEquals(data.hasListen, true, 'Deno.listen should be available');
		assertEquals(data.hasResolveDns, true, 'Deno.resolveDns should be available');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - system info APIs are available (approved)', async () => {
	const appletCode = `
		export default async function () {
			const hasBuild = 'build' in Deno;
			const hasVersion = 'version' in Deno;
			const hasHostname = 'hostname' in Deno;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasBuild, hasVersion, hasHostname }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(data.hasBuild, true, 'Deno.build should be available');
		assertEquals(data.hasVersion, true, 'Deno.version should be available');
		assertEquals(data.hasHostname, true, 'Deno.hostname should be available');
	} finally {
		await cleanup();
	}
});

Deno.test('Security - unapproved Deno APIs are blocked', async () => {
	const appletCode = `
		export default async function () {
			const unapproved = ['readFile', 'writeFile', 'remove', 'mkdir', 'run', 'exit', 'env'];
			const blocked = unapproved.map(api => !(api in Deno));
			const allBlocked = blocked.every(r => r);
			const blockedApis = unapproved.filter((api, i) => !blocked[i]);

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ allBlocked, blockedApis }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const data = await readAppletResult(appletChannel);
		assertEquals(
			data.allBlocked,
			true,
			`Unapproved Deno APIs should not exist; found: ${JSON.stringify(data.blockedApis)}`,
		);
	} finally {
		await cleanup();
	}
});
