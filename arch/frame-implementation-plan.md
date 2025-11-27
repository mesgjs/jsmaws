# Frame-Based Protocol Implementation Plan

**Status**: [COMPLETE]

## Overview

This document provides a comprehensive implementation plan for the unified frame-based protocol. This is a **clean slate implementation** - no backward compatibility is required.

## Executive Summary

**Unified Protocol Design:**
- ✅ Single message type: `frame` with context-sensitive fields
- ✅ First frame includes: `mode`, `status`, `headers` (connection establishment)
- ✅ Subsequent frames minimal: `id`, `data`, `final`, optionally `keepAlive` (if changing state)
- ✅ Sticky state: `mode` and `keepAlive` persist across frames
- ✅ Protocol parameters: Integrated into first frame from responder (bidi mode)

**Legacy Protocols Removed:**
- ❌ `response` message type → Unified into `frame` (first frame includes status/headers)
- ❌ `chunk` message type (`WEB_CHUNK`) → Replaced with `frame`
- ❌ `stream-data`/`stream-close` (`WEB_STREAM`, `WEB_STREAM_CLOSE`) → Replaced with `frame` (mode: `stream`)
- ❌ `ws-upgrade`/`ws-send`/`ws-close` (`WS_UPGRADE`, `WS_DATA`, `WS_CLOSE`) → Replaced with `frame` (mode: `bidi`)
- ❌ `bidi-ready` message type → Integrated into `frame` (protocol params in first frame from responder)
- ❌ `wsOpcode` field → Transport-specific, handled by operator

**Unified Protocol:**
- ✅ `frame` - Unified frame protocol with modes: `response`, `stream`, `bidi`
- ✅ `error` - Error responses (already exists)

## Phase 1: IPC Protocol Updates

**File**: [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js)

### 1.1 Remove Legacy Message Types

```javascript
// REMOVE these from MessageType object:
WEB_CHUNK: 'WCHK',        // ❌ Remove
WEB_STREAM: 'WSTR',       // ❌ Remove
WEB_STREAM_CLOSE: 'WSCL', // ❌ Remove
WS_UPGRADE: 'WSUP',       // ❌ Remove
WS_DATA: 'WSDT',          // ❌ Remove
WS_CLOSE: 'WSCL',         // ❌ Remove (duplicate key with WEB_STREAM_CLOSE)
BIDI_READY: 'BRDY',       // ❌ Remove (integrated into frame)
```

### 1.2 Keep/Add Unified Message Types

```javascript
// KEEP/ADD these to MessageType object:
WEB_FRAME: 'WFRM',        // Unified frame protocol (all layers)
WEB_ERROR: 'WERR',        // Error responses (keep)
```

**Note**: `WEB_RESPONSE` is **REMOVED** from IPC protocol. The unified `frame` protocol is used at all layers: applet → responder → operator. The first frame includes status and headers (connection establishment), subsequent frames contain only data.

### 1.3 Remove Legacy Helper Functions

Delete these functions:
- `createChunk()` (if exists)
- `createStreamData()` (if exists)
- `createStreamClose()` (if exists)
- `createWebSocketUpgrade()` (if exists)
- `createWebSocketData()` (if exists)
- `createWebSocketClose()` (if exists)
- `createBidiReady()` (if exists)

### 1.4 Update/Add Unified Helper Functions

```javascript
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
```

## Phase 2: Responder Process Updates

**File**: [`src/responder-process.esm.js`](../src/responder-process.esm.js)

### 2.1 Update Imports

```javascript
import {
	MessageType,
	createResponse,      // For IPC to operator (HTTP headers)
	createFrame,         // NEW - unified frame protocol
	validateMessage,
} from './ipc-protocol.esm.js';
```

### 2.2 Remove Legacy Imports

```javascript
// REMOVE these:
createChunk,
createStreamData,
createStreamClose,
createWebSocketUpgrade,
createWebSocketData,
createWebSocketClose,
createBidiReady,
```

### 2.3 Add Connection State Tracking

```javascript
constructor (processId, poolName) {
	super('responder', processId);
	this.poolName = poolName || Deno.env.get('JSMAWS_POOL') || 'standard';
	
	// Track active requests and workers
	this.activeRequests = new Map();
	this.activeWebSockets = new Map();
	this.requestCount = 0;
	this.maxConcurrentRequests = 10;
	
	// NEW: Track bidirectional connections
	this.bidiConnections = new Map(); // id → connection state
	
	// Response chunking configuration
	this.chunkingConfig = { /* ... */ };
	
	// Backpressure detection
	this.isBackpressured = false;
	this.recentWriteTimes = [];
	this.maxRecentWrites = 5;
}
```

