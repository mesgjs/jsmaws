/**
 * Persistent Mod-Apps Tests
 * Tests for persistent, long-lived, multi-route, and multi-request mod-apps.
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { PromiseTracer } from '@poly-transport/promise-tracer.esm.js';
import { makePipeTransportPair } from '@poly-transport-test/transport-pipe-helpers.js';
import { ResponderProcess } from '../src/responder-process.esm.js';
import { CONTROL_MESSAGE_TYPES } from '../src/sub-process.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from '../src/request-channel-pool.esm.js';
import { Configuration } from '../src/configuration.esm.js';

const bootstrapPath = new URL('../src/apps/bootstrap.esm.js', import.meta.url).href;
const APP_CHANNEL_MESSAGE_TYPES = ['req', 'res', 'res-frame', 'res-error'];
const mockShutdownMsg = {
	text: JSON.stringify({ timeout: 0 }),
	done: () => {},
	process: () => {},
};

/**
 * Create a test mod-app data URL from JavaScript source code
 */
function makeAppUrl (appCode) {
	return `data:application/javascript;base64,${btoa(appCode)}`;
}

/**
 * Set up a bootstrap worker with PostMessageTransport.
 * Returns { worker, transport, c2cChannel, bootstrapChannel, appChannel, cleanup }
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

	const promiseTracer = new PromiseTracer(5000, { logRejections: true });
	const c2cSymbol = Symbol('c2c');
	const transport = new PostMessageTransport({
		gateway: worker,
		c2cSymbol,
		promiseTracer,
		maxChunkBytes: 65536,
	});

	transport.addEventListener('newChannel', (event) => {
		event.accept();
	});

	await transport.start();

	const c2cChannel = transport.getChannel(c2cSymbol);

	const bootstrapChannel = await transport.requestChannel('bootstrap');
	await bootstrapChannel.addMessageTypes(['setup']);
	await bootstrapChannel.write('setup', JSON.stringify({
		appPath: appUrl,
		mode: 'response',
		keepDeno: false,
		keepWorkers: false,
		persistent: true,
		...setupOverrides,
	}));

	const appChannel = await transport.requestChannel('app');

	await appChannel.addMessageTypes(APP_CHANNEL_MESSAGE_TYPES);

	const cleanup = async () => {
		await transport.stop({ discard: true }).catch((err) => {
			if (err instanceof Error) throw (err);
		});
		worker.terminate();
	};

	return { worker, transport, c2cChannel, bootstrapChannel, appChannel, cleanup };
}

async function resetAppChannel (transport) {
	const appChannel = await transport.requestChannel('app');

	await appChannel.addMessageTypes(APP_CHANNEL_MESSAGE_TYPES);
	return appChannel;
}

/**
 * Create a minimal test configuration JSON string
 */
function makeConfigJson (overrides = {}) {
	return JSON.stringify({
		chunkSize: 65536,
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 4,
				maxWorkers: 10,
				reqTimeout: 30,
				idleTimeout: 60,
				conTimeout: 300,
				resType: ['response', 'stream', 'bidi'],
				persistent: true,
				maxWorkerReqs: 0,
				workerIdleTimeout: 0,
			},
		},
		mimeTypes: { '.html': 'text/html', '.js': 'application/javascript' },
		...overrides,
	});
}

/**
 * Set up a connected transport pair and set up a ResponderProcess
 */
async function setupResponderProcess (processId = 'test-responder-1', poolName = 'standard', configOverrides = {}) {
	const [operatorTransport, serviceTransport] = await makePipeTransportPair();

	operatorTransport.addEventListener('newChannel', (event) => { event.accept(); });
	serviceTransport.addEventListener('newChannel', (event) => { event.accept(); });

	const proc = new ResponderProcess(processId, poolName);

	proc.transport = serviceTransport;

	const [operatorControlChannel, serviceControlChannel] = await Promise.all([
		operatorTransport.requestChannel('control'),
		serviceTransport.requestChannel('control'),
	]);

	await Promise.all([
		operatorControlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES),
		serviceControlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES),
	]);

	proc.controlChannel = serviceControlChannel;

	const configJson = makeConfigJson(configOverrides);

	await operatorControlChannel.write('config-update', configJson);

	const configMsg = await serviceControlChannel.read({ only: 'config-update', decode: true });

	await configMsg.process(async () => {
		proc.config = new Configuration(JSON.parse(configMsg.text));
		await proc.handleConfigUpdate();
	});

	const cleanup = async () => {
		await Promise.allSettled([
			operatorTransport.stop({ discard: true }),
			serviceTransport.stop({ discard: true }),
		]);
		const exit = Deno.exit;
		try {
			Deno.exit = () => {};
			await proc.handleShutdown(mockShutdownMsg);
		} finally {
			Deno.exit = exit;
		}
	};

	return { proc, operatorTransport, serviceTransport, operatorControlChannel, cleanup };
}

