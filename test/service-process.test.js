/**
 * Tests for ServiceProcess base class
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '../src/vendor.esm.js';
import { ServiceProcess } from '../src/service-process.esm.js';
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
	}

	async handleConfigUpdate (fields) {
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
 * Mock IPC connection for testing
 */
class MockIPCConnection {
	constructor () {
		this.messages = [];
		this.readIndex = 0;
		this.writtenMessages = [];
		this.closed = false;
	}

	addMessage (type, id, fields) {
		// Store in the format that readMessage returns: { message: { type, id, fields }, binaryData }
		this.messages.push({
			message: { type, id, fields },
			binaryData: null
		});
	}

	async readMessage () {
		if (this.readIndex >= this.messages.length) {
			return null;
		}
		return this.messages[this.readIndex++];
	}

	async writeMessage (message, binaryData = null) {
		this.writtenMessages.push({ message, binaryData });
	}

	async close () {
		this.closed = true;
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

Deno.test('ServiceProcess - processMessages handles CONFIG_UPDATE', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	
	// Add config update message - fields should be a NANOS with the data
	const fields = new NANOS({ test: 'value' });
	mockConn.addMessage(MessageType.CONFIG_UPDATE, 'cfg-1', fields);
	
	process.ipcConn = mockConn;
	
	// Process one message
	const processPromise = process.processMessages();
	
	// Wait a bit for message processing
	await new Promise(resolve => setTimeout(resolve, 100));
	
	// Trigger shutdown to exit loop
	process.isShuttingDown = true;
	await processPromise;
	
	assertEquals(process.configUpdateCalled, true);
	assertEquals(process.config.at('test'), 'value');
});

Deno.test('ServiceProcess - processMessages handles HEALTH_CHECK', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	
	// Add health check message
	const fields = new NANOS();
	fields.setOpts({ transform: true });
	fields.push([{ timestamp: Date.now() }]);
	mockConn.addMessage(MessageType.HEALTH_CHECK, 'hc-1', fields);
	
	process.ipcConn = mockConn;
	
	// Process one message
	const processPromise = process.processMessages();
	
	// Wait a bit for message processing
	await new Promise(resolve => setTimeout(resolve, 100));
	
	// Trigger shutdown to exit loop
	process.isShuttingDown = true;
	await processPromise;
	
	assertEquals(process.healthCheckCalled, true);
	assertEquals(mockConn.writtenMessages.length, 1);
	assertEquals(mockConn.writtenMessages[0].message.at(0), MessageType.HEALTH_CHECK);
});

Deno.test('ServiceProcess - processMessages handles SHUTDOWN', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	
	// Add shutdown message
	const fields = new NANOS();
	fields.setOpts({ transform: true });
	fields.push([{ timeout: 30 }]);
	mockConn.addMessage(MessageType.SHUTDOWN, 'halt-1', fields);
	
	process.ipcConn = mockConn;
	
	// Process messages
	await process.processMessages();
	
	assertEquals(process.shutdownCalled, true);
	assertEquals(process.isShuttingDown, true);
	assertEquals(mockConn.closed, true);
});

Deno.test('ServiceProcess - processMessages handles unknown message type', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	
	// Add unknown message type
	const fields = new NANOS();
	mockConn.addMessage('UNKNOWN_TYPE', 'unk-1', fields);
	
	process.ipcConn = mockConn;
	
	// Process one message
	const processPromise = process.processMessages();
	
	// Wait a bit for message processing
	await new Promise(resolve => setTimeout(resolve, 100));
	
	// Trigger shutdown to exit loop
	process.isShuttingDown = true;
	await processPromise;
	
	// Should not crash, just log warning
	assertEquals(process.configUpdateCalled, false);
	assertEquals(process.healthCheckCalled, false);
	assertEquals(process.shutdownCalled, false);
});

Deno.test('ServiceProcess - processMessages exits on connection close', async () => {
	const process = new MockServiceProcess('test-123');
	const mockConn = new MockIPCConnection();
	
	// No messages - readMessage will return null
	process.ipcConn = mockConn;
	
	// Process messages - should exit immediately
	await process.processMessages();
	
	// Should exit cleanly without calling handlers
	assertEquals(process.configUpdateCalled, false);
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
