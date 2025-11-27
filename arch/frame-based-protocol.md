# Frame-Based Applet Protocol

**Status**: [DRAFT]

## Overview

This document describes the unified frame-based protocol for communication between applets and the responder process. The key insight is that **everything is a frame** - there is only one message type (`frame`) with context-sensitive fields.

## Core Concept

### The Unified Frame Model

1. **Single Message Type**: All communication uses `frame` messages
2. **Context-Sensitive Fields**: First frame includes connection setup (mode, status, headers), subsequent frames are minimal
3. **Sticky State**: `keepAlive` and `mode` persist across frames (don't repeat unless changing)
4. **Separation of Concerns**: Applets generate data, responder handles transmission optimization

### Benefits

- **Simpler Protocol**: One message type, one handler, fewer code paths
- **Smaller Messages**: Subsequent frames omit redundant fields
- **Consistent Behavior**: All responses use same chunking thresholds
- **Easier Implementation**: Fewer edge cases, simpler state management
- **DoS Protection**: Responder validates frame sizes and applies backpressure uniformly

## Protocol Design

### Request Message (Responder → Applet)

The responder sends requests to applets with the maximum chunk size:

```javascript
{
  type: 'request',
  id: 'req-12345',
  method: 'GET',
  path: '/static/large-file.bin',
  headers: { ... },
  params: { ... },
  query: { ... },
  tail: '/large-file.bin',
  body: Uint8Array,
  maxChunkSize: 65536  // Maximum frame data size per message (enforced security limit)
}
```

**Key Fields**:
- `maxChunkSize`: Maximum frame data size per message (security limit enforced by responder)

**Security Note**: Non-built-in applets receive only `maxChunkSize`. Built-in applets (like `@static`) receive additional configuration via a `config` sub-object.

### Frame Message (Unified Protocol)

All responses use the unified `frame` message type with context-sensitive fields.

#### First Frame (Connection Establishment)

The first frame establishes the connection type and includes HTTP semantics:

```javascript
// Regular HTTP response (mode: 'response')
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  mode: 'response',      // Connection type (only in first frame)
  status: 200,           // HTTP status (only in first frame)
  headers: {             // HTTP headers (only in first frame)
    'Content-Type': 'application/octet-stream',
    'Content-Length': '10485760'
  },
  data: Uint8Array,      // First chunk of data (or null for headers-only)
  final: false,          // More chunks coming
  keepAlive: false       // Close after response (sticky state, default: false)
});

// Streaming response (mode: 'stream')
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  mode: 'stream',        // Streaming mode
  status: 200,
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache'
  },
  data: null,            // No data in first frame (headers only)
  final: false,
  keepAlive: true        // Keep connection open (sticky)
});

// Bidirectional upgrade - ACCEPT (mode: 'bidi')
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  mode: 'bidi',          // Bidirectional mode
  status: 101,           // Switching Protocols
  headers: {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Accept': '...'
  },
  data: null,            // No data in upgrade
  final: false,
  keepAlive: true        // Long-lived connection
});

// Bidirectional upgrade - REJECT (mode: 'response')
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  mode: 'response',      // Regular HTTP response (not bidi)
  status: 403,           // Forbidden (or 400, 401, etc.)
  headers: {
    'Content-Type': 'text/plain'
  },
  data: new TextEncoder().encode('WebSocket upgrade rejected: authentication required'),
  final: true,
  keepAlive: false       // Close connection
});
```

**Key Fields (First Frame Only)**:
- `mode`: Connection type - `'response'`, `'stream'`, or `'bidi'` (establishes connection mode)
- `status`: HTTP status code (e.g., 200, 206, 101, 403)
- `headers`: HTTP response headers
- `keepAlive`: Boolean indicating if connection stays open (becomes sticky state, default: false)

**Common Rejection Reasons** (for WebSocket upgrades):
- `400 Bad Request`: Invalid WebSocket headers or protocol version
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Authentication failed or insufficient permissions
- `426 Upgrade Required`: Client must use specific subprotocol
- `503 Service Unavailable`: Server overloaded or maintenance mode

#### Subsequent Frames (Simplified)

After the first frame, subsequent frames are minimal:

```javascript
// Send more data (mode and keepAlive inherited from first frame)
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,      // Up to maxChunkSize bytes
  final: false           // More chunks coming
  // mode omitted (already established)
  // status/headers omitted (not needed)
  // keepAlive omitted (uses previous value - sticky)
});

// Final chunk
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,      // Last chunk
  final: true            // End of response
  // keepAlive still false (sticky from first frame)
});

// Or signal end without data
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: null,
  final: true
});
```

**Key Fields (Subsequent Frames)**:
- `id`: Request/connection ID (required)
- `data`: Frame payload (up to `maxChunkSize` bytes)
- `final`: Boolean indicating last chunk of current frame
- `keepAlive`: Optional - only include if changing state (e.g., closing a stream)

#### Changing keepAlive State

For streaming responses that want to close the connection:

```javascript
// Stream has been sending frames with keepAlive: true (sticky)
// ...many frames later...

// Final frame changes keepAlive to close connection
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,      // Last data
  final: true,
  keepAlive: false       // Override sticky state to close
});
```

### Bidirectional Protocol Parameters

For `mode: 'bidi'` connections, the responder sends protocol parameters in its first frame after the applet accepts the upgrade:

```javascript
// Responder → Applet (first frame after bidi upgrade accepted)
{
  type: 'frame',
  id: 'conn-12345',
  mode: 'bidi',              // Confirms bidi mode
  initialCredits: 655360,       // 640KB initial credits
  maxChunkSize: 65536,          // 64KB max per chunk
  maxBytesPerSecond: 10485760,  // 10MB/s rate limit
  idleTimeout: 60,              // 60s idle timeout
  maxBufferSize: 1048576,       // 1MB buffer limit
  data: null,
  final: false,
  keepAlive: true
}
```

**Protocol Parameters** (bidi mode only, sent by responder):
- `initialCredits`: Initial byte credits for sending
- `maxChunkSize`: Maximum bytes per chunk
- `maxBytesPerSecond`: Rate limit (bytes/second)
- `idleTimeout`: Idle timeout (seconds)
- `maxBufferSize`: Buffer limit (bytes)

These parameters provide the "rule book" for bidirectional communication. See [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) for complete flow control design.

**Security**: Responder enforces `maxChunkSize` limit for DoS protection. Applets sending frame data exceeding this limit are terminated as hostile.

### WebSocket Upgrade Flow

The complete WebSocket upgrade sequence:

```
1. Client → Operator → Responder → Applet
   GET /chat HTTP/1.1
   Upgrade: websocket
   Connection: Upgrade
   Sec-WebSocket-Key: ...
   Sec-WebSocket-Version: 13

2. Applet receives request:
   {
     type: 'request',
     id: 'req-12345',
     method: 'GET',
     path: '/chat',
     headers: {
       'Upgrade': 'websocket',
       'Connection': 'Upgrade',
       'Sec-WebSocket-Key': '...',
       'Sec-WebSocket-Version': '13'
     },
     ...
   }

3a. Applet ACCEPTS upgrade:
    {
      type: 'frame',
      id: 'req-12345',
      mode: 'bidi',
      status: 101,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Accept': '...'
      },
      data: null,
      final: false,
      keepAlive: true
    }

3b. OR Applet REJECTS upgrade:
    {
      type: 'frame',
      id: 'req-12345',
      mode: 'response',
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
      data: new TextEncoder().encode('Forbidden'),
      final: true,
      keepAlive: false
    }

4. If accepted, Responder sends protocol parameters:
   {
     type: 'frame',
     id: 'req-12345',
     mode: 'bidi',
     initialCredits: 655360,
     maxChunkSize: 65536,
     maxBytesPerSecond: 10485760,
     idleTimeout: 60,
     maxBufferSize: 1048576,
     data: null,
     final: false,
     keepAlive: true
   }

5. Bidirectional communication begins
```

**Key Points**:
- Client initiates upgrade (not applet)
- Applet receives normal `request` message with upgrade headers
- Applet can accept (status 101) or reject (status 4xx)
- Responder sends protocol parameters immediately after acceptance
- Operator handles WebSocket protocol details (opcodes, framing, etc.)

### Responder Processing

The responder handles frames with context-sensitive logic:

```javascript
class ResponderProcess {
  async handleAppletMessage (id, data) {
    const { type } = data;
    
    if (type !== 'frame') {
      console.warn(`[${this.processId}] Unknown message type: ${type}`);
      return;
    }
    
    const requestInfo = this.activeRequests.get(id);
    if (!requestInfo) {
      console.warn(`[${this.processId}] Received frame for unknown request ${id}`);
      return;
    }
    
    await this.handleFrame(id, data, requestInfo);
  }
  
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
      maxCredits: initialCredits
    };
    
    this.bidiConnections.set(id, connState);
  }
  
  async flushFrameBuffer (id, requestInfo, final) {
    if (!requestInfo.frameBuffer || requestInfo.frameBuffer.length === 0) {
      if (final) {
        // Send final signal even if no data
        const frameMsg = createFrame(id, requestInfo.mode, null, true);
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
      const frameMsg = createFrame(id, requestInfo.mode, combined, final);
      const startTime = performance.now();
      await this.ipcConn.writeMessage(frameMsg, combined);
      const writeDuration = performance.now() - startTime;
      this.detectBackpressure(writeDuration);
    } else if (totalSize < this.chunkingConfig.autoChunkThresh) {
      // Medium: Direct write with backpressure detection
      const frameMsg = createFrame(id, requestInfo.mode, combined, final);
      const startTime = performance.now();
      await this.ipcConn.writeMessage(frameMsg, combined);
      const writeDuration = performance.now() - startTime;
      this.detectBackpressure(writeDuration);
    } else {
      // Large: Chunk it further
      await this.sendInChunks(id, combined, final, requestInfo.mode);
    }
  }
}
```

**DoS Protection**: The responder validates each frame size and terminates the applet if it exceeds `maxChunkSize`. Additionally, if accumulated frames exceed `autoChunkThresh`, the responder immediately starts sending chunks to the operator, preventing memory exhaustion.

## Frame Size Negotiation

### Configuration Flow

1. **Server Config**: `chunkSize=65536` in SLID configuration
2. **Responder Init**: Reads `config.chunking.chunkSize`
3. **Request Message**: Passes `maxChunkSize` to applet
4. **Applet**: Ensures frame chunks never exceed `maxChunkSize`
5. **Responder**: Validates each chunk, terminates applet if limit exceeded

### Default Values

```javascript
// In configuration.esm.js
get chunking() {
  if (!this._chunking) {
    this._chunking = {
      maxDirectWrite: this.config.at('maxDirectWrite', 65536),      // 64KB
      autoChunkThresh: this.config.at('autoChunkThresh', 10485760), // 10MB
      chunkSize: this.config.at('chunkSize', 65536),                // 64KB
      maxWriteBuffer: this.config.at('maxWriteBuffer', 1048576),    // 1MB
      bpWriteTimeThresh: this.config.at('bpWriteTimeThresh', 50),   // 50ms
    };
  }
  return this._chunking;
}
```

## Built-in Applet Configuration

Built-in applets (like `@static`) receive additional configuration:

```javascript
// In responder-process.esm.js
async handleWebRequest(id, fields, binaryData) {
  const appletPath = fields.at('app');
  
  // Check for built-in applets
  let builtinConfig = null;
  if (appletPath === '@static') {
    builtinConfig = {
      root: this.config.routing.root,
      mimeTypes: this.config.mimeTypes.toObject()
    };
  }
  
  // Send request to applet
  appletWorker.postMessage({
    type: 'request',
    id,
    method,
    path,
    headers,
    params,
    query,
    tail,
    body: binaryData,
    maxChunkSize: this.chunkingConfig.chunkSize,
    ...(builtinConfig && { config: builtinConfig })  // Only for built-ins
  });
}
```

**Security**: Only built-in applets receive the `config` object. User-provided applets receive only `maxChunkSize`.

## Example: Static File Applet

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

### Key Features

1. **Unified protocol**: All messages use `frame` type
2. **First frame special**: Includes mode, status, headers
3. **Subsequent frames minimal**: Only id, data, final
4. **Sticky keepAlive**: Set once in first frame, inherited by subsequent frames
5. **Security compliance**: Respects `maxChunkSize` limit
6. **Built-in only**: Receives `config` object with `root` and `mimeTypes`

## Streaming Example: Server-Sent Events

```javascript
// sse-updates.esm.js
self.onmessage = async (event) => {
  const { type, id, maxChunkSize } = event.data;
  
  if (type !== 'request') return;
  
  try {
    // Send first frame (establishes streaming connection)
    self.postMessage({
      type: 'frame',
      id,
      mode: 'stream',
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      },
      data: null,
      final: false,
      keepAlive: true    // Long-lived connection
    });
    
    // Send updates every second
    const interval = setInterval(() => {
      const message = `data: ${JSON.stringify({
        timestamp: Date.now(),
        value: Math.random()
      })}\n\n`;
      
      const chunk = new TextEncoder().encode(message);
      
      self.postMessage({
        type: 'frame',
        id,
        data: chunk,
        final: true        // Each SSE event is one frame
        // mode omitted (already established)
        // keepAlive omitted (sticky - still true)
      });
    }, 1000);
    
    // Keep worker alive until external close signal
    
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message
    });
    self.close();
  }
};
```

## Bidirectional Example: WebSocket Echo

```javascript
// bidi-echo.esm.js
self.onmessage = async (event) => {
  const { type, id, mode, data, headers } = event.data;
  
  if (type === 'request' && headers['Upgrade'] === 'websocket') {
    // Validate upgrade request (check auth, subprotocol, etc.)
    const isAuthorized = validateAuth(headers);
    
    if (!isAuthorized) {
      // Reject upgrade
      self.postMessage({
        type: 'frame',
        id,
        mode: 'response',
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
        data: new TextEncoder().encode('Forbidden: authentication required'),
        final: true,
        keepAlive: false
      });
      self.close();
      return;
    }
    
    // Accept upgrade
    self.postMessage({
      type: 'frame',
      id,
      mode: 'bidi',
      status: 101,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Accept': computeAcceptKey(headers['Sec-WebSocket-Key'])
      },
      data: null,
      final: false,
      keepAlive: true
    });
    
    // Responder will send protocol parameters next
    return;
  }
  
  if (type === 'frame' && mode === 'bidi') {
    // Check for protocol parameters (first frame from responder)
    if (event.data.initialCredits !== undefined) {
      console.log(`Bidi connection ready with ${event.data.initialCredits} credits`);
      return;
    }
    
    // Received data from client - echo it back
    if (data) {
      self.postMessage({
        type: 'frame',
        id,
        data: data,        // Echo
        final: true        // Each WebSocket message is one frame
        // mode omitted (already established)
        // keepAlive omitted (sticky - still true)
      });
    }
  }
};
```

## WebSocket Handling in Operator

The operator process handles WebSocket-specific details:

```javascript
// Operator maps WebSocket to/from unified frame protocol
class OperatorProcess {
  async handleWebSocketUpgrade(id, socket, request) {
    // Forward upgrade request to responder
    await this.sendToResponder({
      type: 'request',
      id,
      method: request.method,
      path: request.url,
      headers: request.headers,
      ...
    });
    
    // Wait for applet response (accept or reject)
    // If accepted (status 101), complete WebSocket handshake
    
    socket.on('message', (data, isBinary) => {
      // Forward to responder as frame
      this.sendToResponder({
        type: 'frame',
        id,
        mode: 'bidi',
        data: isBinary ? data : new TextEncoder().encode(data),
        final: true
      });
    });
    
    socket.on('close', () => {
      // Notify responder of close
      this.sendToResponder({
        type: 'frame',
        id,
        data: null,
        final: true,
        keepAlive: false
      });
    });
  }
  
  async handleResponderBidiFrame(id, frame) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    // Send to WebSocket client
    if (frame.data) {
      await conn.socket.send(frame.data);
    }
    
    // Handle close
    if (frame.final && frame.keepAlive === false) {
      conn.socket.close();
    }
  }
}
```

**Key Points**:
- Operator handles WebSocket protocol details (opcodes, framing, handshake)
- Applet sees only generic bidi frames
- Transport-agnostic design allows future protocols (HTTP/2, QUIC, etc.)

## Comparison to Previous Design

### Old Design (Separate Message Types)

```javascript
// Initial response
{ type: 'response', id, status, headers, keepAlive }

// Data chunks
{ type: 'frame', id, data, final }

// Bidi ready
{ type: 'bidi-ready', id, initialCredits, maxChunkSize, ... }
```

**Problems**:
- Multiple message types to handle
- Redundant fields repeated across messages
- More complex handler logic
- Larger total message size

### New Design (Unified Frames)

```javascript
// First frame (establishes everything)
{ type: 'frame', id, mode, status, headers, data, final, keepAlive }

// Subsequent frames (minimal)
{ type: 'frame', id, data, final }

// Bidi protocol params (in first frame from responder)
{ type: 'frame', id, mode: 'bidi', initialCredits, maxChunkSize, ..., data, final, keepAlive }
```

**Benefits**:
- Single message type
- Smaller subsequent messages
- Simpler handler logic
- Consistent pattern across all modes
- Easier to implement and maintain

## Implementation Checklist

- [ ] Update [`arch/unified-protocol-assessment.md`](unified-protocol-assessment.md) with unified frame design
- [ ] Update [`arch/frame-implementation-plan.md`](frame-implementation-plan.md) with refined protocol
- [ ] Remove `response` message type from [`src/responder-process.esm.js`](../src/responder-process.esm.js)
- [ ] Remove `bidi-ready` message type (integrate into frame protocol)
- [ ] Implement first-frame detection and handling
- [ ] Implement sticky `keepAlive` state tracking
- [ ] Update [`src/applets/static-content.esm.js`](../src/applets/static-content.esm.js) to use unified frames
- [ ] Add WebSocket handling to operator process
- [ ] Create tests for unified frame protocol
- [ ] Update [`arch/static-applet.md`](static-applet.md) with unified frame design

## References

- [`arch/unified-protocol-assessment.md`](unified-protocol-assessment.md) - Unified protocol assessment
- [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) - Flow control design
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) - Responder implementation
- [`src/configuration.esm.js`](../src/configuration.esm.js) - Chunking configuration
- [`arch/static-applet.md`](static-applet.md) - Static file applet design

[supplemental keywords: unified protocol, frame-based protocol, single message type, sticky state, context-sensitive fields, streaming, flow control, backpressure, frame buffer, transmission optimization, DoS protection, keepalive, bidirectional, WebSocket, upgrade flow, protocol parameters]
