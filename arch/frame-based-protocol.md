# Frame-Based Applet Protocol

**Status**: [DRAFT]

## Overview

This document describes the frame-based protocol for communication between applets and the responder process. The key insight is that **applets always stream to the responder in frames**, and the responder determines how to forward each frame to the operator/client based on frame size and configuration.

## Core Concept

### The Frame Model

1. **Applet → Responder**: Always uses frames (chunk-sized pieces)
2. **Responder → Operator**: Adapts based on accumulated frame size and configuration
3. **Single Source of Truth**: Responder's chunking configuration controls all decisions

### Benefits

- **Separation of Concerns**: Applets focus on data generation, responder handles transmission optimization
- **Consistent Behavior**: All responses use same chunking thresholds
- **Simpler Applets**: No need to understand chunking configuration
- **Memory Efficiency**: Responder can apply backpressure detection uniformly
- **DoS Protection**: Responder validates frame sizes and can start chunking immediately if frames are too large

## Protocol Design

### Request Message (Responder → Applet)

The responder sends the maximum frame size with each request:

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
  maxFrameSize: 65536  // Maximum frame size (from chunking config)
}
```

**Key Addition**: `maxFrameSize` tells the applet how large each frame should be (top-level field, not in config object).

**Security Note**: Non-built-in applets receive only `maxFrameSize`, not general configuration like `root` or `mimeTypes`. Built-in applets (like `@static`) receive additional configuration via a sub-level (e.g. `data: {...}` or `details: {...}`) mechanism.

### Response Message (Applet → Responder)

#### Initial Response (Headers)

The applet sends headers and indicates connection mode:

```javascript
// Non-keepalive response (will send frames, then close)
self.postMessage({
  type: 'response',
  id: 'req-12345',
  status: 200,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': '10485760'  // Total size if known
  },
  keepAlive: false  // Will send frames then close (default)
});

// Keepalive response (long-lived connection)
self.postMessage({
  type: 'response',
  id: 'req-12345',
  status: 200,
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache'
  },
  keepAlive: true  // Connection stays open
});
```

**Key Field**: `keepAlive` boolean indicates whether connection should stay open (default: `false`).

#### Frame Messages

The applet sends data in frames (chunk-sized pieces):

```javascript
// Send a frame of data
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,  // Up to maxFrameSize bytes
  final: false       // More frames coming
});

// Send final frame (end of response)
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,  // Last frame (may be smaller than maxFrameSize)
  final: true,       // No more frames
  keepAlive: false   // Optional - ending frame AND terminating stream
});

// Or signal end without data
self.postMessage({
  type: 'frame',
  id: 'req-12345',
  data: null,        // No data
  final: true,       // End of response
  // keepAlive: false
});
```

**Key Fields**:
- `data`: Frame payload (up to `maxFrameSize` bytes)
- `final`: Boolean indicating last frame
- `keepAlive`: Can be set to false at the end of a frame if a `keepAlive: true` connection should no longer be kept alive (orderly end of streaming)

**Security**: Responder validates that frame size does not exceed `maxFrameSize` and terminates applet if violated.

### Responder Processing

The responder accumulates frames and decides how to forward them:

```javascript
class ResponderProcess {
  async handleAppletMessage(id, data) {
    const { type } = data;
    const requestInfo = this.activeRequests.get(id);
    
    switch (type) {
      case 'response':
        // Initial response - send headers to operator
        await this.handleInitialResponse(id, data, requestInfo);
        break;
        
      case 'frame':
        // Accumulate frame and decide how to forward
        await this.handleFrame(id, data, requestInfo);
        break;
    }
  }
  
  async handleInitialResponse(id, data, requestInfo) {
    const { status, headers, keepAlive } = data;
    
    // Store keepAlive mode
    requestInfo.keepAlive = keepAlive || false;
    requestInfo.frameBuffer = [];
    requestInfo.totalBuffered = 0;
    
    // Send headers to operator (no body yet)
    await this.sendResponse(id, { status, headers, body: null });
  }
  
  async handleFrame(id, data, requestInfo) {
    const { data: frameData, final } = data;
    
    // Validate frame size (DoS protection)
    if (frameData && frameData.length > this.chunkingConfig.chunkSize) {
      console.warn(`[${this.processId}] Frame exceeds maxFrameSize, terminating applet`);
      this.cleanupRequest(id);
      await this.sendErrorResponse(id, 500, 'Internal Server Error');
      return;
    }
    
    if (frameData) {
      // Accumulate frame
      requestInfo.frameBuffer.push(frameData);
      requestInfo.totalBuffered += frameData.length;
    }
    
    // If accumulated frames exceed autoChunkThresh, start sending chunks immediately
    if (requestInfo.totalBuffered >= this.chunkingConfig.autoChunkThresh) {
      await this.flushFrameBuffer(id, requestInfo, false);
    }
    
    // If final frame, flush remaining buffer
    if (final) {
      await this.flushFrameBuffer(id, requestInfo, true);
      
      if (!requestInfo.keepAlive) {
        // Non-keepalive response complete - cleanup
        this.cleanupRequest(id);
      }
    }
  }
  
