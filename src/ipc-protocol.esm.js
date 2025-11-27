/**
 * JSMAWS IPC Protocol Handler
 * Handles inter-process communication between operator, router, and responder processes
 * 
 * Message format:
 * - 4-byte length prefix (big-endian)
 * - SLID header with metadata
 * - Binary data (if bodySize > 0)
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS, parseSLID } from './vendor.esm.js';

/**
 * IPC message types
 */
export const MessageType = {
	ROUTE_REQUEST: 'RREQ',
	ROUTE_RESPONSE: 'RRES',
	WEB_REQUEST: 'WREQ',
	WEB_RESPONSE: 'WRES',     // HTTP response headers (operator → client)
	WEB_FRAME: 'WFRM',        // Unified frame protocol (all layers)
	WEB_ERROR: 'WERR',        // Error responses
	CONFIG_UPDATE: 'CFG',
	SHUTDOWN: 'HALT',
	SCALE_DOWN: 'RIF',
	HEALTH_CHECK: 'HCHK',
};

/**
 * Generate unique message ID
 */
let messageIdCounter = 0;
export function generateMessageId (prefix = 'MSG') {
	return `${prefix}-${Date.now()}-${++messageIdCounter}`;
}

/**
 * Create a NANOS-structured IPC message
 * @param {string} type Message type
 * @param {string} id Message id
 * @param {Object} fields Message fields
 * @returns {NANOS} message
 */
export function createMessage ({ type, id = generateMessageId(type) }, fields = {}) {
	const message = new NANOS(type, { id });
	message.setOpts({ transform: true });
	message.push([fields]);
	return message;
}

/**
 * Parse a SLID-formatted IPC message
 * @param {string} slidText SLID message text
 * @returns {Object} Parsed message with type and fields
 */
export function parseMessage (slidText) {
	const message = parseSLID(slidText);

	if (message.next < 2) {
		throw new Error('Invalid IPC message format: missing type or fields');
	}

	const type = message.at(0);
	const id = message.at('id');
	const fields = message.at(1);

	if (!(fields instanceof NANOS)) {
		throw new Error('Invalid IPC message format: fields must be NANOS');
	}

	return { type, id, fields };
}

/**
 * Encode message with length prefix for transmission
 * @param {NANOS} message NANOS-structured message
 * @param {Uint8Array|null} binaryData Optional binary data
 * @returns {Uint8Array} Encoded message with length prefix
 */
export function encodeMessage (message, binaryData = null) {
	// Convert SLID message to string with boundary markers
	const slidText = message.toSLID();
	const slidBytes = new TextEncoder().encode(slidText);

	// Calculate total length
	const totalLength = slidBytes.length + (binaryData ? binaryData.length : 0);

	// Create buffer with length prefix
	const buffer = new Uint8Array(4 + totalLength);
	const view = new DataView(buffer.buffer);

	// Write length prefix (big-endian)
	view.setUint32(0, totalLength, false);

	// Write SLID header
	buffer.set(slidBytes, 4);

	// Write binary data if present
	if (binaryData) {
		buffer.set(binaryData, 4 + slidBytes.length);
	}

	return buffer;
}

/**
 * IPC connection handler for reading/writing messages
 */
export class IPCConnection {
	constructor (conn) {
		this.conn = conn;
		this.readBuffer = new Uint8Array(0);
		this.closed = false;
	}

	/**
	 * Read next message from connection
	 * @returns {Promise<{message: Object, binaryData: Uint8Array|null}>}
	 */
	async readMessage () {
		// Read length prefix (4 bytes)
		const lengthBytes = await this.readExactly(4);
		if (!lengthBytes) {
			return null; // Connection closed
		}

		const view = new DataView(lengthBytes.buffer);
		const messageLength = view.getUint32(0, false);

		// Read message data
		const messageBytes = await this.readExactly(messageLength);
		if (!messageBytes) {
			throw new Error('Connection closed while reading message');
		}

		// Find SLID boundary markers
		const messageText = new TextDecoder().decode(messageBytes);
		const startMarker = messageText.indexOf('[(');
		const endMarker = messageText.lastIndexOf(')]');

		if (startMarker === -1 || endMarker === -1) {
			throw new Error('Invalid message format: missing SLID boundary markers');
		}

		// Extract SLID header
		const slidText = messageText.substring(startMarker, endMarker + 2);
		const message = parseMessage(slidText);

		// Extract binary data if present
		const bodySize = message.fields.at('bodySize', 0);
		let binaryData = null;

		if (bodySize > 0) {
			const slidLength = new TextEncoder().encode(slidText).length;
			binaryData = messageBytes.slice(slidLength);

			if (binaryData.length !== bodySize) {
				throw new Error(`Binary data size mismatch: expected ${bodySize}, got ${binaryData.length}`);
			}
		}

		return { message, binaryData };
	}

	/**
	 * Write message to connection
	 * @param {NANOS} message SLID message
	 * @param {Uint8Array|null} binaryData Optional binary data
	 */
	async writeMessage (message, binaryData = null) {
		const encoded = encodeMessage(message, binaryData);
		await this.conn.write(encoded);
	}