### 2.4 Remove Legacy Handler Methods

Delete these methods:
- `handleAppletChunk()` (if exists)
- `handleAppletStreamData()` (if exists)
- `handleAppletStreamClose()` (if exists)
- `handleAppletWebSocketUpgrade()` (if exists)
- `handleAppletWebSocketSend()` (if exists)
- `handleAppletWebSocketClose()` (if exists)
- `handleAppletResponse()` (if it only handles legacy `response` message type)

### 2.5 Update `handleAppletMessage()` Method

Replace with unified frame handler:

```javascript
async handleAppletMessage (id, data) {
	const { type } = data;
	
	if (type !== 'frame' && type !== 'error') {
		console.warn(`[${this.processId}] Unknown message type: ${type}`);
		return;
	}
	
	const requestInfo = this.activeRequests.get(id);
	if (!requestInfo) {
		console.warn(`[${this.processId}] Received message for unknown request ${id}`);
		return;
	}

	try {
		if (type === 'error') {
			await this.handleAppletError(id, data, requestInfo);
		} else {
			await this.handleFrame(id, data, requestInfo);
		}
	} catch (error) {
		console.error(`[${this.processId}] Error handling applet message:`, error);
		await this.sendErrorResponse(id, 500, 'Internal Server Error');
		this.cleanupRequest(id);
	}
}
```

### 2.6 Implement Unified `handleFrame()` Method

```javascript
async handleFrame (id, data, requestInfo) {
	const { mode, status, headers, data: frameData, final, keepAlive } = data;
	
	// First frame - establish connection
	if (mode !== undefined) {
		await this.handleFirstFrame(id, data, requestInfo);
		return;
	}
	
	// Enforce maxChunkSize limit (DoS protection)
	if (frameData && frameData.length > this.chunkingConfig.chunkSize) {
		console.warn(`[${this.processId}] Frame chunk exceeds maxChunkSize (${frameData.length} > ${this.chunkingConfig.chunkSize}), terminating applet`);
		this.cleanupRequest(id);
		await this.sendErrorResponse(id, 500, 'Internal Server Error');
		return;
	}
	
	// Handle based on mode
	if (requestInfo.mode === 'bidi') {
		await this.handleBidiFrame(id, frameData, final, keepAlive, requestInfo);
		return;
	}
	
	// Handle response/stream modes (accumulate and forward)
	if (frameData) {
		requestInfo.frameBuffer.push(frameData);
		requestInfo.totalBuffered += frameData.length;
	}
	
	// If accumulated data exceeds autoChunkThresh, start forwarding immediately
	if (requestInfo.totalBuffered >= this.chunkingConfig.autoChunkThresh) {
		await this.flushFrameBuffer(id, requestInfo, false);
	}
	
	// If final frame, flush remaining buffer
	if (final) {
		await this.flushFrameBuffer(id, requestInfo, true);
		
		// Update keepAlive status if specified
		if (keepAlive !== undefined) {
			requestInfo.keepAlive = keepAlive;
		}
		
		// Cleanup if not keepAlive
		if (!requestInfo.keepAlive) {
			clearTimeout(requestInfo.timeout);
			this.activeRequests.delete(id);
			requestInfo.worker.terminate();
		}
	}
}
```

### 2.7 Implement `handleFirstFrame()` Method

```javascript
async handleFirstFrame (id, data, requestInfo) {
	const { mode, status, headers, keepAlive, data: frameData, final } = data;
	
	// Store connection state
	requestInfo.mode = mode;
	requestInfo.keepAlive = keepAlive !== undefined ? keepAlive : false;
	requestInfo.frameBuffer = [];
	requestInfo.totalBuffered = 0;
	
	// Send HTTP response headers to operator
	await this.sendResponse(id, { status, headers, body: null });
	
	// Handle bidi mode initialization
	if (mode === 'bidi' && status === 101) {
		await this.initializeBidiConnection(id, requestInfo);
	}
	
	// Process any data in first frame
	if (frameData || final) {
		await this.handleFrame(id, { data: frameData, final, keepAlive }, requestInfo);
	}
}
```

### 2.8 Implement Bidirectional Connection Management