  async flushFrameBuffer(id, requestInfo, final) {
    if (requestInfo.frameBuffer.length === 0) {
      if (final) {
        // Send final signal even if no data
        await this.sendFinalChunk(id);
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
      const startTime = performance.now();
      await this.ipcConn.conn.write(combined);
	  // I believe maxDirectWrite means no flow control (incl. no backpressure)
      const writeDuration = performance.now() - startTime;
      this.detectBackpressure(writeDuration);
    } else if (totalSize < this.chunkingConfig.autoChunkThresh) {
      // Medium: Direct write with backpressure detection
      const startTime = performance.now();
      await this.ipcConn.conn.write(combined);
      const writeDuration = performance.now() - startTime;
      this.detectBackpressure(writeDuration);
    } else {
      // Large: Chunk it further
      await this.sendInChunks(combined);
    }
    
    if (final) {
      await this.sendFinalChunk(id);
    }
  }
}
```

**DoS Protection**: The responder validates each frame size and terminates the applet if it exceeds `maxFrameSize`. Additionally, if accumulated frames exceed `autoChunkThresh`, the responder immediately starts sending chunks to the operator, preventing memory exhaustion.

## Frame Size Negotiation

### Configuration Flow

1. **Server Config**: `chunkSize=65536` in SLID configuration
2. **Responder Init**: Reads `config.chunking.chunkSize`
3. **Request Message**: Passes `maxChunkSize` to applet (top-level field)
4. **Applet**: Uses `maxChunkSize` for frame-chunk boundaries

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

Built-in applets (like `@static`) receive additional configuration through a separate mechanism:

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

### Simplified Implementation

```javascript
// static-content.esm.js
self.onmessage = async (event) => {
  const { type, id, tail, maxChunkSize, config } = event.data;
  
  if (type !== 'request') return;
  
  try {
    const root = config?.root;
    const chunkSize = maxChunkSize || 65536;
    const mimeTypes = config?.mimeTypes || {};
    
    if (!root) {
      return send404(id);
    }
    
    // Validate and resolve path
    const filePath = `${root}${tail}`;
    const resolvedPath = await Deno.realPath(filePath).catch(() => null);
    
    if (!resolvedPath || !resolvedPath.startsWith(root)) {
      return send403(id);
    }
    
    const stat = await Deno.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isFile) {
      return send404(id);
    }
    
    // Determine MIME type
    const contentType = getMimeType(filePath, mimeTypes);
    
    // Send initial response (headers only)
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': stat.size.toString(),
        'Accept-Ranges': 'bytes'
      },
      keepAlive: false  // Single frame, not a long-lived connection
    });
    
    // Open file and send in chunks
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
      });
      
      if (isLastChunk) break;
      
      // Yield to event loop
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Send final chunk of frame if file size was exact multiple of chunkSize
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

1. **No chunking logic**: Applet just sends frames in chunks
2. **No size thresholds**: Responder handles all decisions
3. **Consistent frame size**: Uses `maxChunkSize` throughout
4. **Clear semantics**: `keepAlive: false` + `final: true` = complete response
5. **Built-in only**: Receives `config` object with `root` and `mimeTypes`

## Streaming Example: Server-Sent Events

Each "frame" is a message unit from the applet to the client. It's sent via the responder in chunks. The frame is built from chunks received from the applet, and the responder may start sending to the operator before the complete frame is received (if accumulated chunks exceed thresholds).

```javascript
// sse-updates.esm.js
self.onmessage = async (event) => {
  const { type, id, maxChunkSize } = event.data;
  
  if (type !== 'request') return;
  
  try {
    
    // Send initial response
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      },
      keepAlive: true  // Long-lived connection
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
        final: false  // More frames coming
      });
    }, 1000);
    
    // Keep worker alive until external close signal
    // (Would need additional message type for client disconnect)
    
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

## Comparison to Previous Design

### Old Design (Applet Controls Chunking)

```javascript
// Applet decides chunking strategy
if (fileSize < 64KB) {
  // Send complete body
  self.postMessage({ type: 'response', body: completeData });
} else {
  // Send chunked
  self.postMessage({ type: 'response', chunked: true });
  // Send chunks...
}
```

**Problems**:
- Duplicates responder's chunking logic
- Configuration mismatch (applet vs responder thresholds)
- Inconsistent behavior across applets
- No DoS protection

### New Design (Frame-Based)

```javascript
// Applet always sends frames
self.postMessage({ type: 'response', keepAlive: false });
while (hasData) {
  self.postMessage({ type: 'frame', data: frame, final: isLast });
}
```

**Benefits**:
- Single source of truth (responder config)
- Consistent behavior
- Simpler applet code
- Responder can optimize transmission
- DoS protection via frame size validation

## Migration Path

### Phase 1: Add Frame Support (Backward Compatible)

1. Responder recognizes both old (`chunk`) and new (`frame`) message types
2. New applets use `frame` messages
3. Old applets continue using `chunk` messages

### Phase 2: Update Built-in Applets

1. Update `@static` applet to use frame-based protocol
2. Document frame-based protocol as recommended approach

### Phase 3: Deprecate Old Protocol (Future)

1. Mark `chunk` message type as deprecated
2. Eventually remove support for old protocol

## Implementation Checklist

- [ ] Update [`arch/applet-protocol.md`](applet-protocol.md) with frame-based protocol
- [ ] Add `maxFrameSize` to request message in [`src/responder-process.esm.js`](../src/responder-process.esm.js)
- [ ] Implement `handleFrame()` in responder process with DoS protection
- [ ] Implement frame buffer accumulation and flushing
- [ ] Add built-in applet configuration mechanism
- [ ] Update [`src/applets/static-content.esm.js`](../src/applets/static-content.esm.js) to use frames
- [ ] Add frame-based examples to applet protocol documentation
- [ ] Create tests for frame-based protocol
- [ ] Update [`arch/static-applet.md`](static-applet.md) with frame-based design

## References

- [`arch/applet-protocol.md`](applet-protocol.md) - Current applet protocol
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) - Responder implementation
- [`src/configuration.esm.js`](../src/configuration.esm.js) - Chunking configuration
- [`arch/static-applet.md`](static-applet.md) - Static file applet design

[supplemental keywords: chunking, streaming, flow control, backpressure, frame buffer, transmission optimization, DoS protection, keepalive]