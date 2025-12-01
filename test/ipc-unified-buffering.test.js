/**
 * Tests for unified buffering in IPCConnection
 * Tests SLID-boundary-aware parsing, multi-line support, and console output handling
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { IPCConnection, encodeMessage, encodeLogLevel, createMessage } from '../src/ipc-protocol.esm.js';
import { NANOS } from '../src/vendor.esm.js';

/**
 * Create a mock connection for testing
 */
function createMockConnection(chunks) {
	let chunkIndex = 0;
	const reads = [];
	
	return {
		conn: {
			read: () => {
				if (chunkIndex >= chunks.length) {
					return { done: true, value: null };
				}
				const chunk = chunks[chunkIndex++];
				reads.push(chunk);
				return { done: false, value: chunk };
			},
			write: (data) => {
				// Mock write
			},
			close: () => {
				// Mock close
			}
		},
		reads
	};
}

/**
 * Test: IPC message split across multiple reads
 */
Deno.test('IPCConnection - IPC message split across reads', async () => {
	const message = createMessage({ type: 'TEST', id: 'test-1' }, { field1: 'value1' });
	const encoded = encodeMessage(message);
	
	// Split message into two chunks
	const mid = Math.floor(encoded.length / 2);
	const chunk1 = encoded.slice(0, mid);
	const chunk2 = encoded.slice(mid);
	
	const { conn } = createMockConnection([chunk1, chunk2]);
	const ipcConn = new IPCConnection(conn);
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(result.message.id, 'test-1');
	assertEquals(result.message.fields.at('field1'), 'value1');
	assertEquals(result.binaryData, null);
});

/**
 * Test: Binary data split across multiple reads
 */
Deno.test('IPCConnection - Binary data split across reads', async () => {
	const binaryData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const message = createMessage({ type: 'TEST', id: 'test-2' }, { field1: 'value1' });
	const encoded = encodeMessage(message, binaryData);
	
	// Split into three chunks: SLID, first half of binary, second half of binary
	const slidEnd = encoded.length - binaryData.length;
	const binaryMid = slidEnd + Math.floor(binaryData.length / 2);
	
	const chunk1 = encoded.slice(0, slidEnd);
	const chunk2 = encoded.slice(slidEnd, binaryMid);
	const chunk3 = encoded.slice(binaryMid);
	
	const { conn } = createMockConnection([chunk1, chunk2, chunk3]);
	const ipcConn = new IPCConnection(conn);
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(result.binaryData.length, 8);
	assertEquals(Array.from(result.binaryData), [1, 2, 3, 4, 5, 6, 7, 8]);
});

/**
 * Test: Partial UTF-8 sequence at read boundary
 */
Deno.test('IPCConnection - Partial UTF-8 at boundary', async () => {
	// Create message with emoji (multi-byte UTF-8)
	const message = createMessage({ type: 'TEST', id: 'test-3' }, { emoji: '🚀' });
	const encoded = encodeMessage(message);
	
	// Find the emoji bytes and split in the middle of it
	const text = new TextDecoder().decode(encoded);
	const emojiIndex = text.indexOf('🚀');
	const emojiByteStart = new TextEncoder().encode(text.substring(0, emojiIndex)).length;
	
	// Split in middle of emoji (4-byte UTF-8 sequence)
	const splitPoint = emojiByteStart + 2;
	const chunk1 = encoded.slice(0, splitPoint);
	const chunk2 = encoded.slice(splitPoint);
	
	const { conn } = createMockConnection([chunk1, chunk2]);
	const ipcConn = new IPCConnection(conn);
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(result.message.fields.at('emoji'), '🚀');
});

/**
 * Test: Log message + IPC message in single read
 */