```javascript
/**
 * Initialize bidirectional connection
 */
async initializeBidiConnection (id, requestInfo) {
	const maxChunkSize = this.chunkingConfig.chunkSize;
	const bidiConfig = this.config.bidiFlowControl || {};
	const initialCredits = (bidiConfig.initialCredits || 10) * maxChunkSize;
	
	// Send protocol parameters to applet
	requestInfo.worker.postMessage({
		type: 'frame',
		id,
		mode: 'bidi',
		initialCredits,
		maxChunkSize,
		maxBytesPerSecond: bidiConfig.maxBytesPerSecond || 10485760,
		idleTimeout: bidiConfig.idleTimeout || 60,
		maxBufferSize: bidiConfig.maxBufferSize || 1048576,
		data: null,
		final: false,
		keepAlive: true
	});
	
	// Initialize bidi connection state
	const connState = {
		worker: requestInfo.worker,
		outboundCredits: initialCredits,
		inboundCredits: initialCredits,
		outboundBuffer: [],
		inboundBuffer: [],
		maxBufferSize: bidiConfig.maxBufferSize || 1048576,
		totalBuffered: { outbound: 0, inbound: 0 },
		maxCredits: initialCredits,
		maxBytesPerSecond: bidiConfig.maxBytesPerSecond || 10485760,
		idleTimeout: bidiConfig.idleTimeout || 60,
		lastActivity: Date.now()
	};
	
	this.bidiConnections.set(id, connState);
	
	// Send protocol parameters to operator (via IPC) - second frame after status 101
	const frameMsg = createFrame(id, {
		final: false,
		keepAlive: true,
		initialCredits,
		maxChunkSize,
		maxBytesPerSecond: connState.maxBytesPerSecond,
		idleTimeout: connState.idleTimeout,
		maxBufferSize: connState.maxBufferSize
	});
	await this.ipcConn.writeMessage(frameMsg);
}

/**
 * Handle bidirectional frame (mode: 'bidi')
 */
async handleBidiFrame (id, frameData, final, keepAlive, requestInfo) {
	let conn = this.bidiConnections.get(id);
	if (!conn) {
		console.warn(`[${this.processId}] Bidi frame for non-bidi connection ${id}`);
		return;
	}
	
	const chunkSize = frameData?.length || 0;
	
	// Check if applet has sufficient credits
	if (conn.outboundCredits < chunkSize) {
		// Insufficient credits - buffer the chunk
		conn.outboundBuffer.push({ frameData, final, keepAlive });
		conn.totalBuffered.outbound += chunkSize;
		
		// Check buffer limit (DoS protection)
		if (conn.totalBuffered.outbound > conn.maxBufferSize) {
			console.warn(`[${this.processId}] Bidi ${id} outbound buffer exceeded, terminating`);
			this.closeBidiConnection(id, 'Buffer overflow');
			return;
		}
		
		return; // Don't forward yet
	}
	
	// Consume credits (byte-based)
	conn.outboundCredits -= chunkSize;
	
	// Forward chunk to operator
	const frameMsg = createFrame(id, undefined, frameData, final, keepAlive);
	await this.ipcConn.writeMessage(frameMsg, frameData);
	
	// Update last activity
	conn.lastActivity = Date.now();
	
	// Handle connection close
	if (final && keepAlive === false) {
		this.closeBidiConnection(id, 'Normal closure');
	}
}

/**
 * Close bidirectional connection
 */
closeBidiConnection (id, reason) {
	const conn = this.bidiConnections.get(id);
	if (!conn) return;
	
	console.log(`[${this.processId}] Closing bidi connection ${id}: ${reason}`);
	
	// Terminate worker
	conn.worker.terminate();
	
	// Cleanup
	this.bidiConnections.delete(id);
	this.activeRequests.delete(id);
	this.activeWebSockets.delete(id);
}

/**
 * Handle inbound frame from operator (client → applet)
 */
async handleOperatorBidiFrame (id, frameData, final) {
	const conn = this.bidiConnections.get(id);
	if (!conn) return;
	
	const chunkSize = frameData?.length || 0;
	
	// Check if client has sufficient credits to send to applet
	if (conn.inboundCredits < chunkSize) {
		// Insufficient credits - buffer the chunk
		conn.inboundBuffer.push({ frameData, final });
		conn.totalBuffered.inbound += chunkSize;
		
		// Check buffer limit
		if (conn.totalBuffered.inbound > conn.maxBufferSize) {
			console.warn(`[${this.processId}] Bidi ${id} inbound buffer exceeded, terminating`);
			this.closeBidiConnection(id, 'Buffer overflow');
			return;
		}
		
		return;
	}
	
	// Consume credits (byte-based)
	conn.inboundCredits -= chunkSize;
	
	// Forward to applet
	conn.worker.postMessage({
		type: 'frame',
		id,
		data: frameData,
		final
		// mode omitted (already established)
		// keepAlive omitted (sticky)
	});
	
	// Applet implicitly grants credits by processing chunk
	// Grant credits back when applet finishes processing
	conn.inboundCredits = Math.min(
		conn.inboundCredits + chunkSize,
		conn.maxCredits
	);
	
	// Update last activity
	conn.lastActivity = Date.now();
}
```

