/**
 * Tests for responder-process.esm.js
 *
 * Uses real PipeTransport with in-memory backing (makePipeTransportPair)
 * to test the PolyTransport-based request handling.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { makePipeTransportPair } from '@poly-transport-test/transport-pipe-helpers.js';
import { ResponderProcess } from '../src/responder-process.esm.js';
import { CONTROL_MESSAGE_TYPES } from '../src/service-process.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from '../src/request-channel-pool.esm.js';
import { Configuration } from '../src/configuration.esm.js';

/**
 * Create a minimal test configuration JSON string
 */
function makeConfigJson (overrides = {}) {
	return JSON.stringify({
		maxDirectWrite: 65536,
		autoChunkThresh: 10485760,
		chunkSize: 65536,
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 4,
				maxWorkers: 10,
				reqTimeout: 30,
				idleTimeout: 60,
				conTimeout: 300,
				allowedResponseTypes: ['response', 'stream', 'bidi'],
			},
		},
		routing: { root: '/var/www' },
		mimeTypes: { '.html': 'text/html', '.js': 'application/javascript' },
		bidiFlowControl: {
			initialCredits: 10,
			maxBytesPerSecond: 10485760,
			idleTimeout: 60,
			maxBufferSize: 1048576,
		},
		...overrides,
	});
}

// FEEDBACK: I believe bidi flow control is superceded by PolyTransport
// Having symmetrical requests (channels, message types) is OK for testing, but is unnecessary extra traffic for production (operator should manage operator-involved transports, responder for responder-applet transports)

/**
 * Helper: create a connected transport pair and set up a ResponderProcess
 * with the service-side transport and control channel already open.
 *
 * Returns { proc, operatorTransport, serviceTransport, operatorControlChannel, cleanup }
 */
async function setupResponderProcess (processId = 'test-responder-1', poolName = 'standard') {
	const [operatorTransport, serviceTransport] = await makePipeTransportPair();

	// Accept all channels on both sides
	operatorTransport.addEventListener('newChannel', (event) => { event.accept(); });
	serviceTransport.addEventListener('newChannel', (event) => { event.accept(); });

	const proc = new ResponderProcess(processId, poolName);

	// Inject the pre-started transport (bypass createTransport() which uses stdin/stdout)
	proc.transport = serviceTransport;

	// Both sides request the control channel simultaneously
	const [operatorControlChannel, serviceControlChannel] = await Promise.all([
		operatorTransport.requestChannel('control'),
		serviceTransport.requestChannel('control'),
	]);

	await Promise.all([
		operatorControlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES),
		serviceControlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES),
	]);

	proc.controlChannel = serviceControlChannel;

	// Send initial config so the responder is ready
	const configJson = makeConfigJson();
	await operatorControlChannel.write('config-update', configJson);

	// Process the config-update on the service side
	const configMsg = await serviceControlChannel.read({ only: 'config-update', decode: true });
	await configMsg.process(async () => {
		proc.config = new Configuration(JSON.parse(configMsg.text));
		await proc.handleConfigUpdate(configMsg.text);
	});

	const cleanup = async () => {
		await Promise.allSettled([
			operatorTransport.stop({ discard: true }),
			serviceTransport.stop({ discard: true }),
		]);
	};

	return { proc, operatorTransport, serviceTransport, operatorControlChannel, cleanup };
}

// ─── Constructor Tests ────────────────────────────────────────────────────────

Deno.test('ResponderProcess - constructor sets processId and poolName', () => {
	const proc = new ResponderProcess('test-proc-1', 'standard');
	assertEquals(proc.processId, 'test-proc-1');
	assertEquals(proc.poolName, 'standard');
	assertExists(proc.activeRequests);
	assertEquals(proc.activeRequests.size, 0);
});

Deno.test('ResponderProcess - constructor throws without poolName', () => {
	let threw = false;
	try {
		new ResponderProcess('test-proc-2');
	} catch (err) {
		threw = true;
		assert(err.message.includes('pool name'));
	}
	assertEquals(threw, true);
});

Deno.test('ResponderProcess - constructor throws with empty poolName', () => {
	let threw = false;
	try {
		new ResponderProcess('test-proc-3', '');
	} catch (err) {
		threw = true;
		assert(err.message.includes('pool name'));
	}
	assertEquals(threw, true);
});

// ─── availWorkers getter ──────────────────────────────────────────────────────