	/**
	 * Read exactly n bytes from connection
	 * @param {number} n Number of bytes to read
	 * @returns {Promise<Uint8Array|null>}
	 */
	async readExactly (n) {
		while (this.readBuffer.length < n) {
			const chunk = new Uint8Array(8192);
			const bytesRead = await this.conn.read(chunk);

			if (bytesRead === null) {
				// Connection closed
				if (this.readBuffer.length === 0) {
					return null;
				}
				throw new Error('Connection closed while reading');
			}

			// Append to buffer
			const newBuffer = new Uint8Array(this.readBuffer.length + bytesRead);
			newBuffer.set(this.readBuffer);
			newBuffer.set(chunk.slice(0, bytesRead), this.readBuffer.length);
			this.readBuffer = newBuffer;
		}

		// Extract requested bytes
		const result = this.readBuffer.slice(0, n);
		this.readBuffer = this.readBuffer.slice(n);
		return result;
	}

	/**
	 * Close connection
	 */
	async close () {
		if (!this.closed) {
			this.closed = true;
			try {
				await this.conn.close();
			} catch (error) {
				// Ignore close errors
			}
		}
	}

	/**
	 * Check if connection is closed
	 */
	isClosed () {
		return this.closed;
	}
}

/**
 * Create route request message
 */
export function createRouteRequest (method, path, headers, remote) {
	return createMessage({ type: MessageType.ROUTE_REQUEST }, {
		method: method.toLowerCase(),
		path,
		headers,
		bodySize: 0,
		remote,
	});
}

/**
 * Create route response message
 */
export function createRouteResponse (id, pool, app, params, tail, status = 200) {
	return createMessage({ type: MessageType.ROUTE_RESPONSE, id }, {
		pool,
		app,
		params,
		tail,
		status,
	});
}

/**
 * Create request message
 */
export function createRequest (method, path, app, pool, headers, bodySize, remote, params = {}, tail = '') {
	return createMessage({ type: MessageType.WEB_REQUEST }, {
		method: method.toLowerCase(),
		path,
		app,
		pool,
		headers,
		bodySize,
		remote,
		params,
		tail,
	});
}

/**
 * Create response message
 */
export function createResponse (id, status, headers, bodySize, availableWorkers, totalWorkers, requestsQueued) {
	return createMessage({ type: MessageType.WEB_RESPONSE, id }, {
		status,
		headers,
		bodySize,
		availableWorkers,
		totalWorkers,
		requestsQueued,
	});
}

/**
 * Create config update message
 */
export function createConfigUpdate (config) {
	return createMessage({ type: MessageType.CONFIG_UPDATE }, {
		pools: config.at('pools'),
		mimeTypes: config.at('mimeTypes'),
		routes: config.at('routes'),
		fsRouting: config.at('fsRouting', false),
	});
}

/**
 * Create shutdown message
 */
export function createShutdown (timeout = 30) {
	return createMessage({ type: MessageType.SHUTDOWN }, { timeout });
}

/**
 * Create scale-down message
 */
export function createScaleDown () {
	return createMessage({ type: MessageType.SCALE_DOWN }, {});
}

/**
 * Create health check message
 */
export function createHealthCheck () {
	return createMessage({ type: MessageType.HEALTH_CHECK }, {
		timestamp: Date.now(),
	});
}

/**
 * Create frame message (unified protocol)
 * @param {string} id Request/connection ID
 * @param {Object} options Frame options
 * @param {string} options.mode Connection mode: 'response' | 'stream' | 'bidi' (only in first frame)
 * @param {number} options.status HTTP status code (only in first frame for response/stream modes)
 * @param {NANOS} options.headers HTTP headers (only in first frame for response/stream modes)
 * @param {Uint8Array|null} options.data Frame chunk data
 * @param {boolean} options.final Last chunk of current frame
 * @param {boolean} options.keepAlive Connection stays open (optional, sticky state)
 * @param {number} options.initialCredits Bidi protocol parameter (only after status 101)
 * @param {number} options.maxChunkSize Bidi protocol parameter (only after status 101)
 * @param {number} options.maxBytesPerSecond Bidi protocol parameter (only after status 101)
 * @param {number} options.idleTimeout Bidi protocol parameter (only after status 101)
 * @param {number} options.maxBufferSize Bidi protocol parameter (only after status 101)
 * @returns {NANOS} Frame message
 */
export function createFrame (id, options = {}) {
	const fields = {
		dataSize: options.data ? options.data.length : 0,
		final: options.final ?? false
	};
	
	// Copy all optional fields that are defined
	const optionalFields = [
		'mode', 'status', 'headers', 'keepAlive',
		'initialCredits', 'maxChunkSize', 'maxBytesPerSecond', 'idleTimeout', 'maxBufferSize'
	];
	
	for (const field of optionalFields) {
		if (options[field] !== undefined) {
			fields[field] = options[field];
		}
	}
	
	return createMessage({ type: MessageType.WEB_FRAME, id }, fields);
}

/**
 * Create error message
 * @param {string} id Request/connection ID
 * @param {number} status HTTP status code
 * @param {string} message Error message
 * @param {string} details Additional error details (optional)
 * @returns {NANOS} Error message
 */
export function createError (id, status, message, details) {
	const fields = { status, message };
	if (details !== undefined) {
		fields.details = details;
	}
	return createMessage({ type: MessageType.WEB_ERROR, id }, fields);
}

/**
 * Validate message fields
 * @param {Object} message Parsed message
 * @param {Array<string>} requiredFields Required field names
 */
export function validateMessage (message, requiredFields) {
	for (const field of requiredFields) {
		if (!message.fields.has(field)) {
			throw new Error(`Missing required field: ${field}`);
		}
	}
}