### 2.9 Update `flushFrameBuffer()` Method

```javascript
async flushFrameBuffer (id, requestInfo, final) {
	if (!requestInfo.frameBuffer || requestInfo.frameBuffer.length === 0) {
		if (final) {
			// Send final frame signal even if no data
			const frameMsg = createFrame(id, undefined, null, true);
			await this.ipcConn.writeMessage(frameMsg);
		}
		return;
	}
	
	// Concatenate accumulated frames
	const totalSize = requestInfo.totalBuffered;
	const combined = new Uint8Array(totalSize);
	let offset = 0;
	
	for (const frame of requestInfo.frameBuffer) {
		combined.set(frame, offset);
		offset += frame.length;
	}
	
	// Clear buffer
	requestInfo.frameBuffer = [];
	requestInfo.totalBuffered = 0;
	
	// Apply responder's chunking logic
	if (totalSize < this.chunkingConfig.maxDirectWrite) {
		// Small: Direct write
		const frameMsg = createFrame(id, undefined, combined, final);
		const startTime = performance.now();
		await this.ipcConn.writeMessage(frameMsg, combined);
		const writeDuration = performance.now() - startTime;
		this.detectBackpressure(writeDuration);
	} else if (totalSize < this.chunkingConfig.autoChunkThresh) {
		// Medium: Direct write with backpressure detection
		const frameMsg = createFrame(id, undefined, combined, final);
		const startTime = performance.now();
		await this.ipcConn.writeMessage(frameMsg, combined);
		const writeDuration = performance.now() - startTime;
		this.detectBackpressure(writeDuration);
	} else {
		// Large: Send in chunks to operator
		await this.sendInChunks(id, combined, final);
	}
}
```

### 2.10 Update `sendInChunks()` Method

```javascript
async sendInChunks (id, data, final) {
	const { chunkSize } = this.chunkingConfig;
	let offset = 0;
	
	while (offset < data.length) {
		const end = Math.min(offset + chunkSize, data.length);
		const chunk = data.slice(offset, end);
		const isLast = (end === data.length) && final;
		
		const frameMsg = createFrame(id, undefined, chunk, isLast);
		const startTime = performance.now();
		await this.ipcConn.writeMessage(frameMsg, chunk);
		const writeDuration = performance.now() - startTime;
		
		this.detectBackpressure(writeDuration);
		
		offset = end;
		
		// Yield to event loop
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}
```

## Phase 3: Static Content Applet Updates

**File**: [`src/applets/static-content.esm.js`](../src/applets/static-content.esm.js)

### 3.1 Update to Use Unified Frame Protocol

```javascript
// static-content.esm.js
self.onmessage = async (event) => {
  const { type, id, tail, maxChunkSize, config } = event.data;
  
  if (type !== 'request') return;
  
  try {
    const root = config?.root;
    const chunkSize = maxChunkSize || 65536;
    const mimeTypes = config?.mimeTypes || {};
    
    if (!root) return send404(id);
    
    // Validate and resolve path
    const filePath = `${root}${tail}`;
    const resolvedPath = await Deno.realPath(filePath).catch(() => null);
    
    if (!resolvedPath || !resolvedPath.startsWith(root)) {
      return send403(id);
    }
    
    const stat = await Deno.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isFile) return send404(id);
    
    // Determine MIME type
    const contentType = getMimeType(filePath, mimeTypes);
    
    // Send first frame (establishes connection and includes headers)
    self.postMessage({
      type: 'frame',
      id,
      mode: 'response',
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': stat.size.toString(),
        'Accept-Ranges': 'bytes'
      },
      data: null,        // No data in first frame (headers only)
      final: false,
      keepAlive: false   // Single response, not streaming
    });
    
    // Open file and send in frames
    const file = await Deno.open(resolvedPath, { read: true });
    const buffer = new Uint8Array(chunkSize);
    
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      
      const chunk = buffer.slice(0, bytesRead);
      const isLastChunk = bytesRead < chunkSize;
      
      self.postMessage({
        type: 'frame',
        id,
        data: chunk,
        final: isLastChunk
        // mode omitted (already established)
        // keepAlive omitted (sticky from first frame)
      });
      
      if (isLastChunk) break;
      
      // Yield to event loop
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Send final frame signal if file size was exact multiple of chunkSize
    if (stat.size % chunkSize === 0) {
      self.postMessage({
        type: 'frame',
        id,
        data: null,
        final: true
      });
    }
    
    file.close();
    self.close();
    
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message,
      stack: error.stack
    });
    self.close();
  }
};
```