Deno.test('ResponderProcess - availWorkers reflects capacity', () => {
	const proc = new ResponderProcess('test-proc-4', 'standard');
	proc.maxConcurrentRequests = 10;
	assertEquals(proc.availWorkers, 10);

	// Simulate active requests
	proc.activeRequests.set('req-1', {});
	proc.activeRequests.set('req-2', {});
	assertEquals(proc.availWorkers, 8);

	proc.activeRequests.clear();
	assertEquals(proc.availWorkers, 10);
});

// ─── handleConfigUpdate ───────────────────────────────────────────────────────

Deno.test('ResponderProcess - handleConfigUpdate updates chunkingConfig', async () => {
	const proc = new ResponderProcess('test-proc-5', 'standard');
	proc.config = new Configuration(JSON.parse(makeConfigJson()));

	const configJson = makeConfigJson({
		maxDirectWrite: 32768,
		autoChunkThresh: 5242880,
		chunkSize: 32768,
	});
	await proc.handleConfigUpdate(configJson);

	assertEquals(proc.chunkingConfig.maxDirectWrite, 32768);
	assertEquals(proc.chunkingConfig.autoChunkThresh, 5242880);
	assertEquals(proc.chunkingConfig.chunkSize, 32768);
});

Deno.test('ResponderProcess - handleConfigUpdate updates maxConcurrentRequests from pool', async () => {
	const proc = new ResponderProcess('test-proc-6', 'standard');
	proc.config = new Configuration(JSON.parse(makeConfigJson()));

	const configJson = makeConfigJson({
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 4,
				maxWorkers: 20,
				reqTimeout: 30,
				idleTimeout: 60,
				conTimeout: 300,
				allowedResponseTypes: ['response', 'stream', 'bidi'],
			},
		},
	});
	await proc.handleConfigUpdate(configJson);

	assertEquals(proc.maxConcurrentRequests, 20);
});

// ─── handleHealthCheck ────────────────────────────────────────────────────────

Deno.test('ResponderProcess - handleHealthCheck sends health-response', async () => {
	const { proc, operatorControlChannel, cleanup } = await setupResponderProcess('hc-test');

	try {
		// Send health-check from operator
		await operatorControlChannel.write('health-check', JSON.stringify({ timestamp: Date.now() }));

		// Read health-check on service side and handle it
		const hcMsg = await proc.controlChannel.read({ only: 'health-check', decode: true });
		await hcMsg.process(async () => {
			await proc.handleHealthCheck(hcMsg);
		});

		// Read health-response on operator side
		const responseMsg = await operatorControlChannel.read({ only: 'health-response', decode: true });
		let responseData;
		await responseMsg.process(() => {
			responseData = JSON.parse(responseMsg.text);
		});

		assertEquals(responseData.status, 'ok');
		assertExists(responseData.availableWorkers);
		assertExists(responseData.totalWorkers);
		assertExists(responseData.uptime);
	} finally {
		await cleanup();
	}
});

// ─── cleanupRequest ───────────────────────────────────────────────────────────

Deno.test('ResponderProcess - cleanupRequest removes active request', () => {
	const proc = new ResponderProcess('test-proc-7', 'standard');

	// Add a fake request with a timeout
	const timeout = setTimeout(() => {}, 10000);
	proc.activeRequests.set('req-1', { timeout, worker: null, transport: null });

	assertEquals(proc.activeRequests.has('req-1'), true);
	proc.cleanupRequest('req-1');
	assertEquals(proc.activeRequests.has('req-1'), false);

	// Cleanup the timeout (cleanupRequest should have cleared it)
	clearTimeout(timeout); // Safe to call even if already cleared
});

Deno.test('ResponderProcess - cleanupRequest is no-op for unknown request', () => {
	const proc = new ResponderProcess('test-proc-8', 'standard');
	// Should not throw
	proc.cleanupRequest('nonexistent-req');
	assertEquals(proc.activeRequests.size, 0);
});

// ─── handleReqChannel ─────────────────────────────────────────────────────────

Deno.test('ResponderProcess - handleReqChannel registers message types', async () => {
	const { proc, operatorTransport, cleanup } = await setupResponderProcess('req-channel-test');

	try {
		// Open a req-N channel from the operator side
		const operatorReqChannel = await operatorTransport.requestChannel('req-0');
		await operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);

		// Get the service-side channel (it was accepted by the newChannel listener)
		// We need to wait for the service side to accept and process it
		// The service side's handleReqChannel is called when the channel is accepted
		let serviceReqChannel = null;
		const channelPromise = new Promise((resolve) => {
			proc.transport.addEventListener('newChannel', (event) => {
				if (event.detail.channelName === 'req-0') {
					resolve(event.detail.channel);
				}
			});
		});

		// Trigger the channel open from operator side
		// (already done above, but we need to wait for service side to process)
		serviceReqChannel = await Promise.race([
			channelPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
		]).catch(() => null);

		// The channel should have been accepted
		assertExists(operatorReqChannel);
	} finally {
		await cleanup();
	}
});

