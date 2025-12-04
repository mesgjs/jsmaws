/**
 * Tests for ServiceProcess base class
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '../src/vendor.esm.js';
import { ServiceProcess } from '../src/service-process.esm.js';
import { Configuration } from '../src/configuration.esm.js';
import { MessageType } from '../src/ipc-protocol.esm.js';

/**
 * Mock service process for testing
 */
class MockServiceProcess extends ServiceProcess {
	constructor (processId) {
		super('mock', processId);
		this.configUpdateCalled = false;
		this.healthCheckCalled = false;
		this.shutdownCalled = false;
		this.onStartedCalled = false;
		this.config = new Configuration();
	}

	handleConfigUpdate (fields) {
		this.configUpdateCalled = true;
		this.config.set('test', fields.at('test'));
	}

	async handleHealthCheck (id, fields) {
		this.healthCheckCalled = true;
		const response = new NANOS(MessageType.HEALTH_CHECK, { id });
		response.setOpts({ transform: true });
		response.push([{
			timestamp: fields.at('timestamp'),
			status: 'ok',
		}]);
		await this.ipcConn.writeMessage(response);
	}

	async handleShutdown (fields) {
		this.shutdownCalled = true;
		this.isShuttingDown = true;
		if (this.ipcConn) {
			await this.ipcConn.close();
		}
	}

	async onStarted () {
		this.onStartedCalled = true;
	}
}

/**
 * Mock IPC connection for testing event-driven architecture
 */
class MockIPCConnection {
	constructor () {
		this.messageHandlers = new Map();
		this.writtenMessages = [];
		this.closed = false;
		this.monitoring = false;
	}

	// Register message handler (event-driven)
	onMessage (type, handler) {
		this.messageHandlers.set(type, handler);
	}

	// Simulate receiving a message (for testing)
	async simulateMessage (type, id, fields, binaryData = null) {
		const handler = this.messageHandlers.get(type);
		if (handler) {
			const message = { type, id, fields };
			await handler(message, binaryData);
		}
	}

	// Write message
	writeMessage (message, binaryData = null) {
		this.writtenMessages.push({ message, binaryData });
	}

	// Start monitoring (no-op for mock)
	async startMonitoring () {
		this.monitoring = true;
		// In real implementation, this would block and read messages
		// For testing, we just set the flag
	}

	// Stop monitoring
	stopMonitoring () {
		this.monitoring = false;
	}

	// Close connection
	async close () {
		this.closed = true;
		this.stopMonitoring();
	}
}

Deno.test('ServiceProcess - constructor sets process type and ID', () => {
	const process = new MockServiceProcess('test-123');
	assertEquals(process.processType, 'mock');
	assertEquals(process.processId, 'test-123');
	assertEquals(process.isShuttingDown, false);
});

Deno.test('ServiceProcess - constructor generates ID if not provided', () => {
	const process = new MockServiceProcess();
	assertEquals(process.processType, 'mock');
	assertEquals(process.processId.startsWith('mock-'), true);
});

Deno.test('ServiceProcess - getMessageHandlers returns base handlers', () => {
	const process = new MockServiceProcess('test-123');
	const handlers = process.getMessageHandlers();

	assertEquals(handlers.has(MessageType.CONFIG_UPDATE), true);
	assertEquals(handlers.has(MessageType.HEALTH_CHECK), true);
	assertEquals(handlers.has(MessageType.SHUTDOWN), true);
});

Deno.test('ServiceProcess - setupMessageHandlers registers CONFIG_UPDATE handler', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	process.ipcConn = mockConn;

	// Setup handlers
	process.setupMessageHandlers();

	// Verify handler is registered
	assertEquals(mockConn.messageHandlers.has(MessageType.CONFIG_UPDATE), true);

	// Simulate receiving a config update message
	const fields = new NANOS({ test: 'value' });
	await mockConn.simulateMessage(MessageType.CONFIG_UPDATE, 'cfg-1', fields);

	assertEquals(process.configUpdateCalled, true);
	assertEquals(process.config.get('test'), 'value');
});

