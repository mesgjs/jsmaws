/**
 * Applet Bootstrap Module Tests
 * Tests for environment lockdown and controlled initialization
 *
 * The bootstrap module uses PostMessageTransport for communication:
 * - Reads setup from the 'bootstrap' channel (appletPath, mode, keepDeno, keepWorkers)
 * - Exposes globalThis.JSMAWS.server (applet channel) and .bidi (bidi mode only)
 * - Intercepts console output via C2C channel
 * - Locks down Deno namespace and disables Worker constructor
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { PromiseTracer } from '@poly-transport/promise-tracer.esm.js';

const bootstrapPath = new URL('../src/applets/bootstrap.esm.js', import.meta.url).href;

/**
 * Create a test applet data URL from JavaScript source code
 */
function makeAppletUrl (appletCode) {
	return `data:application/javascript;base64,${btoa(appletCode)}`;
}

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
 * @param {string} appletCode - JavaScript source for the test applet
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
			if (err instanceof Error) throw(err);
		});
		worker.terminate();
	};

	return { worker, transport, c2cChannel, bootstrapChannel, appletChannel, cleanup };
}

// ─── Deno namespace lockdown ──────────────────────────────────────────────────

Deno.test('Bootstrap - Deno APIs are filtered (approved APIs exist)', async () => {
	const appletCode = `
		export default async function () {
			const approved = ['build', 'version', 'inspect', 'errors'];
			const results = approved.map(api => api in Deno);
			const allApproved = results.every(r => r);

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ allApproved }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Read response metadata
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		// Read response body
		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.allApproved, true, 'All approved Deno APIs should exist');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - Deno APIs are filtered (unapproved APIs blocked)', async () => {
	const appletCode = `
		export default async function () {
			const unapproved = ['readFile', 'writeFile', 'remove', 'mkdir', 'run', 'exit'];
			const blocked = unapproved.map(api => !(api in Deno));
			const allBlocked = blocked.every(r => r);

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ allBlocked }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.allBlocked, true, 'Unapproved Deno APIs should not exist');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - Deno is frozen', async () => {
	const appletCode = `
		export default async function () {
			let canModify = false;
			try {
				Deno.inspect = () => {};
				canModify = true;
			} catch (e) {
				canModify = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ frozen: !canModify }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.frozen, true, 'Deno should be frozen');
	} finally {
		await cleanup();
	}
});

// ─── JSMAWS namespace ─────────────────────────────────────────────────────────

Deno.test('Bootstrap - JSMAWS.server channel is available', async () => {
	const appletCode = `
		export default async function () {
			const hasServer = typeof globalThis.JSMAWS?.server === 'object';
			const hasBidi = 'bidi' in globalThis.JSMAWS;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasServer, hasBidi }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.hasServer, true, 'JSMAWS.server should be available');
		assertEquals(data.hasBidi, false, 'JSMAWS.bidi should not be present in response mode');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - JSMAWS is frozen', async () => {
	const appletCode = `
		export default async function () {
			let canModify = false;
			try {
				globalThis.JSMAWS.server = null;
				canModify = true;
			} catch (e) {
				canModify = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ frozen: !canModify }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.frozen, true, 'JSMAWS namespace should be frozen');
	} finally {
		await cleanup();
	}
});

// ─── Applet execution ─────────────────────────────────────────────────────────

Deno.test('Bootstrap - applet default export is called with setupData', async () => {
	const appletCode = `
		export default async function (setupData) {
			const hasSetupData = typeof setupData === 'object' && setupData !== null;
			const hasAppletPath = typeof setupData?.appletPath === 'string';

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasSetupData, hasAppletPath }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.hasSetupData, true, 'setupData should be passed to applet');
		assertEquals(data.hasAppletPath, true, 'setupData.appletPath should be a string');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - applet can read request via JSMAWS.server', async () => {
	const appletCode = `
		export default async function () {
			const server = globalThis.JSMAWS.server;
			const reqMsg = await server.read({ only: 'req' });
			let requestData;
			await reqMsg.process(() => {
				requestData = JSON.parse(reqMsg.text);
			});

			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({
				method: requestData.method,
				url: requestData.url,
			}));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		await appletChannel.write('req', JSON.stringify({
			method: 'GET',
			url: 'https://example.com/test',
			headers: {},
		}));

		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.method, 'GET');
		assertEquals(data.url, 'https://example.com/test');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - applet error sends res-error', async () => {
	const appletCode = `
		export default async function () {
			throw new Error('Intentional test error');
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Should receive res-error
		const errMsg = await appletChannel.read({ only: 'res-error', decode: true });
		let errorData;
		await errMsg.process(() => {
			errorData = JSON.parse(errMsg.text);
		});

		assertExists(errorData.error);
		assert(errorData.error.includes('Intentional test error'));
	} finally {
		await cleanup();
	}
});

// ─── Console interception via C2C ─────────────────────────────────────────────

Deno.test('Bootstrap - console.log is forwarded via C2C channel', async () => {
	const appletCode = `
		export default async function () {
			console.log('test log message');

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', 'done');
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, c2cChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Read C2C message (console output)
		const c2cMsg = await c2cChannel.read({ decode: true });
		let consoleText;
		await c2cMsg.process(() => {
			consoleText = c2cMsg.text;
		});

		await readToEOS(appletChannel);

		assertExists(consoleText);
		assert(consoleText.includes('test log message'), `Expected 'test log message' in: ${consoleText}`);
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - console.error is forwarded via C2C channel', async () => {
	const appletCode = `
		export default async function () {
			console.error('test error message');

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', 'done');
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, c2cChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		// Read C2C message (console output)
		const c2cMsg = await c2cChannel.read({ decode: true });
		let consoleText;
		await c2cMsg.process(() => {
			consoleText = c2cMsg.text;
		});

		await readToEOS(appletChannel);

		assertExists(consoleText);
		assert(consoleText.includes('test error message'), `Expected 'test error message' in: ${consoleText}`);
	} finally {
		await cleanup();
	}
});

// ─── Deno.inspect availability ────────────────────────────────────────────────

Deno.test('Bootstrap - Deno.inspect is available for formatting', async () => {
	const appletCode = `
		export default async function () {
			const obj = { a: 1, b: 2 };
			const formatted = Deno.inspect(obj);

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ formatted }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		let data;
		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assert(data.formatted.includes('a'), 'Deno.inspect should format object');
		assert(data.formatted.includes('1'), 'Deno.inspect should include values');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap - Deno.errors namespace is available', async () => {
	const appletCode = `
		export default async function () {
			const hasErrors = typeof Deno.errors === 'object';
			const hasNotFound = typeof Deno.errors?.NotFound === 'function';

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasErrors, hasNotFound }));
			await server.write('res-frame', null);
		}
	`;

	const { appletChannel, cleanup } = await setupBootstrapWorker(appletCode);

	try {
		const resMeta = await appletChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appletChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appletChannel);

		assertEquals(data.hasErrors, true);
		assertEquals(data.hasNotFound, true);
	} finally {
		await cleanup();
	}
});