### 3.2 Update Helper Functions

```javascript
function send403(id) {
  self.postMessage({
    type: 'frame',
    id,
    mode: 'response',
    status: 403,
    headers: { 'Content-Type': 'text/plain' },
    data: new TextEncoder().encode('Forbidden'),
    final: true,
    keepAlive: false
  });
  self.close();
}

function send404(id) {
  self.postMessage({
    type: 'frame',
    id,
    mode: 'response',
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
    data: new TextEncoder().encode('Not Found'),
    final: true,
    keepAlive: false
  });
  self.close();
}
```

## Phase 4: Configuration Updates

**File**: [`jsmaws.slid`](../jsmaws.slid)

### 4.1 Add Bidirectional Flow Control Configuration

Add new section:

```slid
# Bidirectional flow control configuration
bidiFlowControl=[
	initialCredits=10          # Initial credit multiplier (× maxChunkSize)
	maxBufferSize=1048576      # 1MB max buffer per direction per connection
	maxBytesPerSecond=10485760 # 10MB/s rate limit per connection
	idleTimeout=60             # 60 seconds idle timeout
]
```

### 4.2 Update Configuration Class

**File**: [`src/configuration.esm.js`](../src/configuration.esm.js)

Add getter for bidi flow control:

```javascript
get bidiFlowControl () {
	if (!this._bidiFlowControl) {
		const bidiConfig = this.config.at('bidiFlowControl');
		if (bidiConfig) {
			this._bidiFlowControl = {
				initialCredits: bidiConfig.at('initialCredits', 10),
				maxBufferSize: bidiConfig.at('maxBufferSize', 1048576),
				maxBytesPerSecond: bidiConfig.at('maxBytesPerSecond', 10485760),
				idleTimeout: bidiConfig.at('idleTimeout', 60)
			};
		} else {
			// Defaults
			this._bidiFlowControl = {
				initialCredits: 10,
				maxBufferSize: 1048576,
				maxBytesPerSecond: 10485760,
				idleTimeout: 60
			};
		}
	}
	return this._bidiFlowControl;
}
```

## Phase 5: Operator Process Updates

**File**: [`src/operator.esm.js`](../src/operator.esm.js)

### 5.1 Update Imports

```javascript
import {
	createRequest,
	MessageType,
	createFrame,         // For forwarding bidi frames
	validateMessage,
} from './ipc-protocol.esm.js';
```

### 5.2 Remove Legacy Handler Methods

Delete these methods:
- `handleWebResponse()` - ❌ Remove (replaced by unified frame handling)

### 5.3 Update `forwardToServiceProcess()` Method

```javascript
async forwardToServiceProcess (req, route, match, remote) {
	// ... existing code to prepare request ...
	
	try {
		await process.ipcConn.writeMessage(requestMsg, new Uint8Array(bodyBytes));
		
		// Update affinity
		if (appletPath) {
			this.processManager.updateAffinity(process.id, appletPath);
		}
		
		// Wait for first frame (includes status and headers)
		const { message, binaryData } = await process.ipcConn.readMessage();
		
		// Update process capacity from response
		process.updateCapacity(
			message.fields.at('availableWorkers', 0),
			message.fields.at('totalWorkers', 0),
			message.fields.at('requestsQueued', 0)
		);
		
		// Handle frame message (unified protocol)
		if (message.type === MessageType.WEB_FRAME) {
			return await this.handleFrameResponse(message.id, message, binaryData, process, req);
		} else {
			throw new Error(`Unexpected message type: ${message.type}`);
		}
	} catch (error) {
		// ... error handling ...
	}
}
```

### 5.4 Implement Unified `handleFrameResponse()` Method

