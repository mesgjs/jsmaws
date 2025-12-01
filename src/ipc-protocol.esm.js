/**
 * JSMAWS IPC Protocol Handler
 * Handles inter-process communication between operator, router, and responder processes
 *
 * Message format:
 * - SOH character (\x01) prefix
 * - SLID message with boundary markers [(...)]\n
 * - Optional binary data (if dataSize > 0)
 *
 * Console messages are prefixed with SOH + [(log level)]\n to distinguish from regular output
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS, parseSLID } from './vendor.esm.js';

// SOH character (ASCII 1) - Start of Heading
const SOH = '\x01';

/**
 * IPC message types
 */
export const MessageType = {
	ROUTE_REQUEST: 'RREQ',
	ROUTE_RESPONSE: 'RRES',
	WEB_REQUEST: 'WREQ',
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
 * @returns {Object} Parsed message with type, id, capacity, and fields
 */
export function parseMessage (slidText) {
	const message = parseSLID(slidText);

	if (message.next < 2) {
		throw new Error('Invalid IPC message format: missing type or fields');
	}

	const type = message.at(0);
	const id = message.at('id');
	const capacity = message.at('capacity'); // Extract capacity metadata
	const fields = message.at(1);

	if (!(fields instanceof NANOS)) {
		throw new Error('Invalid IPC message format: fields must be NANOS');
	}

	return { type, id, capacity, fields };
}

/**
 * Encode message with SOH prefix for transmission
 * @param {NANOS} message NANOS-structured message
 * @param {Uint8Array|null} binaryData Optional binary data
 * @returns {Uint8Array} Encoded message with SOH prefix
 */
export function encodeMessage (message, binaryData = null) {
	const encoder = new TextEncoder();
	
	// Add dataSize to message if binary data present
	if (binaryData && binaryData.length > 0) {
		message.push({ dataSize: binaryData.length });
	}
	
	// Convert SLID message to string with boundary markers
	const slidText = message.toSLID();
	const slidBytes = encoder.encode(`${SOH}${slidText}\n`);

	// If no binary data, return just the SLID message
	if (!binaryData || binaryData.length === 0) {
		return slidBytes;
	}

	// Combine SLID message and binary data
	const buffer = new Uint8Array(slidBytes.length + binaryData.length);
	buffer.set(slidBytes, 0);
	buffer.set(binaryData, slidBytes.length);

	return buffer;
}

/**
 * Encode log level prefix for console interception
 * @param {string} level Log level (debug, info, log, warn, error)
 * @returns {Uint8Array} Encoded log level prefix
 */
export function encodeLogLevel (level) {
	const message = new NANOS('log');
	message.setOpts({ transform: true });
	message.push([level]);
	const slidText = message.toSLID();
	return new TextEncoder().encode(`${SOH}${slidText}\n`);
}

/**
 * Parse IPC message from line
 * @param {string} line Input line
 * @returns {Object|null} Parsed message or null if not IPC
 */
export function parseIPCMessage (line) {
	// Check for SOH + [( prefix
	if (!line.startsWith(SOH + '[(')) {
		return null;
	}

	try {
		// Parse SLID between boundary markers
		const message = parseSLID(line);
		const type = message.at(0);
		const id = message.at('id');
		const fields = message.at(1);
		const dataSize = message.at('dataSize', 0);

		if (!(fields instanceof NANOS)) {
			throw new Error('Invalid IPC message format: fields must be NANOS');
		}

		return { type, id, fields, dataSize };
	} catch (error) {
		throw new Error(`Failed to parse IPC message: ${error.message}`);
	}
}

/**
 * Parse log level message
 * @param {string} line Input line
 * @returns {string|null} Log level or null if not a log message
 */
export function parseLogMessage (line) {
	// Check for SOH + [(log prefix
	if (!line.startsWith(SOH + '[(log ')) {
		return null;
	}

	try {
		const message = parseSLID(line);
		if (message.at(0) === 'log') {
			return message.at(1); // debug, info, log, warn, error
		}
	} catch (error) {
		// Not a valid log message
	}

	return null;
}

/**
 * IPC connection handler for reading/writing messages
 */
export class IPCConnection {
	constructor (conn) {
		this.conn = conn;
		this.buffer = new Uint8Array(0);  // UNIFIED buffer (all bytes)
		this.decoder = new TextDecoder();
		this.closed = false;
		
		// State for message parsing
		this.pendingMessage = null;  // Message waiting for binary data
		this.binaryBytesNeeded = 0;  // How many binary bytes to extract
		
		// Callbacks for non-IPC content
		this.onConsoleOutput = null;  // (text, logLevel) => void
		this.currentLogLevel = 'log'; // Track most recent log level
		
		// Event-driven stream handlers
		this.streamHandlers = new Map(); // requestId -> { handler, timeout, startTime }
		this.globalHandlers = new Map(); // messageType -> handler function
		this.monitoring = false;
		this.onCapacityUpdate = null; // (capacity) => void
	}

	/**
	 * Read bytes from connection, accumulating in buffer until we have enough
	 * @param {number} count Number of bytes to read
	 * @returns {Promise<Uint8Array|null>} Bytes read, or null if connection closed
	 */
	async readBytes (count) {
		while (this.buffer.length < count) {
			const { done, value } = await this.conn.read();
			if (done) {
				if (this.buffer.length === 0) return null;
				throw new Error(`Connection closed while reading binary data (need ${count}, have ${this.buffer.length})`);
			}
			
			// Append to buffer
			const newBuffer = new Uint8Array(this.buffer.length + value.length);
			newBuffer.set(this.buffer);
			newBuffer.set(value, this.buffer.length);
			this.buffer = newBuffer;
		}
		
		// Extract requested bytes
		const result = this.buffer.slice(0, count);
		this.buffer = this.buffer.slice(count);
		return result;
	}

	/**
	 * Read a line from connection (up to \n), handling partial UTF-8 sequences
	 * @returns {Promise<string|null>} Line read (without \n), or null if connection closed
	 */
	async readLine () {
		while (true) {
			// Try to decode buffer to text, handling partial UTF-8 at end
			let text;
			let validBytes = this.buffer.length;
			
			while (validBytes > 0) {
				try {
					text = this.decoder.decode(this.buffer.slice(0, validBytes), { stream: false });
					break;
				} catch (e) {
					// Partial UTF-8 sequence at end
					validBytes--;
				}
			}
			
			// Check for newline in decoded text
			if (validBytes > 0) {
				const newlineIndex = text.indexOf('\n');
				if (newlineIndex !== -1) {
					// Found complete line
					const line = text.substring(0, newlineIndex);
					
					// Calculate bytes consumed (including \n)
					const consumedBytes = new TextEncoder().encode(text.substring(0, newlineIndex + 1)).length;
					this.buffer = this.buffer.slice(consumedBytes);
					
					return line;
				}
			}
			
			// Need more data
			const { done, value } = await this.conn.read();
			if (done) {
				// Connection closed - return any remaining data as final line
				if (validBytes > 0) {
					const line = text;
					this.buffer = new Uint8Array(0);
					return line;
				}
				return null;
			}
			
			// Append to buffer
			const newBuffer = new Uint8Array(this.buffer.length + value.length);
			newBuffer.set(this.buffer);
			newBuffer.set(value, this.buffer.length);
			this.buffer = newBuffer;
		}
	}

	/**
	 * Read next message from connection
	 * @returns {Promise<{message: Object, binaryData: Uint8Array|null}>}
	 */
	async readMessage () {
		while (true) {
			// Read a line
			const line = await this.readLine();
			if (line === null) {
				return null; // Connection closed
			}
			
			// Check if line starts with SOH (IPC or log message)
			if (!line.startsWith(SOH + '[(')) {
				// Console output - forward to handler
				if (this.onConsoleOutput && line.trim()) {
					this.onConsoleOutput(line, this.currentLogLevel);
				}
				continue;
			}
			
			// Check if it's a complete SLID block (ends with ')]')
			let slidBlock = line;
			if (!line.endsWith(')]')) {
				// Multi-line SLID block - accumulate lines until we find ')]'
				while (true) {
					const nextLine = await this.readLine();
					if (nextLine === null) {
						throw new Error('Connection closed while reading multi-line SLID block');
					}
					slidBlock += '\n' + nextLine;
					if (nextLine.endsWith(')]')) {
						break;
					}
				}
			}
			
			// Single-line SLID block
			const result = await this.parseSlidMessage(slidBlock);
			if (result) return result;
		}
	}

	/**
	 * Parse a complete SLID message and handle it
	 * @param {string} slidText Complete SLID text (including \n)
	 * @returns {Promise<Object|null>} Message result or null to continue
	 */
	async parseSlidMessage (slidText) {
		// Parse SLID
		let message;
		try {
			message = parseSLID(slidText);
		} catch (error) {
			console.warn('Failed to parse SLID message:', error.message);
			return null;
		}
		
		const type = message.at(0);
		
		// Check for log level message
		if (type === 'log') {
			const logLevel = message.at(1);
			if (logLevel) {
				this.currentLogLevel = logLevel;
			}
			return null; // Continue reading
		}
		
		// IPC message
		const id = message.at('id');
		const capacity = message.at('capacity'); // Extract capacity metadata
		const fields = message.at(1);
		const dataSize = message.at('dataSize', 0);
		
		if (!(fields instanceof NANOS)) {
			console.warn('Invalid IPC message format: fields must be NANOS');
			return null;
		}
		
		// Read binary data if present
		let binaryData = null;
		if (dataSize > 0) {
			binaryData = await this.readBytes(dataSize);
			if (binaryData === null) {
				throw new Error('Connection closed while reading binary data');
			}
		}
		
		return {
			message: { type, id, capacity, fields },
			binaryData
		};
	}

	/**
	 * Set callback for console output (non-IPC content)
	 * @param {Function} callback (text, logLevel) => void
	 */
	setConsoleOutputHandler (callback) {
		this.onConsoleOutput = callback;
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

	/**
	 * Register handler for specific request stream
	 * Handler receives multiple frames until stream completes
	 * @param {string} requestId Request ID
	 * @param {Function} handler (message, binaryData) => void | Promise<void>
	 * @param {number} timeout Timeout in milliseconds
	 */
	registerStreamHandler (requestId, handler, timeout = 30000) {
		const timeoutHandle = setTimeout(() => {
			this.streamHandlers.delete(requestId);
			handler(new Error(`Request ${requestId} timed out`), null);
		}, timeout);

		this.streamHandlers.set(requestId, {
			handler,
			timeout: timeoutHandle,
			startTime: Date.now()
		});
	}

	/**
	 * Unregister stream handler
	 */
	unregisterStreamHandler (requestId) {
		const entry = this.streamHandlers.get(requestId);
		if (entry) {
			clearTimeout(entry.timeout);
			this.streamHandlers.delete(requestId);
		}
	}

	/**
	 * Register global handler for message type
	 * For unsolicited messages (health checks, etc.)
	 * @param {string} type Message type
	 * @param {Function} handler (message, binaryData) => void | Promise<void>
	 */
	onMessage (type, handler) {
		this.globalHandlers.set(type, handler);
	}

	/**
	 * Start continuous monitoring (background task)
	 */
	async startMonitoring () {
		if (this.monitoring) return;
		this.monitoring = true;

		while (this.monitoring && !this.closed) {
			try {
				const result = await this.readMessage();
				if (!result) break; // Connection closed

				const { message, binaryData } = result;
				
				// Update capacity from message metadata (if present)
				if (message.capacity && this.onCapacityUpdate) {
					this.onCapacityUpdate(message.capacity);
				}
				
				// Check if this is part of a registered stream
				const streamEntry = this.streamHandlers.get(message.id);
				if (streamEntry) {
					try {
						await streamEntry.handler(message, binaryData);
						
						// Check if stream is complete (final frame with no keepAlive)
						const final = message.fields.at('final', false);
						const keepAlive = message.fields.at('keepAlive', false);
						if (final && !keepAlive) {
							this.unregisterStreamHandler(message.id);
						}
					} catch (error) {
						console.error(`Stream handler error for ${message.id}:`, error);
						this.unregisterStreamHandler(message.id);
					}
					continue;
				}

				// Otherwise, dispatch to global handler
				const handler = this.globalHandlers.get(message.type);
				if (handler) {
					await handler(message, binaryData);
				} else {
					console.warn(`No handler for message type: ${message.type} (id: ${message.id})`);
				}
			} catch (error) {
				if (this.monitoring) {
					console.error('Monitoring error:', error);
				}
			}
		}
	}

	/**
	 * Stop monitoring
	 */
	stopMonitoring () {
		this.monitoring = false;
		
		// Cleanup all pending streams
		for (const [requestId, entry] of this.streamHandlers) {
			clearTimeout(entry.timeout);
			entry.handler(new Error('Connection closed'), null);
		}
		this.streamHandlers.clear();
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
 * @param {number} options.availableWorkers Available workers (capacity reporting, only in first frame)
 * @param {number} options.totalWorkers Total workers (capacity reporting, only in first frame)
 * @param {number} options.initialCredits Bidi protocol parameter (only after status 101)
 * @param {number} options.maxChunkSize Bidi protocol parameter (only after status 101)
 * @param {number} options.maxBytesPerSecond Bidi protocol parameter (only after status 101)
 * @param {number} options.idleTimeout Bidi protocol parameter (only after status 101)
 * @param {number} options.maxBufferSize Bidi protocol parameter (only after status 101)
 * @returns {NANOS} Frame message
 */
export function createFrame (id, options = {}) {
	// Build capacity object if workers info provided
	let capacity = null;
	if (options.availableWorkers !== undefined || options.totalWorkers !== undefined) {
		capacity = {
			availableWorkers: options.availableWorkers,
			totalWorkers: options.totalWorkers
		};
	}
	
	// Copy all optional fields that are defined (except capacity fields which go at message level)
	const optionalFields = [
		'mode', 'status', 'headers', 'keepAlive',
		'initialCredits', 'maxChunkSize', 'maxBytesPerSecond', 'idleTimeout', 'maxBufferSize'
	];
	
	const fields = {};
	for (const field of optionalFields) {
		if (options[field] !== undefined) {
			fields[field] = options[field];
		}
	}
	if (options.final) fields.final = true;
	
	// Create message with capacity at message level
	const message = new NANOS(MessageType.WEB_FRAME, { id });
	message.setOpts({ transform: true });
	if (capacity) {
		message.push({ capacity });  // Add as named parameter
	}
	message.push([fields]);
	if (options.data?.length) message.set('dataSize', options.data.length);
	return message;
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