// --- Tests --------------------------------------------------------------------

Deno.test('Persistent Mod-Apps - Low-Level Channel Model: worker reuse and state preservation', async () => {
	const appCode = `
		let counter = 0;
		export default async function (setupData) {
			const server = globalThis.JSMAWS.server;
			while (true) {
				const reqMsg = await server.read({ only: 'req', decode: true });
				if (!reqMsg) break;

				reqMsg.done();
				counter++;

				await server.write('res', JSON.stringify({
					status: 200,
					headers: { 'content-type': 'application/json' },
				}));
				await server.write('res-frame', JSON.stringify({ counter }));
				await server.write('res-frame', null);
			}
		}
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, { persistent: true });

	try {
		// Request 1
		await appChannel.write('req', JSON.stringify({ method: 'GET', url: 'http://localhost/' }));

		const resMsg1 = await appChannel.read({ only: 'res', decode: true });
		assertExists(resMsg1);
		let resData1;
		await resMsg1.process(() => {
			resData1 = JSON.parse(resMsg1.text);
		});
		assertEquals(resData1.status, 200);

		const frameMsg1 = await appChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg1);
		let frameData1;
		await frameMsg1.process(() => {
			frameData1 = JSON.parse(frameMsg1.text);
		});
		assertEquals(frameData1.counter, 1);

		const eosMsg1 = await appChannel.read({ only: 'res-frame' });
		assertExists(eosMsg1);
		eosMsg1.done();
		assertEquals(eosMsg1.text, undefined);
		assertEquals(eosMsg1.data, undefined);

		// Request 2 (on the same channel/worker)
		await appChannel.write('req', JSON.stringify({ method: 'GET', url: 'http://localhost/' }));

		const resMsg2 = await appChannel.read({ only: 'res', decode: true });
		assertExists(resMsg2);
		let resData2;
		await resMsg2.process(() => {
			resData2 = JSON.parse(resMsg2.text);
		});
		assertEquals(resData2.status, 200);

		const frameMsg2 = await appChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg2);
		let frameData2;
		await frameMsg2.process(() => {
			frameData2 = JSON.parse(frameMsg2.text);
		});
		assertEquals(frameData2.counter, 2);

		const eosMsg2 = await appChannel.read({ only: 'res-frame' });
		assertExists(eosMsg2);
		eosMsg2.done();
	} finally {
		await cleanup();
	}
});

Deno.test('Persistent Mod-Apps - Standard Fetch Model: one-shot mode', async () => {
	const appCode = `
		export default {
			async fetch (request, env) {
				const url = new URL(request.url);
				if (url.pathname === '/hello') {
					return new Response('Hello World', {
						status: 200,
						headers: { 'x-custom': 'yes' }
					});
				}
				return new Response('Not Found', { status: 404 });
			}
		};
	`;

	const { appChannel, cleanup } = await setupBootstrapWorker(appCode, { persistent: false });

	try {
		await appChannel.write('req', JSON.stringify({
			method: 'GET',
			url: 'http://localhost/hello',
			headers: {},
		}));

		const resMsg = await appChannel.read({ only: 'res', decode: true });
		assertExists(resMsg);
		let resData;
		await resMsg.process(() => {
			resData = JSON.parse(resMsg.text);
		});
		assertEquals(resData.status, 200);
		assertEquals(resData.headers['x-custom'], 'yes');

		const frameMsg = await appChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg);
		let frameData;
		await frameMsg.process(() => {
			frameData = frameMsg.text;
		});
		assertEquals(frameData, 'Hello World');

		const eosMsg = await appChannel.read({ only: 'res-frame' });
		assertExists(eosMsg);
		eosMsg.done();
	} finally {
		await cleanup();
	}
});

Deno.test('Persistent Mod-Apps - Standard Fetch Model: persistent mode', async () => {
	const appCode = `
		let counter = 0;
		export default {
			async fetch (request, env) {
				counter++;
				return Response.json({ counter });
			}
		};
	`;

	let { appChannel, transport, cleanup } = await setupBootstrapWorker(appCode, { persistent: true });

	try {
		// Request 1
		await appChannel.write('req', JSON.stringify({
			method: 'GET',
			url: 'http://localhost/',
			headers: {},
		}));

		const resMsg1 = await appChannel.read({ only: 'res', decode: true });
		assertExists(resMsg1);
		resMsg1.done();

		const frameMsg1 = await appChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg1);
		let frameData1;
		await frameMsg1.process(() => {
			frameData1 = JSON.parse(frameMsg1.text);
		});
		assertEquals(frameData1.counter, 1);

		const eosMsg1 = await appChannel.read({ only: 'res-frame' });
		assertExists(eosMsg1);
		eosMsg1.done();
		await appChannel.close();

		appChannel = await resetAppChannel(transport);

		// Request 2
		await appChannel.write('req', JSON.stringify({
			method: 'GET',
			url: 'http://localhost/',
			headers: {},
		}));

		const resMsg2 = await appChannel.read({ only: 'res', decode: true });
		assertExists(resMsg2);
		resMsg2.done();

		const frameMsg2 = await appChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg2);
		let frameData2;
		await frameMsg2.process(() => {
			frameData2 = JSON.parse(frameMsg2.text);
		});
		assertEquals(frameData2.counter, 2);

		const eosMsg2 = await appChannel.read({ only: 'res-frame' });
		assertExists(eosMsg2);
		eosMsg2.done();
	} finally {
		await cleanup();
	}
});

Deno.test('Persistent Mod-Apps - ResponderProcess: persistent worker reuse', async () => {
	const appCode = `
		export default {
			async fetch (request, env) {
				return new Response('OK');
			}
		};
	`;
	const appUrl = makeAppUrl(appCode);

	const { proc, operatorTransport, serviceTransport, cleanup } = await setupResponderProcess('rp-persistent-test', 'standard');

	try {
		const [operatorReqChannel, serviceReqChannel] = await Promise.all([
			operatorTransport.requestChannel('req-0'),
			serviceTransport.requestChannel('req-0'),
		]);

		await Promise.all([
			operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
			serviceReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
		]);

		proc.channelMap.set(serviceReqChannel, 'req-0');
		proc.handleReqChannel(serviceReqChannel);

		// Request 1
		const requestData1 = {
			id: 'req-1',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData1));

		// Read response 1
		const resMsg1 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg1);
		resMsg1.done();

		const frameMsg1 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg1);
		frameMsg1.done();

		const eosMsg1 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg1);
		eosMsg1.done();

		// Verify worker is in workersByApp registry and is idle
		const workers = proc.workersByApp.get(appUrl);
		assertExists(workers);
		assertEquals(workers.length, 1);
		// Wait for worker to become idle (since resetting is async)
		for (let i = 0; i < 50 && workers[0].status !== 'idle'; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assertEquals(workers[0].status, 'idle');
		assertEquals(workers[0].reqCount, 1);

		const originalWorker = workers[0].worker;

		// Request 2 (should reuse the same worker)
		const requestData2 = {
			id: 'req-2',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData2));

		// Read response 2
		const resMsg2 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg2);
		resMsg2.done();

		const frameMsg2 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg2);
		frameMsg2.done();

		const eosMsg2 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg2);
		eosMsg2.done();

		// Verify same worker was reused and reqCount is 2
		assertEquals(workers.length, 1);
		assertEquals(workers[0].worker, originalWorker);
		// Wait for worker to become idle (since resetting is async)
		for (let i = 0; i < 50 && workers[0].status !== 'idle'; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assertEquals(workers[0].status, 'idle');
		assertEquals(workers[0].reqCount, 2);
	} finally {
		await cleanup();
	}
});

Deno.test('Persistent Mod-Apps - ResponderProcess: maxWorkerReqs recycling', async () => {
	const appCode = `
		export default {
			async fetch (request, env) {
				return new Response('OK');
			}
		};
	`;
	const appUrl = makeAppUrl(appCode);

	// Set maxWorkerReqs to 2
	const { proc, operatorTransport, serviceTransport, cleanup } = await setupResponderProcess('rp-recycle-test', 'standard', {
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 4,
				maxWorkers: 10,
				reqTimeout: 30,
				idleTimeout: 60,
				conTimeout: 300,
				resType: ['response', 'stream', 'bidi'],
				persistent: true,
				maxWorkerReqs: 2,
				workerIdleTimeout: 0,
			},
		},
	});

	try {
		const [operatorReqChannel, serviceReqChannel] = await Promise.all([
			operatorTransport.requestChannel('req-0'),
			serviceTransport.requestChannel('req-0'),
		]);

		await Promise.all([
			operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
			serviceReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
		]);

		proc.channelMap.set(serviceReqChannel, 'req-0');
		proc.handleReqChannel(serviceReqChannel);

		// Request 1
		const requestData1 = {
			id: 'req-1',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData1));

		// Read response 1
		const resMsg1 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg1);
		resMsg1.done();

		const frameMsg1 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg1);
		frameMsg1.done();

		const eosMsg1 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg1);
		eosMsg1.done();

		const workers = proc.workersByApp.get(appUrl);
		assertExists(workers);
		assertEquals(workers.length, 1);
		assertEquals(workers[0].reqCount, 1);

		const originalWorker = workers[0].worker;

		// Allow time for the persistent worker to reset between requests
		// so that the same one can be reassigned
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Request 2 (reaches maxWorkerReqs = 2, should trigger recycling)
		const requestData2 = {
			id: 'req-2',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData2));

		// Read response 2
		const resMsg2 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg2);
		resMsg2.done();

		const frameMsg2 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg2);
		frameMsg2.done();

		const eosMsg2 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg2);
		eosMsg2.done();

		// Wait a brief moment for recycling to complete
		await new Promise ((resolve) => setTimeout (resolve, 1000));

		// Verify the original worker was removed from the registry
		const workersAfter = proc.workersByApp.get(appUrl) || [];
		const foundOriginal = workersAfter.some (w => w.worker === originalWorker);
		assertEquals(foundOriginal, false);
	} finally {
		await cleanup();
	}
});

Deno.test('Persistent Mod-Apps - ResponderProcess: workerIdleTimeout cleanup', async () => {
	const originalInterval = ResponderProcess.WORKER_IDLE_CHECK_INTERVAL;
	ResponderProcess.WORKER_IDLE_CHECK_INTERVAL = 100; // Check every 100ms

	const appCode = `
		export default {
			async fetch (request, env) {
				return new Response('OK');
			}
		};
	`;
	const appUrl = makeAppUrl(appCode);

	try {
		// Set workerIdleTimeout to 1 second
		const { proc, operatorTransport, serviceTransport, cleanup } = await setupResponderProcess('rp-idle-test', 'standard', {
			pools: {
				standard: {
					minProcs: 1,
					maxProcs: 4,
					maxWorkers: 10,
					reqTimeout: 30,
					idleTimeout: 60,
					conTimeout: 300,
					resType: ['response', 'stream', 'bidi'],
					persistent: true,
					maxWorkerReqs: 0,
					workerIdleTimeout: 1,
				},
			},
		});

		const [operatorReqChannel, serviceReqChannel] = await Promise.all([
			operatorTransport.requestChannel('req-0'),
			serviceTransport.requestChannel('req-0'),
		]);

		await Promise.all([
			operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
			serviceReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
		]);

		proc.channelMap.set(serviceReqChannel, 'req-0');
		proc.handleReqChannel(serviceReqChannel);

		// Request 1
		const requestData1 = {
			id: 'req-1',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData1));

		// Read response 1
		const resMsg1 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg1);
		resMsg1.done();

		const frameMsg1 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg1);
		frameMsg1.done();

		const eosMsg1 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg1);
		eosMsg1.done();

		// Verify worker is in workersByApp registry and is idle
		const workers = proc.workersByApp.get(appUrl);
		const status = workers[0].status;
		assertExists(workers);
		assertEquals(workers.length, 1);
		assert(status === 'idle' || status === 'resetting');

		// Wait for idle timeout (1.5 seconds)
		// FEEDBACK: I believe the worker idle check only runs every 10s
		await new Promise ((resolve) => setTimeout (resolve, 1500));

		// Verify the worker was cleaned up
		const workersAfter = proc.workersByApp.get(appUrl);
		assertEquals(workersAfter, undefined);
		await cleanup();
	} finally {
		ResponderProcess.WORKER_IDLE_CHECK_INTERVAL = originalInterval;
	}
});

Deno.test('Persistent Mod-Apps - ResponderProcess: unexpected termination while busy', async () => {
	const appCode = `
		export default {
			async fetch (request, env) {
				// Wait forever to simulate a long-running request
				await new Promise(() => {});
			}
		};
	`;
	const appUrl = makeAppUrl(appCode);

	const { proc, operatorTransport, serviceTransport, cleanup } = await setupResponderProcess('rp-term-busy-test', 'standard');

	try {
		const [operatorReqChannel, serviceReqChannel] = await Promise.all([
			operatorTransport.requestChannel('req-0'),
			serviceTransport.requestChannel('req-0'),
		]);

		await Promise.all([
			operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
			serviceReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
		]);

		proc.channelMap.set(serviceReqChannel, 'req-0');
		proc.handleReqChannel(serviceReqChannel);

		// Send request
		const requestData = {
			id: 'req-busy-term',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData));

		// Wait for worker to be spawned and become busy
		let workers;
		for (let i = 0; i < 50; i++) {
			workers = proc.workersByApp.get(appUrl);
			if (workers && workers.length === 1 && workers[0].status === 'busy') {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		assertExists(workers);
		assertEquals(workers.length, 1);
		const workerInfo = workers[0];
		assertEquals(workerInfo.status, 'busy');

		// Terminate the worker unexpectedly
		workerInfo.worker.terminate();
		// Stop the transport with disconnected: true to trigger the 'stopped' event
		await workerInfo.transport.stop({ disconnected: true });

		// Read the error response from operator side
		const responseMsg = await operatorReqChannel.read({ only: 'res-error', decode: true });
		assertExists(responseMsg);
		let errorData;
		await responseMsg.process(() => {
			errorData = JSON.parse(responseMsg.text);
		});

		assertEquals(errorData.status, 503);
		assertEquals(errorData.error, 'Service Unavailable');

		// Verify request is removed from activeRequests
		assertEquals(proc.activeRequests.has('req-busy-term'), false);

		// Verify worker is removed from workersByApp registry
		const workersAfter = proc.workersByApp.get(appUrl);
		assertEquals(workersAfter, undefined);
	} finally {
		await cleanup();
	}
});

Deno.test('Persistent Mod-Apps - ResponderProcess: unexpected termination while idle', async () => {
	const appCode = `
		export default {
			async fetch (request, env) {
				return new Response('OK');
			}
		};
	`;
	const appUrl = makeAppUrl(appCode);

	const { proc, operatorTransport, serviceTransport, cleanup } = await setupResponderProcess('rp-term-idle-test', 'standard');

	try {
		const [operatorReqChannel, serviceReqChannel] = await Promise.all([
			operatorTransport.requestChannel('req-0'),
			serviceTransport.requestChannel('req-0'),
		]);

		await Promise.all([
			operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
			serviceReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES),
		]);

		proc.channelMap.set(serviceReqChannel, 'req-0');
		proc.handleReqChannel(serviceReqChannel);

		// Send request 1
		const requestData1 = {
			id: 'req-1',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData1));

		// Read response 1
		const resMsg1 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg1);
		resMsg1.done();

		const frameMsg1 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg1);
		frameMsg1.done();

		const eosMsg1 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg1);
		eosMsg1.done();

		// Wait for worker to become idle
		const workers = proc.workersByApp.get(appUrl);
		assertExists(workers);
		assertEquals(workers.length, 1);
		for (let i = 0; i < 50 && workers[0].status !== 'idle'; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assertEquals(workers[0].status, 'idle');

		const originalWorker = workers[0].worker;

		// Terminate the worker unexpectedly while idle
		workers[0].worker.terminate();
		await workers[0].transport.stop({ disconnected: true });

		// Verify worker is removed from workersByApp registry
		const workersAfterTerm = proc.workersByApp.get(appUrl);
		assertEquals(workersAfterTerm, undefined);

		// Send request 2 (should spawn a new worker)
		const requestData2 = {
			id: 'req-2',
			method: 'GET',
			url: 'https://example.com/test',
			app: appUrl,
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
			routeSpec: { persistent: true },
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData2));

		// Read response 2
		const resMsg2 = await operatorReqChannel.read({ only: 'res', decode: true });
		assertExists(resMsg2);
		resMsg2.done();

		const frameMsg2 = await operatorReqChannel.read({ only: 'res-frame', decode: true });
		assertExists(frameMsg2);
		frameMsg2.done();

		const eosMsg2 = await operatorReqChannel.read({ only: 'res-frame' });
		assertExists(eosMsg2);
		eosMsg2.done();

		// Verify a new worker was spawned and is in the registry
		const workersAfter2 = proc.workersByApp.get(appUrl);
		assertExists(workersAfter2);
		assertEquals(workersAfter2.length, 1);
		assert(workersAfter2[0].worker !== originalWorker);
	} finally {
		await cleanup();
	}
});