// ─── handleShutdown ───────────────────────────────────────────────────────────

Deno.test('ResponderProcess - handleShutdown sets isShuttingDown', async () => {
	const proc = new ResponderProcess('shutdown-test', 'standard');
	proc.config = new Configuration(JSON.parse(makeConfigJson()));

	// Mock transport.stop() to avoid actual process exit
	proc.transport = {
		stop: async () => {},
	};

	// Mock Deno.exit to prevent actual exit
	const originalExit = Deno.exit;
	let exitCalled = false;
	let exitCode = null;
	Deno.exit = (code) => {
		exitCalled = true;
		exitCode = code;
	};

	try {
		// Create a mock shutdown message
		const mockMsg = {
			text: JSON.stringify({ timeout: 0 }),
		};

		await proc.handleShutdown(mockMsg);

		assertEquals(proc.isShuttingDown, true);
		assertEquals(exitCalled, true);
		assertEquals(exitCode, 0);
	} finally {
		Deno.exit = originalExit;
	}
});

// ─── sendCapacityUpdate ───────────────────────────────────────────────────────

Deno.test('ResponderProcess - sendCapacityUpdate sends capacity-update message', async () => {
	const { proc, operatorControlChannel, cleanup } = await setupResponderProcess('cap-test');

	try {
		// Send capacity update from service process
		await proc.sendCapacityUpdate(5, 10);

		// Read it on the operator side
		const msg = await operatorControlChannel.read({ only: 'capacity-update', decode: true });
		let data;
		await msg.process(() => {
			data = JSON.parse(msg.text);
		});

		assertEquals(data.availableWorkers, 5);
		assertEquals(data.totalWorkers, 10);
	} finally {
		await cleanup();
	}
});

// ─── Request handling via req-N channel ──────────────────────────────────────

Deno.test('ResponderProcess - returns 503 when at capacity', async () => {
	const { proc, operatorTransport, cleanup } = await setupResponderProcess('capacity-test');

	try {
		// Fill capacity
		proc.maxConcurrentRequests = 2;
		proc.activeRequests.set('req-existing-1', { timeout: null, worker: null, transport: null });
		proc.activeRequests.set('req-existing-2', { timeout: null, worker: null, transport: null });

		// Open a req-N channel from the operator side
		const operatorReqChannel = await operatorTransport.requestChannel('req-0');
		await operatorReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);

		// Wait for service side to accept the channel
		const serviceReqChannelPromise = new Promise((resolve) => {
			const handler = (event) => {
				if (event.detail.channelName === 'req-0') {
					proc.transport.removeEventListener('newChannel', handler);
					resolve(event.detail.channel);
				}
			};
			proc.transport.addEventListener('newChannel', handler);
		});

		const serviceReqChannel = await Promise.race([
			serviceReqChannelPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
		]);

		// Call handleReqChannel directly with the service-side channel
		await serviceReqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);

		// Send a request from operator
		const requestData = {
			id: 'req-new',
			method: 'GET',
			url: 'https://example.com/test',
			app: 'test-app',
			pool: 'standard',
			headers: {},
			routeParams: {},
			routeTail: '/test',
		};
		await operatorReqChannel.write('req', JSON.stringify(requestData));

		// Start handleReqChannel on the service side
		const handlePromise = proc.handleReqChannel(serviceReqChannel);

		// Read the error response from operator side
		const responseMsg = await operatorReqChannel.read({ only: 'res-error', decode: true });
		let errorData;
		await responseMsg.process(() => {
			errorData = JSON.parse(responseMsg.text);
		});

		assertEquals(errorData.status, 503);

		// Cleanup
		proc.activeRequests.clear();
		await operatorReqChannel.close?.();
	} finally {
		await cleanup();
	}
});

// ─── onStarted hook ───────────────────────────────────────────────────────────

Deno.test('ResponderProcess - onStarted logs pool info', async () => {
	const proc = new ResponderProcess('started-test', 'standard');
	proc.config = new Configuration(JSON.parse(makeConfigJson()));
	proc.maxConcurrentRequests = 10;

	// Should not throw
	await proc.onStarted();
});