```javascript
/**
 * Handle frame response (unified protocol)
 */
async handleFrameResponse (requestId, firstFrame, firstData, process, req) {
	const mode = firstFrame.fields.at('mode');
	const status = firstFrame.fields.at('status', 200);
	const headers = this.convertHeaders(firstFrame.fields.at('headers'));
	const keepAlive = firstFrame.fields.at('keepAlive', false);
	const final = firstFrame.fields.at('final', false);
	
	// Handle bidirectional upgrade
	if (mode === 'bidi' && status === 101) {
		return await this.handleBidiUpgrade(requestId, firstFrame, process, req);
	}
	
	// Handle response/stream modes
	if (mode === 'response' || mode === 'stream') {
		return await this.handleResponseStream(requestId, status, headers, keepAlive, final, firstData, process);
	}
	
	// Unknown mode
	throw new Error(`Unknown frame mode: ${mode}`);
}
```

### 5.5 Implement `handleResponseStream()` Method

```javascript
/**
 * Handle response or stream mode frames
 */
async handleResponseStream (requestId, status, headers, keepAlive, firstFinal, firstData, process) {
	// Create readable stream to handle frames
	const stream = new ReadableStream({
		start: async (controller) => {
			try {
				// Send first frame data if present
				if (firstData && firstData.length > 0) {
					controller.enqueue(firstData);
				}
				
				// If first frame is final and not keepAlive, close immediately
				if (firstFinal && !keepAlive) {
					controller.close();
					return;
				}
				
				// Read subsequent frames
				while (true) {
					const { message: frameMsg, binaryData: frameData } = await process.ipcConn.readMessage();
					
					if (frameMsg.type !== MessageType.WEB_FRAME) {
						throw new Error(`Expected WEB_FRAME, got ${frameMsg.type}`);
					}
					
					// Send frame data if present
					if (frameData && frameData.length > 0) {
						controller.enqueue(frameData);
					}
					
					// Check if final chunk
					const final = frameMsg.fields.at('final', false);
					if (final) {
						const frameKeepAlive = frameMsg.fields.at('keepAlive', keepAlive);
						if (!frameKeepAlive) {
							// Last frame - close stream
							controller.close();
							break;
						}
						// Otherwise, more frames coming later (streaming mode)
					}
				}
			} catch (error) {
				controller.error(error);
			}
		},
	});
	
	return new Response(stream, {
		status,
		headers,
	});
}
```

### 5.6 Update `handleBidiUpgrade()` Method

The existing `handleBidiUpgrade()` method should be updated to read protocol parameters from a subsequent frame instead of from the first frame fields.

```javascript
/**
 * Handle bidirectional connection upgrade (WebSocket)
 */
async handleBidiUpgrade (requestId, firstFrame, process, req) {
	try {
		// Read protocol parameters from next frame (sent by responder after status 101)
		const { message: paramsMsg } = await process.ipcConn.readMessage();
		
		if (paramsMsg.type !== MessageType.WEB_FRAME) {
			throw new Error(`Expected WEB_FRAME with protocol params, got ${paramsMsg.type}`);
		}
		
		// Extract protocol parameters
		const initialCredits = paramsMsg.fields.at('initialCredits', 655360);
		const maxChunkSize = paramsMsg.fields.at('maxChunkSize', 65536);
		const maxBytesPerSecond = paramsMsg.fields.at('maxBytesPerSecond', 10485760);
		const idleTimeout = paramsMsg.fields.at('idleTimeout', 60);
		const maxBufferSize = paramsMsg.fields.at('maxBufferSize', 1048576);
		
		// ... rest of existing implementation ...
	} catch (error) {
		this.logger.error(`Bidi upgrade error: ${error.message}`);
		return new Response('WebSocket upgrade failed', {
			status: 500,
			headers: { 'Content-Type': 'text/plain' },
		});
	}
}
```

### 5.7 Update `handleClientBidiMessage()` Method

```javascript
async handleClientBidiMessage (requestId, data, connState) {
	// Convert WebSocket message to Uint8Array
	let frameData;
	if (typeof data === 'string') {
		frameData = new TextEncoder().encode(data);
	} else if (data instanceof ArrayBuffer) {
		frameData = new Uint8Array(data);
	} else if (data instanceof Uint8Array) {
		frameData = data;
	} else {
		this.logger.warn(`Unexpected WebSocket data type: ${typeof data}`);
		return;
	}
	
	const chunkSize = frameData.length;
	
	// Check credits (flow control)
	if (connState.inboundCredits < chunkSize) {
		this.logger.warn(`Client ${requestId} exceeded inbound credits`);
		connState.socket.close(1008, 'Flow control violation');
		this.bidiConnections.delete(requestId);
		return;
	}
	
	// Consume credits
	connState.inboundCredits -= chunkSize;
	
	// Forward to responder process via IPC using frame protocol
	const frameMsg = createFrame(requestId, undefined, undefined, undefined, frameData, false);
	await connState.process.ipcConn.writeMessage(frameMsg, frameData);
	
	// Implicit credit grant (applet processes the data)
	connState.inboundCredits = Math.min(
		connState.inboundCredits + chunkSize,
		connState.maxCredits
	);
	
	// Update activity timestamp
	connState.lastActivity = Date.now();
}
```

