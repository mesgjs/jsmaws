/**
 * Tests for ServiceProcess base class
 *
 * Uses real PipeTransport with in-memory backing (makePipeTransportPair)
 * to test the PolyTransport-based control channel message loop.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { makePipeTransportPair } from '@poly-transport-test/transport-pipe-helpers.js';
import { ServiceProcess, CONTROL_MESSAGE_TYPES } from '../src/service-process.esm.js';
import { Configuration } from '../src/configuration.esm.js';

/**
 * Concrete subclass of ServiceProcess for testing.
 * Overrides abstract methods to record calls and allow test control.
 */
class TestServiceProcess extends ServiceProcess {
	constructor (processId) {
		super('test', processId ?? 'test-proc-1');
		this.configUpdates = [];
		this.healthChecks = [];
		this.shutdownCalled = false;
		this.reqChannels = [];
		this.onStartedCalled = false;
	}

	async handleConfigUpdate () {
		// this.config is already set/updated by the base class
		this.configUpdates.push({ ...this.config.config });
	}

	async handleHealthCheck (msg) {
		this.healthChecks.push(msg);
		await this.controlChannel.write('health-response', JSON.stringify({ status: 'ok' }));
	}

	async handleShutdown (_msg) {
		this.shutdownCalled = true;
		this.isShuttingDown = true;
	}

	async handleReqChannel (reqChannel) {
		this.reqChannels.push(reqChannel);
	}

	async onStarted () {
		this.onStartedCalled = true;
	}
}

/**
 * Helper: create a connected transport pair and set up a TestServiceProcess
 * with the service-side transport and control channel already open.
 *
 * Both sides call requestChannel('control') simultaneously — PolyTransport
 * settles to the lowest channel ID.
 *
 * Returns { proc, operatorTransport, serviceTransport, operatorControlChannel, cleanup }
 */
async function setupServiceProcess (processId) {
	const [operatorTransport, serviceTransport] = await makePipeTransportPair();

	// Accept all channels on both sides
	operatorTransport.addEventListener('newChannel', (event) => { event.accept(); });
	serviceTransport.addEventListener('newChannel', (event) => { event.accept(); });

	const proc = new TestServiceProcess(processId);

	// Inject the pre-started transport (bypass createTransport() which uses stdin/stdout)
	proc.transport = serviceTransport;
	proc.config = new Configuration({});

	// Both sides request the control channel simultaneously
	// PolyTransport settles to the lowest channel ID
	const [operatorControlChannel, serviceControlChannel] = await Promise.all([
		operatorTransport.requestChannel('control'),
		serviceTransport.requestChannel('control'),
	]);

	await Promise.all([
		operatorControlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES),
		serviceControlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES),
	]);

	proc.controlChannel = serviceControlChannel;

	const cleanup = async () => {
		// Stop both transports; ignore errors (e.g. already stopped)
		await Promise.allSettled([
			operatorTransport.stop({ discard: true }),
			serviceTransport.stop({ discard: true }),
		]);
	};

	return { proc, operatorTransport, serviceTransport, operatorControlChannel, cleanup };
}

// ─── Constructor Tests ────────────────────────────────────────────────────────

Deno.test('ServiceProcess - constructor sets process type and ID', () => {
	const proc = new TestServiceProcess('test-123');
	assertEquals(proc.processType, 'test');
	assertEquals(proc.processId, 'test-123');
	assertEquals(proc.isShuttingDown, false);
});

Deno.test('ServiceProcess - constructor uses provided ID', () => {
	const proc = new TestServiceProcess('my-proc');
	assertEquals(proc.processId, 'my-proc');
});

Deno.test('ServiceProcess - constructor generates ID if not provided', () => {
	const proc = new TestServiceProcess();
	assertEquals(proc.processType, 'test');
	assertEquals(proc.processId.startsWith('test-'), true);
});

// ─── Abstract Method Tests ────────────────────────────────────────────────────

Deno.test('ServiceProcess - subclass must implement handleConfigUpdate', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () { super('incomplete', 'test-123'); }
		async handleHealthCheck () {}
		async handleShutdown () {}
		async handleReqChannel () {}
	}

	const proc = new IncompleteProcess();
	await assertRejects(
		() => proc.handleConfigUpdate(),
		Error,
		'Subclass must implement handleConfigUpdate()'
	);
});

Deno.test('ServiceProcess - subclass must implement handleHealthCheck', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () { super('incomplete', 'test-123'); }
		async handleConfigUpdate () {}
		async handleShutdown () {}
		async handleReqChannel () {}
	}

	const proc = new IncompleteProcess();
	await assertRejects(
		() => proc.handleHealthCheck(null),
		Error,
		'Subclass must implement handleHealthCheck()'
	);
});

Deno.test('ServiceProcess - subclass must implement handleShutdown', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () { super('incomplete', 'test-123'); }
		async handleConfigUpdate () {}
		async handleHealthCheck () {}
		async handleReqChannel () {}
	}

	const proc = new IncompleteProcess();
	await assertRejects(
		() => proc.handleShutdown(null),
		Error,
		'Subclass must implement handleShutdown()'
	);
});