Deno.test('ServiceProcess - setupMessageHandlers registers HEALTH_CHECK handler', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	process.ipcConn = mockConn;

	// Setup handlers
	process.setupMessageHandlers();

	// Verify handler is registered
	assertEquals(mockConn.messageHandlers.has(MessageType.HEALTH_CHECK), true);

	// Simulate receiving a health check message
	const fields = new NANOS({ timestamp: Date.now() });
	await mockConn.simulateMessage(MessageType.HEALTH_CHECK, 'hc-1', fields);

	assertEquals(process.healthCheckCalled, true);
	assertEquals(mockConn.writtenMessages.length, 1);
	assertEquals(mockConn.writtenMessages[0].message.at(0), MessageType.HEALTH_CHECK);
});

Deno.test('ServiceProcess - setupMessageHandlers registers SHUTDOWN handler', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	process.ipcConn = mockConn;

	// Setup handlers
	process.setupMessageHandlers();

	// Verify handler is registered
	assertEquals(mockConn.messageHandlers.has(MessageType.SHUTDOWN), true);

	// Simulate receiving a shutdown message
	const fields = new NANOS({ timeout: 30 });
	await mockConn.simulateMessage(MessageType.SHUTDOWN, 'halt-1', fields);

	assertEquals(process.shutdownCalled, true);
	assertEquals(process.isShuttingDown, true);
	assertEquals(mockConn.closed, true);
});

Deno.test('ServiceProcess - setupMessageHandlers handles handler errors gracefully', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	process.ipcConn = mockConn;

	// Override handler to throw error
	process.handleConfigUpdate = () => {
		throw new Error('Handler error');
	};

	// Setup handlers
	process.setupMessageHandlers();

	// Simulate message - should not crash
	const fields = new NANOS({ test: 'value' });
	await mockConn.simulateMessage(MessageType.CONFIG_UPDATE, 'cfg-1', fields);

	// Process should still be functional
	assertEquals(process.isShuttingDown, false);
});

Deno.test('ServiceProcess - startMonitoring is called during start', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();

	// Mock the IPC connection creation
	process.createIPCConnection = () => {
		process.ipcConn = mockConn;
	};

	// Mock waitForInitialConfig to avoid actual IPC
	process.waitForInitialConfig = async () => {
		process.config = new Configuration();
	};

	// Start the process (will call startMonitoring)
	const startPromise = process.start();

	// Wait a bit for setup
	await new Promise(resolve => setTimeout(resolve, 50));

	// Verify monitoring was started
	assertEquals(mockConn.monitoring, true);

	// Cleanup - close connection to exit monitoring
	await mockConn.close();
	await startPromise;
});

Deno.test('ServiceProcess - subclass must implement handleConfigUpdate', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () {
			super('incomplete', 'test-123');
		}
	}

	const process = new IncompleteProcess();
	await assertRejects(
		() => process.handleConfigUpdate(new NANOS()),
		Error,
		'Subclass must implement handleConfigUpdate()'
	);
});

Deno.test('ServiceProcess - subclass must implement handleHealthCheck', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () {
			super('incomplete', 'test-123');
		}
	}

	const process = new IncompleteProcess();
	await assertRejects(
		() => process.handleHealthCheck('id', new NANOS()),
		Error,
		'Subclass must implement handleHealthCheck()'
	);
});

Deno.test('ServiceProcess - subclass must implement handleShutdown', async () => {
	class IncompleteProcess extends ServiceProcess {
		constructor () {
			super('incomplete', 'test-123');
		}
	}

	const process = new IncompleteProcess();
	await assertRejects(
		() => process.handleShutdown(new NANOS()),
		Error,
		'Subclass must implement handleShutdown()'
	);
});

Deno.test('ServiceProcess - onStarted hook is called', async () => {
	const process = new MockServiceProcess('test-123');
	await process.onStarted();
	assertEquals(process.onStartedCalled, true);
});