## Phase 6: Documentation Updates

### 5.1 Update Status to [APPROVED]

Change status in these documents:
- [x] [`arch/frame-based-protocol.md`](arch/frame-based-protocol.md) - Updated with unified design
- [x] [`arch/unified-protocol-assessment.md`](arch/unified-protocol-assessment.md) - Updated with unified design
- [ ] [`arch/bidirectional-flow-control.md`](arch/bidirectional-flow-control.md) - Change to [APPROVED]

### 5.2 Update [`arch/tech.md`](arch/tech.md)

Verify this document is in the index (already present):
```markdown
- [`arch/frame-implementation-plan.md`](../../../arch/frame-implementation-plan.md) - Implementation plan for unified protocol
```

## Phase 6: Testing Strategy

### 6.1 Frame Protocol Tests

**File**: `test/frame-protocol.test.js`

Test cases:
1. First frame with mode, status, headers
2. Subsequent frames without mode/status/headers
3. Sticky keepAlive state
4. Small response (< maxDirectWrite) - direct write
5. Medium response (< autoChunkThresh) - direct write with backpressure
6. Large response (> autoChunkThresh) - chunked forwarding
7. Frame accumulation and flushing
8. DoS protection (oversized chunks)
9. Multiple frames in single response

### 6.2 Streaming Tests

**File**: `test/streaming-protocol.test.js`

Test cases:
1. SSE with multiple frames over time
2. Long-lived connections (keepAlive: true)
3. Orderly stream close (keepAlive: false on final frame)
4. Timeout enforcement
5. Frame rate limiting

### 6.3 Bidirectional Tests

**File**: `test/bidirectional-protocol.test.js`

Test cases:
1. WebSocket upgrade accept
2. WebSocket upgrade reject
3. Protocol parameters sent after acceptance
4. Credit-based flow control (outbound)
5. Credit-based flow control (inbound)
6. Implicit credit grants
7. Buffer overflow protection
8. Rate limiting (bytes per second)
9. Idle timeout
10. Bidirectional message exchange

### 6.4 Security Tests

**File**: `test/security-protocol.test.js`

Test cases:
1. Hostile applet (oversized chunks) - should terminate
2. Credit exhaustion attempts - should buffer then close
3. Rate flood attacks - should enforce rate limit
4. Buffer overflow attempts - should close connection
5. Multi-tenant isolation - one applet cannot affect others
6. Idle connection cleanup

### 6.5 Integration Tests

**File**: `test/integration-protocol.test.js`

Test cases:
1. End-to-end HTTP request/response
2. End-to-end SSE streaming
3. End-to-end WebSocket bidirectional
4. Static file serving with unified frame protocol
5. Large file download with chunking
6. Concurrent connections

## Phase 7: Migration Checklist

### IPC Protocol (`src/ipc-protocol.esm.js`)
- [ ] Remove `WEB_CHUNK`, `WEB_STREAM`, `WEB_STREAM_CLOSE` from MessageType
- [ ] Remove `WS_UPGRADE`, `WS_DATA`, `WS_CLOSE` from MessageType
- [ ] Remove `BIDI_READY` from MessageType
- [ ] Keep/Add `WEB_FRAME` to MessageType
- [ ] Remove `createChunk()` function (if exists)
- [ ] Remove `createStreamData()` function (if exists)
- [ ] Remove `createStreamClose()` function (if exists)
- [ ] Remove `createWebSocketUpgrade()` function (if exists)
- [ ] Remove `createWebSocketData()` function (if exists)
- [ ] Remove `createWebSocketClose()` function (if exists)
- [ ] Remove `createBidiReady()` function (if exists)
- [ ] Update/Add `createFrame()` function with context-sensitive fields