Deno.test('IPCConnection - Log message + IPC message in single read', async () => {
	const logPrefix = encodeLogLevel('info');
	const consoleOutput = new TextEncoder().encode('This is console output\n');
	const message = createMessage({ type: 'TEST', id: 'test-4' }, { field1: 'value1' });
	const ipcEncoded = encodeMessage(message);
	
	// Combine log prefix + console output + IPC message
	const combined = new Uint8Array(logPrefix.length + consoleOutput.length + ipcEncoded.length);
	combined.set(logPrefix, 0);
	combined.set(consoleOutput, logPrefix.length);
	combined.set(ipcEncoded, logPrefix.length + consoleOutput.length);
	
	const { conn } = createMockConnection([combined]);
	const ipcConn = new IPCConnection(conn);
	
	// Track console output
	let capturedText = '';
	let capturedLevel = '';
	ipcConn.setConsoleOutputHandler((text, level) => {
		capturedText = text;
		capturedLevel = level;
	});
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(capturedText.trim(), 'This is console output');
	assertEquals(capturedLevel, 'info');
});

/**
 * Test: Multi-line SLID block
 */
Deno.test('IPCConnection - Multi-line SLID block', async () => {
	// Create a SLID message with nested structure (will span multiple lines)
	const message = new NANOS('TEST', { id: 'test-5' });
	message.setOpts({ transform: true });
	message.push([{
		field1: 'value1',
		field2: 'value2',
		nested: {
			subfield1: 'subvalue1',
			subfield2: 'subvalue2'
		}
	}]);
	
	const encoded = encodeMessage(message);
	
	const { conn } = createMockConnection([encoded]);
	const ipcConn = new IPCConnection(conn);
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(result.message.id, 'test-5');
	assertEquals(result.message.fields.at('field1'), 'value1');
});

/**
 * Test: Multi-line console output
 */
Deno.test('IPCConnection - Multi-line console output', async () => {
	const logPrefix = encodeLogLevel('log');
	const consoleOutput = new TextEncoder().encode('Line 1\nLine 2\nLine 3\n');
	const message = createMessage({ type: 'TEST', id: 'test-6' }, {});
	const ipcEncoded = encodeMessage(message);
	
	// Combine log prefix + multi-line console output + IPC message
	const combined = new Uint8Array(logPrefix.length + consoleOutput.length + ipcEncoded.length);
	combined.set(logPrefix, 0);
	combined.set(consoleOutput, logPrefix.length);
	combined.set(ipcEncoded, logPrefix.length + consoleOutput.length);
	
	const { conn } = createMockConnection([combined]);
	const ipcConn = new IPCConnection(conn);
	
	// Track console output
	let capturedText = '';
	ipcConn.setConsoleOutputHandler((text, level) => {
		capturedText += text + '\n';
	});
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(capturedText.trim(), 'Line 1\nLine 2\nLine 3');
});

/**
 * Test: IPC message + partial binary + rest of binary in separate reads
 */
Deno.test('IPCConnection - IPC + partial binary + rest in separate reads', async () => {
	const binaryData = new Uint8Array(100).fill(42); // 100 bytes of 42
	const message = createMessage({ type: 'TEST', id: 'test-7' }, { field1: 'value1' });
	const encoded = encodeMessage(message, binaryData);
	
	// Split into: SLID complete, first 30 bytes of binary, rest of binary
	const slidEnd = encoded.length - binaryData.length;
	const chunk1 = encoded.slice(0, slidEnd);
	const chunk2 = encoded.slice(slidEnd, slidEnd + 30);
	const chunk3 = encoded.slice(slidEnd + 30);
	
	const { conn } = createMockConnection([chunk1, chunk2, chunk3]);
	const ipcConn = new IPCConnection(conn);
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(result.binaryData.length, 100);
	assertEquals(result.binaryData[0], 42);
	assertEquals(result.binaryData[99], 42);
});

/**
 * Test: Log level persistence across messages
 */
