/**
 * Frame Protocol Tests
 * Tests for the unified frame-based protocol
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { createFrame, createError, MessageType } from '../src/ipc-protocol.esm.js';

Deno.test('createFrame - first frame with mode, status, headers', () => {
	const frame = createFrame('req-123', {
		mode: 'response',
		status: 200,
		headers: { 'Content-Type': 'text/html' },
		data: new Uint8Array([1, 2, 3]),
		final: false,
		keepAlive: false
	});
	
	assertEquals(frame.at(0), MessageType.WEB_FRAME);
	assertEquals(frame.at('id'), 'req-123');
	
	const fields = frame.at(1);
	assertEquals(fields.at('mode'), 'response');
	assertEquals(fields.at('status'), 200);
	assertExists(fields.at('headers'));
	assertEquals(fields.at('dataSize'), 3);
	assertEquals(fields.at('final'), false);
	assertEquals(fields.at('keepAlive'), false);
});

Deno.test('createFrame - subsequent frame without mode/status/headers', () => {
	const frame = createFrame('req-123', {
		data: new Uint8Array([4, 5, 6]),
		final: false
	});
	
	assertEquals(frame.at(0), MessageType.WEB_FRAME);
	assertEquals(frame.at('id'), 'req-123');
	
	const fields = frame.at(1);
	assertEquals(fields.at('mode'), undefined);
	assertEquals(fields.at('status'), undefined);
	assertEquals(fields.at('headers'), undefined);
	assertEquals(fields.at('dataSize'), 3);
	assertEquals(fields.at('final'), false);
	assertEquals(fields.at('keepAlive'), undefined);
});

Deno.test('createFrame - final frame with keepAlive change', () => {
	const frame = createFrame('req-123', {
		data: new Uint8Array([7, 8, 9]),
		final: true,
		keepAlive: false
	});
	
	const fields = frame.at(1);
	assertEquals(fields.at('final'), true);
	assertEquals(fields.at('keepAlive'), false);
});

Deno.test('createFrame - bidi mode with protocol parameters', () => {
	const frame = createFrame('conn-456', {
		mode: 'bidi',
		status: 101,
		headers: { 'Upgrade': 'websocket' },
		data: null,
		final: false,
		keepAlive: true
	});
	
	const fields = frame.at(1);
	assertEquals(fields.at('mode'), 'bidi');
	assertEquals(fields.at('status'), 101);
	assertEquals(fields.at('keepAlive'), true);
	assertEquals(fields.at('dataSize'), 0);
});

Deno.test('createFrame - protocol parameters frame', () => {
	const frame = createFrame('conn-456', {
		final: false,
		keepAlive: true,
		initialCredits: 655360,
		maxChunkSize: 65536,
		maxBytesPerSecond: 10485760,
		idleTimeout: 60,
		maxBufferSize: 1048576
	});
	
	const fields = frame.at(1);
	assertEquals(fields.at('initialCredits'), 655360);
	assertEquals(fields.at('maxChunkSize'), 65536);
	assertEquals(fields.at('maxBytesPerSecond'), 10485760);
	assertEquals(fields.at('idleTimeout'), 60);
	assertEquals(fields.at('maxBufferSize'), 1048576);
});

Deno.test('createFrame - stream mode first frame', () => {
	const frame = createFrame('stream-789', {
		mode: 'stream',
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
		data: null,
		final: false,
		keepAlive: true
	});
	
	const fields = frame.at(1);
	assertEquals(fields.at('mode'), 'stream');
	assertEquals(fields.at('keepAlive'), true);
	assertEquals(fields.at('dataSize'), 0);
});

Deno.test('createFrame - null data with final true', () => {
	const frame = createFrame('req-123', {
		data: null,
		final: true
	});
	
	const fields = frame.at(1);
	assertEquals(fields.at('dataSize'), 0);
	assertEquals(fields.at('final'), true);
});

Deno.test('createError - basic error message', () => {
	const error = createError('req-123', 500, 'Internal Server Error');
	
	assertEquals(error.at(0), MessageType.WEB_ERROR);
	assertEquals(error.at('id'), 'req-123');
	
	const fields = error.at(1);
	assertEquals(fields.at('status'), 500);
	assertEquals(fields.at('message'), 'Internal Server Error');
	assertEquals(fields.at('details'), undefined);
});

Deno.test('createError - error with details', () => {
	const error = createError('req-123', 404, 'Not Found', 'File does not exist');
	
	const fields = error.at(1);
	assertEquals(fields.at('status'), 404);
	assertEquals(fields.at('message'), 'Not Found');
	assertEquals(fields.at('details'), 'File does not exist');
});

Deno.test('createFrame - options object defaults', () => {
	const frame = createFrame('req-123', {});
	
	const fields = frame.at(1);
	assertEquals(fields.at('dataSize'), 0);
	assertEquals(fields.at('final'), false);
	assertEquals(fields.at('mode'), undefined);
	assertEquals(fields.at('keepAlive'), undefined);
});

Deno.test('createFrame - large data chunk', () => {
	const largeData = new Uint8Array(65536); // 64KB
	largeData.fill(42);
	
	const frame = createFrame('req-123', {
		data: largeData,
		final: true
	});
	
	const fields = frame.at(1);
	assertEquals(fields.at('dataSize'), 65536);
	assertEquals(fields.at('final'), true);
});