### Responder Process (`src/responder-process.esm.js`)
- [ ] Update imports (add createFrame, remove legacy)
- [ ] Add `bidiConnections` Map to constructor
- [ ] Remove `handleAppletChunk()` method (if exists)
- [ ] Remove `handleAppletStreamData()` method (if exists)
- [ ] Remove `handleAppletStreamClose()` method (if exists)
- [ ] Remove `handleAppletWebSocketUpgrade()` method (if exists)
- [ ] Remove `handleAppletWebSocketSend()` method (if exists)
- [ ] Remove `handleAppletWebSocketClose()` method (if exists)
- [ ] Remove legacy `handleAppletResponse()` method (if exists)
- [ ] Update `handleAppletMessage()` to handle only `frame` and `error`
- [ ] Implement unified `handleFrame()` method
- [ ] Implement `handleFirstFrame()` method
- [ ] Implement `initializeBidiConnection()` method
- [ ] Implement `handleBidiFrame()` method
- [ ] Implement `closeBidiConnection()` method
- [ ] Implement `handleOperatorBidiFrame()` method
- [ ] Update `flushFrameBuffer()` to use `createFrame()`
- [ ] Update `sendInChunks()` to use `createFrame()`

### Static Content Applet (`src/applets/static-content.esm.js`)
- [ ] Update to send first frame with mode, status, headers
- [ ] Update to send subsequent frames without mode/status/headers
- [ ] Update to use sticky keepAlive state
- [ ] Update helper functions (send403, send404) to use unified frames

### Configuration (`jsmaws.slid`, `src/configuration.esm.js`)
- [ ] Add `bidiFlowControl` section to SLID config
- [ ] Add `bidiFlowControl` getter to Configuration class
- [ ] Document all flow control parameters

### Documentation
- [x] Update [`arch/frame-based-protocol.md`](arch/frame-based-protocol.md)
- [x] Update [`arch/unified-protocol-assessment.md`](arch/unified-protocol-assessment.md)
- [x] Update [`arch/frame-implementation-plan.md`](arch/frame-implementation-plan.md)
- [ ] Change status to [APPROVED] in [`arch/bidirectional-flow-control.md`](arch/bidirectional-flow-control.md)
- [ ] Verify [`arch/tech.md`](arch/tech.md) index includes this document

### Testing
- [ ] Create `test/frame-protocol.test.js`
- [ ] Create `test/streaming-protocol.test.js`
- [ ] Create `test/bidirectional-protocol.test.js`
- [ ] Create `test/security-protocol.test.js`
- [ ] Create `test/integration-protocol.test.js`
- [ ] Run all tests and verify passing
- [ ] Performance benchmarking

## Key Design Decisions

1. **Unified Frame Design**: Single message type with context-sensitive fields
2. **First Frame Special**: Includes mode, status, headers (connection establishment)
3. **Sticky State**: mode and keepAlive persist across frames (don't repeat)
4. **Protocol Parameters**: Integrated into first frame from responder (bidi mode)
5. **Byte-Based Credits**: Credits = bytes (not frames) to prevent DoS via large frames
6. **Implicit Credit Grants**: Automatic, simpler, prevents bugs, zero latency overhead
7. **Transport-Agnostic**: Generic "bidi" mode works with WebSocket and future transports
8. **WebSocket Upgrade**: Client initiates, applet can accept or reject

## Security Properties

### DoS Protection
- `maxChunkSize` enforced per chunk (applet terminated if exceeded)
- `autoChunkThresh` triggers immediate forwarding (prevents memory exhaustion)
- `maxBufferSize` limits buffered data per connection
- `maxBytesPerSecond` rate limiting per connection
- `idleTimeout` closes idle connections

### Multi-Tenant Isolation
- Per-connection credit tracking
- Per-connection buffer limits
- Per-connection rate limits
- One applet cannot affect others

### Credit-Based Flow Control
- Prevents buffer exhaustion
- Natural backpressure
- Implicit grants eliminate bugs
- Works bidirectionally

## Implementation Timeline

**Estimated effort**: 3-5 days

1. **Day 1**: IPC protocol updates and responder process refactoring
2. **Day 2**: Static content applet updates and configuration
3. **Day 3**: Documentation updates and test suite creation
4. **Day 4**: Testing and bug fixes
5. **Day 5**: Performance benchmarking and final verification

## References

- [`arch/unified-protocol-assessment.md`](unified-protocol-assessment.md) - Unified protocol design
- [`arch/frame-based-protocol.md`](frame-based-protocol.md) - Frame-based protocol specification
- [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) - Flow control design
- [`arch/applet-protocol.md`](applet-protocol.md) - Applet communication protocol
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) - Responder implementation
- [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js) - IPC protocol implementation

[supplemental keywords: implementation plan, migration strategy, unified protocol, frame-based protocol, bidirectional flow control, credit-based flow control, clean slate implementation, legacy protocol removal, sticky state, context-sensitive fields, WebSocket upgrade, accept/reject]