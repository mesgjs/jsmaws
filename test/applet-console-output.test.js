/**
 * Applet Console Output Tests
 * Tests for console output IPC message encoding/decoding round-trip
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createAppletOutput, encodeMessage, MessageType } from '../src/ipc-protocol.esm.js';
import { IPCConnection } from '../src/ipc-protocol.esm.js';

/**
 * Helper to decode a message (simulates IPC event loop)
 */
async function decodeMessage (encoded) {
	// Create a mock connection that reads from the encoded buffer
	let buffer = encoded;
	let offset = 0;

	const conn = new IPCConnection({
		read: async () => {
			if (offset >= buffer.length) {
				return { done: true, value: null };
			}
			// Return chunks to simulate streaming
			const chunkSize = Math.min(1024, buffer.length - offset);
			const chunk = buffer.slice(offset, offset + chunkSize);
			offset += chunkSize;
			return { done: false, value: chunk };
		},
		write: () => { throw new Error('Not implemented'); },
		close: async () => {}
	});

	const message = await conn.readMessage();
	message.content = message.binaryData?.length ? new TextDecoder().decode(message.binaryData) : '';
	return message;
}

/**
 * Helper to generate encoded applet output messages with binary data
 */
function encodeAppletOutput (id, level, content) {
	const message = createAppletOutput(id, { level });
	const binaryData = new TextEncoder().encode(content);
	const encoded = encodeMessage(message, binaryData);
	return encoded;
}

Deno.test('Console output - round-trip with log level', async () => {
	const content = 'test message';
	const encoded = encodeAppletOutput('req-123', 'log', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.message.type, MessageType.APPLET_OUTPUT);
	assertEquals(result.message.id, 'req-123');
	assertEquals(result.message.fields.at('level'), 'log');
	assertEquals(result.content, content);
});

Deno.test('Console output - round-trip with error level', async () => {
	const content = 'error message';
	const encoded = encodeAppletOutput('req-456', 'error', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.message.fields.at('level'), 'error');
	assertEquals(result.content, content);
});

Deno.test('Console output - round-trip with multi-line content', async () => {
	const content = 'line 1\nline 2\nline 3';
	const encoded = encodeAppletOutput('req-789', 'log', content);
	const result = await decodeMessage(encoded);

	const decoded = result.content;
	assertEquals(decoded, content);
	assert(decoded.includes('\n'));
});

Deno.test('Console output - round-trip with Unicode content', async () => {
	const content = 'Unicode: 你好 🎉 Ñoño';
	const encoded = encodeAppletOutput('req-unicode', 'info', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.content, content);
});

Deno.test('Console output - round-trip with empty content', async () => {
	const content = '';
	const encoded = encodeAppletOutput('req-empty', 'log', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.content, '');
});

Deno.test('Console output - round-trip with large content', async () => {
	const content = 'x'.repeat(100000);
	const encoded = encodeAppletOutput('req-large', 'warn', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.binaryData.length, 100000);
	assertEquals(result.content, content);
});

Deno.test('Console output - round-trip with special characters', async () => {
	const content = 'Special: \t\r\n"quotes" \'apostrophes\' \\backslash';
	const encoded = encodeAppletOutput('req-special', 'debug', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.content, content);
});

Deno.test('Console output - all log levels round-trip correctly', async () => {
	const levels = ['debug', 'info', 'log', 'warn', 'error'];

	for (const level of levels) {
		const content = `${level} message`;
		const encoded = encodeAppletOutput(`req-${level}`, level, content);
		const result = await decodeMessage(encoded);

		assertEquals(result.message.fields.at('level'), level);
		assertEquals(result.content, content);
	}
});

Deno.test('Console output - preserves exact byte count', async () => {
	const content = 'test content with exact bytes';
	const originalLength = new TextEncoder().encode(content).length;

	const encoded = encodeAppletOutput('req-bytes', 'log', content);
	const result = await decodeMessage(encoded);

	assertEquals(result.binaryData.length, originalLength);
});

Deno.test('Console output - handles content with SLID special chars', async () => {
	const content = 'SLID chars: [( )] = " \' \\';
	const encoded = encodeAppletOutput('req-slid-chars', 'log', content);
	const result = await decodeMessage(encoded);

	// Content should be preserved exactly in binary data
	assertEquals(result.content, content);
});