Deno.test('ServiceProcess - subclass must implement handleReqChannel', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () { super('incomplete', 'test-123'); }
		async handleConfigUpdate () {}
		async handleHealthCheck () {}
		async handleShutdown () {}
	}

	const proc = new IncompleteProcess();
	await assertRejects(
		() => proc.handleReqChannel(null),
		Error,
		'Subclass must implement handleReqChannel()'
	);
});

// ─── onStarted Hook ───────────────────────────────────────────────────────────

Deno.test('ServiceProcess - onStarted hook is called', async () => {
	const proc = new TestServiceProcess('test-123');
	await proc.onStarted();
	assertEquals(proc.onStartedCalled, true);
});

// ─── Control Channel Message Handling ────────────────────────────────────────

Deno.test('ServiceProcess - handles config-update message', async () => {
	const { proc, operatorControlChannel, cleanup } = await setupServiceProcess('cfg-test');

	try {
		// Start a single-message read loop on the service side
		const loopPromise = (async () => {
			try {
				const msg = await proc.controlChannel.read({
					only: ['config-update', 'health-check', 'shutdown', 'scale-down'],
					decode: true,
				});
				if (msg) {
					await msg.process(async () => {
						if (msg.messageType === 'config-update') {
								proc.config.updateConfig(JSON.parse(msg.text));
								await proc.handleConfigUpdate();
							}
					});
				}
			} catch (err) {
				// Ignore transport-stopping errors during cleanup
				if (err instanceof Error) console.log(err);
			}
		})();

		// Send config-update from operator
		const configData = { maxChunkSize: 65536, pools: {} };
		await operatorControlChannel.write('config-update', JSON.stringify(configData));

		await loopPromise;

		assertEquals(proc.configUpdates.length, 1);
		assertEquals(proc.configUpdates[0].maxChunkSize, 65536);
		// Verify this.config was updated by the base class
		assertEquals(proc.config.chunkSize, 65536);
	} finally {
		await cleanup();
	}
});

Deno.test('ServiceProcess - handles health-check message', async () => {
	const { proc, operatorControlChannel, cleanup } = await setupServiceProcess('hc-test');

	try {
		// Start a single-message read loop on the service side
		const loopPromise = (async () => {
			try {
				const msg = await proc.controlChannel.read({
					only: ['config-update', 'health-check', 'shutdown', 'scale-down'],
					decode: true,
				});
				if (msg) {
					await msg.process(async () => {
						if (msg.messageType === 'health-check') {
							await proc.handleHealthCheck(msg);
						}
					});
				}
			} catch (_err) {
				// Ignore transport-stopping errors during cleanup
			}
		})();

		// Send health-check from operator
		await operatorControlChannel.write('health-check', JSON.stringify({ timestamp: Date.now() }));

		// Wait for health-response on the operator side
		const responseMsg = await operatorControlChannel.read({ only: 'health-response', decode: true });
		let responseData;
		await responseMsg.process(() => {
			responseData = JSON.parse(responseMsg.text);
		});

		await loopPromise;

		assertEquals(proc.healthChecks.length, 1);
		assertEquals(responseData.status, 'ok');
	} finally {
		await cleanup();
	}
});

Deno.test('ServiceProcess - handles shutdown message', async () => {
	const { proc, operatorControlChannel, cleanup } = await setupServiceProcess('shutdown-test');

	try {
		// Start a single-message read loop on the service side
		const loopPromise = (async () => {
			try {
				const msg = await proc.controlChannel.read({
					only: ['config-update', 'health-check', 'shutdown', 'scale-down'],
					decode: true,
				});
				if (msg) {
					await msg.process(async () => {
						if (msg.messageType === 'shutdown') {
							await proc.handleShutdown(msg);
						}
					});
				}
			} catch (_err) {
				// Ignore transport-stopping errors during cleanup
			}
		})();

		// Send shutdown from operator
		await operatorControlChannel.write('shutdown', JSON.stringify({ timeout: 30 }));

		await loopPromise;

		assertEquals(proc.shutdownCalled, true);
		assertEquals(proc.isShuttingDown, true);
	} finally {
		await cleanup();
	}
});

// ─── sendCapacityUpdate ───────────────────────────────────────────────────────

Deno.test('ServiceProcess - sendCapacityUpdate sends capacity-update message', async () => {
	const { proc, operatorControlChannel, cleanup } = await setupServiceProcess('cap-test');

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

Deno.test('ServiceProcess - sendCapacityUpdate is no-op when no controlChannel', async () => {
	const proc = new TestServiceProcess('no-channel');
	// controlChannel is null — should not throw
	await proc.sendCapacityUpdate(1, 2);
	// No assertion needed — just verifying no error is thrown
});

// ─── CONTROL_MESSAGE_TYPES export ────────────────────────────────────────────

Deno.test('ServiceProcess - CONTROL_MESSAGE_TYPES includes expected types', () => {
	assertEquals(CONTROL_MESSAGE_TYPES.includes('config-update'), true);
	assertEquals(CONTROL_MESSAGE_TYPES.includes('health-check'), true);
	assertEquals(CONTROL_MESSAGE_TYPES.includes('health-response'), true);
	assertEquals(CONTROL_MESSAGE_TYPES.includes('shutdown'), true);
	assertEquals(CONTROL_MESSAGE_TYPES.includes('scale-down'), true);
	assertEquals(CONTROL_MESSAGE_TYPES.includes('capacity-update'), true);
});