Deno.test('IPCConnection - Log level persistence', async () => {
	const logPrefix1 = encodeLogLevel('warn');
	const console1 = new TextEncoder().encode('Warning message\n');
	const message1 = createMessage({ type: 'TEST', id: 'test-8a' }, {});
	const ipc1 = encodeMessage(message1);
	
	// Second console output without log level prefix (should use previous level)
	const console2 = new TextEncoder().encode('Another warning\n');
	const message2 = createMessage({ type: 'TEST', id: 'test-8b' }, {});
	const ipc2 = encodeMessage(message2);
	
	// Combine: log prefix + console1 + ipc1 + console2 + ipc2
	const combined = new Uint8Array(
		logPrefix1.length + console1.length + ipc1.length + 
		console2.length + ipc2.length
	);
	let offset = 0;
	combined.set(logPrefix1, offset); offset += logPrefix1.length;
	combined.set(console1, offset); offset += console1.length;
	combined.set(ipc1, offset); offset += ipc1.length;
	combined.set(console2, offset); offset += console2.length;
	combined.set(ipc2, offset);
	
	const { conn } = createMockConnection([combined]);
	const ipcConn = new IPCConnection(conn);
	
	// Track console output
	const outputs = [];
	ipcConn.setConsoleOutputHandler((text, level) => {
		outputs.push({ text: text.trim(), level });
	});
	
	// Read first message
	const result1 = await ipcConn.readMessage();
	assertEquals(result1.message.id, 'test-8a');
	assertEquals(outputs[0].text, 'Warning message');
	assertEquals(outputs[0].level, 'warn');
	
	// Read second message (should still use 'warn' level)
	const result2 = await ipcConn.readMessage();
	assertEquals(result2.message.id, 'test-8b');
	assertEquals(outputs[1].text, 'Another warning');
	assertEquals(outputs[1].level, 'warn'); // Persisted from previous
});

/**
 * Test: Empty console output (whitespace only)
 */
Deno.test('IPCConnection - Empty console output ignored', async () => {
	const logPrefix = encodeLogLevel('info');
	const whitespace = new TextEncoder().encode('   \n\t\n  \n');
	const message = createMessage({ type: 'TEST', id: 'test-9' }, {});
	const ipcEncoded = encodeMessage(message);
	
	const combined = new Uint8Array(logPrefix.length + whitespace.length + ipcEncoded.length);
	combined.set(logPrefix, 0);
	combined.set(whitespace, logPrefix.length);
	combined.set(ipcEncoded, logPrefix.length + whitespace.length);
	
	const { conn } = createMockConnection([combined]);
	const ipcConn = new IPCConnection(conn);
	
	// Track console output
	let callCount = 0;
	ipcConn.setConsoleOutputHandler(() => {
		callCount++;
	});
	
	const result = await ipcConn.readMessage();
	
	assertExists(result);
	assertEquals(result.message.type, 'TEST');
	assertEquals(callCount, 0); // Whitespace-only output should be ignored
});

/**
 * Test: Multiple messages in single read
 */
Deno.test('IPCConnection - Multiple messages in single read', async () => {
	const message1 = createMessage({ type: 'TEST', id: 'test-10a' }, { seq: 1 });
	const message2 = createMessage({ type: 'TEST', id: 'test-10b' }, { seq: 2 });
	const encoded1 = encodeMessage(message1);
	const encoded2 = encodeMessage(message2);
	
	const combined = new Uint8Array(encoded1.length + encoded2.length);
	combined.set(encoded1, 0);
	combined.set(encoded2, encoded1.length);
	
	const { conn } = createMockConnection([combined]);
	const ipcConn = new IPCConnection(conn);
	
	// Read first message
	const result1 = await ipcConn.readMessage();
	assertEquals(result1.message.id, 'test-10a');
	assertEquals(result1.message.fields.at('seq'), 1);
	
	// Read second message (from same buffer)
	const result2 = await ipcConn.readMessage();
	assertEquals(result2.message.id, 'test-10b');
	assertEquals(result2.message.fields.at('seq'), 2);
});
