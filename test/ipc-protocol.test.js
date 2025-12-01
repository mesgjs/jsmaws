/**
 * JSMAWS IPC Protocol Tests (SOH-based)
 * Tests the SOH-prefixed IPC protocol with console interception
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '../src/vendor.esm.js';
import {
	encodeMessage,
	encodeLogLevel,
	parseIPCMessage,
	parseLogMessage,
	IPCConnection,
	createMessage,
	MessageType,
} from '../src/ipc-protocol.esm.js';

// Mock connection for testing
class MockConnection {
	constructor () {
		this.writeBuffer = [];
		this.readQueue = [];
		this.readIndex = 0;
		this.closed = false;
	}

	async read () {
		if (this.readIndex >= this.readQueue.length) {
			// If we've read all queued data and connection is closed, return done
			if (this.closed) {
				return { done: true, value: undefined };
			}
			// Otherwise wait for more data (simulate blocking read)
			// In tests, we should close() after queueing all data
			await new Promise(resolve => setTimeout(resolve, 10));
			return this.read(); // Try again
		}
		const value = this.readQueue[this.readIndex++];
		return { done: false, value };
	}

	async write (data) {
		this.writeBuffer.push(data);
	}

	async close () {
		this.closed = true;
	}

	// Helper to add data to read queue
	queueRead (data) {
		if (typeof data === 'string') {
			this.readQueue.push(new TextEncoder().encode(data));
		} else {
			this.readQueue.push(data);
		}
	}

	// Helper to get all written data as string
	getWrittenText () {
		const combined = new Uint8Array(
			this.writeBuffer.reduce((sum, buf) => sum + buf.length, 0)
		);
		let offset = 0;
		for (const buf of this.writeBuffer) {
			combined.set(buf, offset);
			offset += buf.length;
		}
		return new TextDecoder().decode(combined);
	}
}

Deno.test('encodeMessage - simple message without binary data', () => {
	const message = createMessage({ type: 'TEST', id: '123' }, { foo: 'bar' });
	const encoded = encodeMessage(message);
	const text = new TextDecoder().decode(encoded);

	// Should start with SOH
	assertEquals(text.charCodeAt(0), 1);
	// Should contain SLID boundary markers
	assertEquals(text.includes('[('), true);
	assertEquals(text.includes(')]'), true);
	// Should end with newline
	assertEquals(text.endsWith('\n'), true);
});

Deno.test('encodeMessage - message with binary data', () => {
	const message = createMessage({ type: 'TEST', id: '123' }, { foo: 'bar' });
	const binaryData = new TextEncoder().encode('Hello, World!');
	const encoded = encodeMessage(message, binaryData);

	// Should include dataSize in message
	const text = new TextDecoder().decode(encoded);
	assertEquals(text.includes('dataSize'), true);

	// Binary data should be appended after newline
	const newlineIndex = text.indexOf('\n');
	const binaryStart = new TextEncoder().encode(text.substring(0, newlineIndex + 1)).length;
	const extractedBinary = encoded.slice(binaryStart);
	assertEquals(extractedBinary, binaryData);
});

Deno.test('encodeLogLevel - creates proper log prefix', () => {
	const levels = ['debug', 'info', 'log', 'warn', 'error'];

	for (const level of levels) {
		const encoded = encodeLogLevel(level);
		const text = new TextDecoder().decode(encoded);

		// Should start with SOH
		assertEquals(text.charCodeAt(0), 1);
		// Should contain log message
		assertEquals(text.includes('[(log '), true);
		assertEquals(text.includes(level), true);
		// Should end with newline
		assertEquals(text.endsWith('\n'), true);
	}
});

Deno.test('parseIPCMessage - valid message', () => {
	const message = createMessage({ type: 'TEST', id: '123' }, { foo: 'bar', num: 42 });
	const encoded = encodeMessage(message);
	const text = new TextDecoder().decode(encoded).trim();

	const parsed = parseIPCMessage(text);
	assertExists(parsed);
	assertEquals(parsed.type, 'TEST');
	assertEquals(parsed.id, '123');
	assertEquals(parsed.fields.at('foo'), 'bar');
	assertEquals(parsed.fields.at('num'), 42);
	assertEquals(parsed.dataSize, 0);
});

Deno.test('parseIPCMessage - message with dataSize', () => {
	const message = createMessage({ type: 'TEST', id: '123' }, { foo: 'bar' });
	const binaryData = new Uint8Array(100);
	const encoded = encodeMessage(message, binaryData);
	const text = new TextDecoder().decode(encoded).split('\n')[0];

	const parsed = parseIPCMessage(text);
	assertExists(parsed);
	assertEquals(parsed.dataSize, 100);
});

Deno.test('parseIPCMessage - non-IPC line returns null', () => {
	const result = parseIPCMessage('This is just a regular console line');
	assertEquals(result, null);
});

Deno.test('parseLogMessage - valid log levels', () => {
	const levels = ['debug', 'info', 'log', 'warn', 'error'];

	for (const level of levels) {
		const encoded = encodeLogLevel(level);
		const text = new TextDecoder().decode(encoded).trim();
		const parsed = parseLogMessage(text);
		assertEquals(parsed, level);
	}
});

Deno.test('parseLogMessage - non-log line returns null', () => {
	const result = parseLogMessage('Regular console output');
	assertEquals(result, null);
});

Deno.test('IPCConnection - read simple message', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Queue a simple message
	const message = createMessage({ type: 'PING', id: '1' }, { timestamp: 12345 });
	const encoded = encodeMessage(message);
	conn.queueRead(encoded);

	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'PING');
	assertEquals(result.message.id, '1');
	assertEquals(result.message.fields.at('timestamp'), 12345);
	assertEquals(result.binaryData, null);
});

Deno.test('IPCConnection - read message with binary data', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Queue a message with binary data
	const message = createMessage({ type: 'DATA', id: '2' }, { size: 13 });
	const binaryData = new TextEncoder().encode('Hello, World!');
	const encoded = encodeMessage(message, binaryData);
	conn.queueRead(encoded);
	conn.close(); // Signal no more data coming

	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'DATA');
	assertEquals(new TextDecoder().decode(result.binaryData), 'Hello, World!');
});

Deno.test('IPCConnection - read message split across multiple chunks', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Create a message and split it across multiple reads
	const message = createMessage({ type: 'SPLIT', id: '3' }, { test: 'value', bigger: 'K'.repeat(1024) });
	const encoded = encodeMessage(message);

	// Split the encoded message into 3 chunks
	const chunk1 = encoded.slice(0, 200);
	const chunk2 = encoded.slice(200, 400);
	const chunk3 = encoded.slice(400);

	conn.queueRead(chunk1);
	conn.queueRead(chunk2);
	conn.queueRead(chunk3);

	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'SPLIT');
	assertEquals(result.message.id, '3');
	assertEquals(result.message.fields.at('test'), 'value');
	assertEquals(result.message.fields.at('bigger').length, 1024);
});

Deno.test('IPCConnection - read message with binary data split across chunks', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Create message with binary data
	const message = createMessage({ type: 'BINARY', id: '4' }, {});
	const binaryData = new TextEncoder().encode('This is a longer binary payload for testing');
	const encoded = encodeMessage(message, binaryData);

	// Split so that binary data spans multiple chunks
	const textPart = new TextDecoder().decode(encoded).indexOf('\n') + 1;
	const textBytes = new TextEncoder().encode(new TextDecoder().decode(encoded).substring(0, textPart));
	
	conn.queueRead(textBytes);
	conn.queueRead(encoded.slice(textBytes.length, textBytes.length + 10));
	conn.queueRead(encoded.slice(textBytes.length + 10));

	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'BINARY');
	assertEquals(result.binaryData, binaryData);
});

Deno.test('IPCConnection - skip log level messages', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Queue log level prefix followed by IPC message
	conn.queueRead(encodeLogLevel('debug'));
	const message = createMessage({ type: 'AFTER_LOG', id: '5' }, { value: 123 });
	conn.queueRead(encodeMessage(message));

	// Should skip log level and return the IPC message
	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'AFTER_LOG');
	assertEquals(result.message.fields.at('value'), 123);
});

Deno.test('IPCConnection - handle multiple messages in sequence', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Queue multiple messages
	const msg1 = createMessage({ type: 'MSG1', id: '1' }, { a: 1 });
	const msg2 = createMessage({ type: 'MSG2', id: '2' }, { b: 2 });
	const msg3 = createMessage({ type: 'MSG3', id: '3' }, { c: 3 });

	conn.queueRead(encodeMessage(msg1));
	conn.queueRead(encodeMessage(msg2));
	conn.queueRead(encodeMessage(msg3));

	const result1 = await ipcConn.readMessage();
	assertEquals(result1.message.type, 'MSG1');

	const result2 = await ipcConn.readMessage();
	assertEquals(result2.message.type, 'MSG2');

	const result3 = await ipcConn.readMessage();
	assertEquals(result3.message.type, 'MSG3');
});

Deno.test('IPCConnection - write message', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	const message = createMessage({ type: 'WRITE_TEST', id: '6' }, { data: 'test' });
	await ipcConn.writeMessage(message);

	const written = conn.getWrittenText();
	assertEquals(written.charCodeAt(0), 1); // SOH
	assertEquals(written.includes('WRITE_TEST'), true);
	assertEquals(written.includes('data'), true);
});

Deno.test('IPCConnection - write message with binary data', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	const message = createMessage({ type: 'WRITE_BINARY', id: '7' }, {});
	const binaryData = new TextEncoder().encode('Binary payload');
	await ipcConn.writeMessage(message, binaryData);

	const written = conn.writeBuffer[0];
	const text = new TextDecoder().decode(written);
	
	assertEquals(text.charCodeAt(0), 1); // SOH
	assertEquals(text.includes('dataSize'), true);
	
	// Verify binary data is appended
	const newlineIndex = text.indexOf('\n');
	const textBytes = new TextEncoder().encode(text.substring(0, newlineIndex + 1));
	const extractedBinary = written.slice(textBytes.length);
	assertEquals(extractedBinary, binaryData);
});

Deno.test('IPCConnection - handle console output with embedded newlines', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Simulate console output with multiple lines, then an IPC message
	conn.queueRead(encodeLogLevel('log'));
	conn.queueRead(new TextEncoder().encode('Line 1\nLine 2\nLine 3\n'));
	
	const message = createMessage({ type: 'AFTER_CONSOLE', id: '8' }, { test: true });
	conn.queueRead(encodeMessage(message));

	// Should skip console output and return IPC message
	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'AFTER_CONSOLE');
});

Deno.test('IPCConnection - handle interleaved log levels and console output', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Simulate realistic pattern: log level, console output, log level, console output, IPC message
	conn.queueRead(encodeLogLevel('debug'));
	conn.queueRead(new TextEncoder().encode('Debug message\n'));
	conn.queueRead(encodeLogLevel('info'));
	conn.queueRead(new TextEncoder().encode('Info message\n'));
	
	const message = createMessage({ type: 'FINAL', id: '9' }, { done: true });
	conn.queueRead(encodeMessage(message));

	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'FINAL');
	assertEquals(result.message.fields.at('done'), true);
});

Deno.test('Message type constants are defined', () => {
	assertEquals(typeof MessageType.ROUTE_REQUEST, 'string');
	assertEquals(typeof MessageType.ROUTE_RESPONSE, 'string');
	assertEquals(typeof MessageType.WEB_REQUEST, 'string');
	assertEquals(typeof MessageType.WEB_FRAME, 'string');
	assertEquals(typeof MessageType.WEB_ERROR, 'string');
	assertEquals(typeof MessageType.CONFIG_UPDATE, 'string');
	assertEquals(typeof MessageType.SHUTDOWN, 'string');
	assertEquals(typeof MessageType.HEALTH_CHECK, 'string');
});

Deno.test('createMessage - creates valid NANOS structure', () => {
	const message = createMessage({ type: 'TEST', id: 'test-123' }, { foo: 'bar', num: 42 });
	
	assertEquals(message instanceof NANOS, true);
	assertEquals(message.at(0), 'TEST');
	assertEquals(message.at('id'), 'test-123');
	
	const fields = message.at(1);
	assertEquals(fields instanceof NANOS, true);
	assertEquals(fields.at('foo'), 'bar');
	assertEquals(fields.at('num'), 42);
});

Deno.test('IPCConnection - connection closed returns null', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Don't queue any data - close connection immediately
	conn.close();
	
	const result = await ipcConn.readMessage();
	assertEquals(result, null);
});

Deno.test('IPCConnection - handles very large binary data', async () => {
	const conn = new MockConnection();
	const ipcConn = new IPCConnection(conn);

	// Create large binary payload (100KB to keep test fast)
	const largeData = new Uint8Array(100 * 1024);
	for (let i = 0; i < largeData.length; i++) {
		largeData[i] = i % 256;
	}

	const message = createMessage({ type: 'LARGE', id: '10' }, {});
	const encoded = encodeMessage(message, largeData);

	// Split into multiple chunks to test chunked reading
	const chunkSize = 8192;
	for (let i = 0; i < encoded.length; i += chunkSize) {
		const end = Math.min(i + chunkSize, encoded.length);
		conn.queueRead(encoded.slice(i, end));
	}
	conn.close(); // Signal no more data coming

	const result = await ipcConn.readMessage();
	assertExists(result);
	assertEquals(result.message.type, 'LARGE');
	assertEquals(result.binaryData.length, largeData.length);
	
	// Verify data integrity
	for (let i = 0; i < largeData.length; i++) {
		if (result.binaryData[i] !== largeData[i]) {
			throw new Error(`Data mismatch at byte ${i}: expected ${largeData[i]}, got ${result.binaryData[i]}`);
		}
	}
});
