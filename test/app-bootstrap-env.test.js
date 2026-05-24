/**
 * Mod-App Bootstrap Environment Injection Tests
 * Tests that setupData.appEnv is correctly exposed as globalThis.JSMAWS.env
 * in the mod-app worker.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { PromiseTracer } from '@poly-transport/promise-tracer.esm.js';

const bootstrapPath = new URL('../src/apps/bootstrap.esm.js', import.meta.url).href;

/**
 * Create a test mod-app data URL from JavaScript source code
 */
function makeAppUrl (appCode) {
	return `data:application/javascript;base64,${btoa(appCode)}`;
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
 * Returns { worker, transport, appChannel, cleanup }
 *
 * @param {string} appCode - JavaScript source for the test mod-app
 * @param {object} setupOverrides - Overrides for the setup message (including appEnv)
 */
async function setupBootstrapWorker (appCode, setupOverrides = {}) {
	const appUrl = makeAppUrl(appCode);

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
	const transport = new PostMessageTransport({
		gateway: worker,
		promiseTracer,
		maxChunkBytes: 65536,
	});

	// Accept all channels (bootstrap initiates)
	transport.addEventListener('newChannel', (event) => {
		event.accept();
	});

	await transport.start();

	// Send setup instructions via the 'bootstrap' channel
	const bootstrapChannel = await transport.requestChannel('bootstrap');
	await bootstrapChannel.addMessageTypes(['setup']);
	await bootstrapChannel.write('setup', JSON.stringify({
		appPath: appUrl,
		mode: 'response',
		keepDeno: false,
		keepWorkers: false,
		...setupOverrides,
	}));

	// Set up the mod-app communication channel
	const appChannel = await transport.requestChannel('app');
	await appChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

	const cleanup = async () => {
		await transport.stop({ discard: true }).catch((err) => {
			if (err instanceof Error) throw(err);
		});
		worker.terminate();
	};

	return { worker, transport, appChannel, cleanup };
}

// --- JSMAWS.env availability --------------------------------------------------

Deno.test('Bootstrap env - JSMAWS.env is available as a frozen object', async () => {
	const appCode = `
		export default async function () {
			const hasEnv = typeof globalThis.JSMAWS?.env === 'object';
			const isFrozen = Object.isFrozen(globalThis.JSMAWS.env);

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ hasEnv, isFrozen }));
			await server.write('res-frame', null);
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode);

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.hasEnv, true, 'JSMAWS.env should be available');
		assertEquals(data.isFrozen, true, 'JSMAWS.env should be frozen');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap env - JSMAWS.env is empty object when no appEnv in setupData', async () => {
	const appCode = `
		export default async function () {
			const env = globalThis.JSMAWS.env;
			const isEmpty = Object.keys(env).length === 0;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ isEmpty }));
			await server.write('res-frame', null);
		}
	`;

	// No appEnv in setup
	const { appChannel, cleanup } = await setupBootstrapWorker(appCode);

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.isEmpty, true, 'JSMAWS.env should be empty when no appEnv provided');
	} finally {
		await cleanup();
	}
});

// --- appEnv injection ---------------------------------------------------------

Deno.test('Bootstrap env - injected appEnv values are accessible via JSMAWS.env', async () => {
	const appCode = `
		export default async function () {
			const env = globalThis.JSMAWS.env;
			const appVersion = env.appVersion;
			const publicApiUrl = env.publicApiUrl;
			const maxRetries = env.maxRetries;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ appVersion, publicApiUrl, maxRetries }));
			await server.write('res-frame', null);
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, {
		appEnv: {
			appVersion: '2.3.1',
			publicApiUrl: 'https://api.example.com/v1',
			maxRetries: '3',
		},
	});

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.appVersion, '2.3.1');
		assertEquals(data.publicApiUrl, 'https://api.example.com/v1');
		assertEquals(data.maxRetries, '3');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap env - JSMAWS.env contains only injected keys', async () => {
	const appCode = `
		export default async function () {
			const env = globalThis.JSMAWS.env;
			const keys = Object.keys(env).sort();

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ keys }));
			await server.write('res-frame', null);
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, {
		appEnv: {
			featureFlag: 'true',
			tenantId: 'acme-corp',
		},
	});

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.keys, ['featureFlag', 'tenantId']);
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap env - JSMAWS.env is read-only (cannot be modified)', async () => {
	const appCode = `
		export default async function () {
			let canModify = false;
			try {
				globalThis.JSMAWS.env.newKey = 'injected';
				canModify = true;
			} catch (_e) {
				canModify = false;
			}

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ canModify }));
			await server.write('res-frame', null);
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, {
		appEnv: { existingKey: 'value' },
	});

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.canModify, false, 'JSMAWS.env should be read-only (frozen)');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap env - JSMAWS.env values are all strings', async () => {
	const appCode = `
		export default async function () {
			const env = globalThis.JSMAWS.env;
			const allStrings = Object.values(env).every(v => typeof v === 'string');

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ allStrings }));
			await server.write('res-frame', null);
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, {
		appEnv: {
			strVal: 'hello',
			numVal: '42',
			boolVal: 'true',
		},
	});

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.allStrings, true, 'All JSMAWS.env values should be strings');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap env - JSMAWS.env is accessible from setupData parameter', async () => {
	// Verify that setupData.appEnv and JSMAWS.env are consistent
	const appCode = `
		export default async function (setupData) {
			const envFromNamespace = globalThis.JSMAWS.env;
			const envFromSetupData = setupData.appEnv ?? {};

			const namespaceKeys = Object.keys(envFromNamespace).sort().join(',');
			const setupDataKeys = Object.keys(envFromSetupData).sort().join(',');
			const keysMatch = namespaceKeys === setupDataKeys;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ keysMatch, namespaceKeys }));
			await server.write('res-frame', null);
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, {
		appEnv: {
			key1: 'value1',
			key2: 'value2',
		},
	});

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.keysMatch, true, 'JSMAWS.env keys should match setupData.appEnv keys');
		assert(data.namespaceKeys.includes('key1'), 'key1 should be present');
		assert(data.namespaceKeys.includes('key2'), 'key2 should be present');
	} finally {
		await cleanup();
	}
});

Deno.test('Bootstrap env - empty appEnv object in setupData yields empty JSMAWS.env', async () => {
	const appCode = `
		export default async function () {
			const env = globalThis.JSMAWS.env;
			const keyCount = Object.keys(env).length;

			const server = globalThis.JSMAWS.server;
			await server.write('res', JSON.stringify({ status: 200, headers: {} }));
			await server.write('res-frame', JSON.stringify({ keyCount }));
			await server.write('res-frame', null);
		}
	`;

	// Explicitly pass empty appEnv
	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, {
		appEnv: {},
	});

	try {
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		await resMeta.done();

		const resFrame = await appChannel.read({ only: 'res-frame', decode: true });
		let data;
		await resFrame.process(() => {
			data = JSON.parse(resFrame.text);
		});

		await readToEOS(appChannel);

		assertEquals(data.keyCount, 0, 'JSMAWS.env should be empty when appEnv is {}');
	} finally {
		await cleanup();
	}
});
