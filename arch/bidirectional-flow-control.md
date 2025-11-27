# Bidirectional Flow Control Protocol

**Status**: [APPROVED]

## Context

JSMAWS needs application-level flow control for bidirectional communication channels. While the primary use case is WebSocket connections, this protocol is designed to be **transport-agnostic** and could be used for any bidirectional communication mechanism in the future.

### Why Application-Level Flow Control?

TCP provides transport-level flow control, but this operates at the wrong layer for multi-tenant server applications where:

1. **Multiple connections share resources** - One slow client shouldn't block others
2. **Applets need backpressure signals** - Must know when to pause data generation
3. **Security requires rate limiting** - Hostile applets/clients must be controlled
4. **Memory safety is critical** - Unbounded buffers lead to DoS vulnerabilities

## Research: Existing Approaches

### 1. WebStreams API (WHATWG Streams)

**Concept**: JavaScript Streams API provides backpressure through `ReadableStream` and `WritableStream`.

```javascript
// ReadableStream with backpressure
const stream = new ReadableStream({
  start(controller) {
    // Producer
  },
  pull(controller) {
    // Called when consumer is ready for more data
    // Natural backpressure signal
  },
  cancel() {
    // Consumer cancelled
  }
});
```

**Pros**:
- Native JavaScript API with built-in backpressure
- Well-understood semantics
- Works with async/await naturally

**Cons**:
- Requires both ends to use Streams API
- Not directly compatible with message-based protocols
- Adds complexity for simple request/response patterns

**Applicability to JSMAWS**: ⚠️ Partial
- Could use internally within responder process
- Cannot use directly over message-based transports
- Would need protocol wrapper to signal backpressure

### 2. HTTP/2 Flow Control (RFC 7540)

**Concept**: Window-based flow control at stream and connection level.

```
WINDOW_UPDATE frame:
+---------------------------------------------------------------+
|                   Window Size Increment (31)                  |
+---------------------------------------------------------------+
```

**Flow Control Mechanism**:
- Each side maintains a flow control window
- Sender cannot send more than window allows
- Receiver sends WINDOW_UPDATE to increase window
- Separate windows for each stream and connection

**Pros**:
- Proven at scale (all HTTP/2 traffic)
- Prevents head-of-line blocking
- Fine-grained control per stream

**Cons**:
- Complex to implement correctly
- Requires careful window management

**Applicability to JSMAWS**: ✅ Excellent model
- Window-based approach is ideal
- Can simplify for our use case
- Proven effective at scale

### 3. Socket.IO with Acknowledgments

**Concept**: WebSocket library with built-in acknowledgment callbacks.

```javascript
// Client sends with callback
socket.emit('message', data, (ack) => {
  // Server acknowledged, safe to send more
});

// Server acknowledges
socket.on('message', (data, callback) => {
  processData(data);
  callback(); // Acknowledge receipt
});
```

**Flow Control Mechanism**:
- Optional callback parameter for acknowledgment
- Sender waits for callback before sending more
- Simple request/response pattern

**Pros**:
- Simple API
- Explicit acknowledgment
- Widely used in production

**Cons**:
- Adds latency (round-trip per message)
- Not suitable for high-throughput streaming

**Applicability to JSMAWS**: ✅ Good pattern
- Acknowledgment model is simple and effective
- Can adapt for our frame-based protocol
- Fits our security model (explicit control)

## JSMAWS Requirements Analysis

### Bidirectional Flow Control Needs

**Applet → Client (Outbound)**:
1. Applet generates data (potentially faster than client can consume)
2. Responder must buffer and apply backpressure to applet
3. Operator must buffer and apply backpressure to responder
4. Client TCP window provides ultimate backpressure

**Client → Applet (Inbound)**:
1. Client sends data (potentially faster than applet can process)
2. Operator must buffer and apply backpressure to client
3. Responder must buffer and apply backpressure to operator
4. Applet processing speed provides ultimate backpressure

### Security Requirements

1. **DoS Protection**: Hostile clients/applets cannot exhaust memory
2. **Rate Limiting**: Maximum bytes per second per connection
3. **Buffer Limits**: Maximum buffered data per connection
4. **Timeout Enforcement**: Idle connections must be closed
5. **Multi-Tenant Isolation**: One connection cannot affect others

### Performance Requirements

1. **Low Latency**: Minimize round-trips for flow control
2. **High Throughput**: Support streaming large amounts of data
3. **Efficient Buffering**: Minimize memory copies
4. **Scalability**: Support thousands of concurrent connections

## Recommended Design: Credit-Based Flow Control

### Core Concept

Inspired by HTTP/2 flow control but simplified for our use case:

1. **Credits**: Each side grants the other side "credits" (bytes) to send data
2. **Credit Consumption**: Sending data consumes credits (1 credit = 1 byte)
3. **Credit Replenishment**: Receiver grants more credits as it processes data
4. **Zero Credits**: Sender must wait for more credits before sending

### Protocol Messages

#### 1. Connection Establishment

```javascript
// Responder → Applet (after connection upgrade)
{
  type: 'bidi-ready',
  id: 'conn-12345',
  initialCredits: 655360  // Applet can send 640KB before needing more credits (10 × 64KB)
}
```

**Important**: Credits are **byte-based**. Each frame chunk consumes credits equal to its data size. This prevents DoS attacks via large frames.

#### 2. Frame Chunk with Credit Consumption

```javascript
// Applet → Responder (outbound to client)
{
  type: 'frame',
  id: 'conn-12345',
  mode: 'bidi',
  data: Uint8Array,  // e.g., 32KB chunk
  final: false,
  // Sending this chunk consumes data.length credits (e.g., 32768 credits)
}

// Client → Operator → Responder → Applet (inbound from client)
{
  type: 'frame',
  id: 'conn-12345',
  mode: 'bidi',
  data: Uint8Array,  // e.g., 16KB chunk
  final: true,
  // Responder tracks credits, doesn't forward if client has insufficient credits
  // This chunk consumes data.length credits (e.g., 16384 credits)
}
```

**Key Points**:
- `mode: 'bidi'` indicates bidirectional protocol (vs 'response' or 'stream')
- No transport-specific fields (like `wsOpcode`) - this is a generic protocol
- Credits consumed = `data.length` (byte-based)
- `final: true` indicates last chunk of current application message

#### 3. Credit Grant

```javascript
// Responder → Applet (grant more credits)
{
  type: 'bidi-credits',
  id: 'conn-12345',
  credits: 65536  // Grant 64KB more credits (applet can send 64KB more data)
}

// Applet → Responder (implicit credit grant)
// When applet processes an inbound chunk, it implicitly grants data.length credits
// Responder tracks this and forwards to operator
```

**Credit Calculation**:
- Each frame chunk consumes `data.length` credits (bytes)
- Initial credits: 10 × `maxChunkSize` (e.g., 10 × 64KB = 640KB)
- Credit grants: Typically `maxChunkSize` per grant (e.g., 64KB)
- Maximum credits: 10 × `maxChunkSize` (prevent unbounded credit accumulation)

### Credit Management

#### Responder Process (Managing Applet Credits)

```javascript
class ResponderProcess {
  constructor() {
    this.bidiConnections = new Map(); // id → connection state
  }
  
  async handleBidiUpgrade(id, appletWorker) {
    const maxChunkSize = this.config.chunking.chunkSize; // e.g., 65536
    const initialCredits = 10 * maxChunkSize; // 640KB
    
    const connState = {
      worker: appletWorker,
      outboundCredits: initialCredits,  // Bytes applet can send to client
      inboundCredits: initialCredits,   // Bytes client can send to applet
      outboundBuffer: [],               // Buffered chunks from applet (when no credits)
      inboundBuffer: [],                // Buffered chunks from client (when no credits)
      maxBufferSize: 1048576,           // 1MB max buffer per direction
      totalBuffered: { outbound: 0, inbound: 0 },
      maxCredits: initialCredits        // Cap on credit accumulation
    };
    
    this.bidiConnections.set(id, connState);
    
    // Send initial credits to applet
    appletWorker.postMessage({
      type: 'bidi-ready',
      id,
      initialCredits,
      maxChunkSize
    });
  }
  
  async handleAppletFrame(id, frame) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return; // Connection closed
    
    const chunkSize = frame.data?.length || 0;
    
    // Enforce maxChunkSize limit (DoS protection)
    if (chunkSize > this.config.chunking.chunkSize) {
      console.warn(`[${this.processId}] Bidi ${id} chunk exceeds maxChunkSize, terminating`);
      this.closeBidiConnection(id, 'Chunk size exceeded');
      return;
    }
    
    // Check if applet has sufficient credits
    if (conn.outboundCredits < chunkSize) {
      // Insufficient credits - buffer the chunk
      conn.outboundBuffer.push(frame);
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
    await this.sendBidiFrame(id, frame);
    
    // If credits are low, they'll be replenished when operator processes chunks
  }
  
  async handleOperatorFrame(id, frame) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    const chunkSize = frame.data?.length || 0;
    
    // Check if client has sufficient credits to send to applet
    if (conn.inboundCredits < chunkSize) {
      // Insufficient credits - buffer the chunk
      conn.inboundBuffer.push(frame);
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
    conn.worker.postMessage(frame);
    
    // Applet implicitly grants credits by processing chunk
    // When applet finishes processing, responder will grant credits back
  }
  
  async handleAppletCreditGrant(id, credits) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    // Applet grants credits for inbound chunks (client → applet)
    conn.inboundCredits = Math.min(
      conn.inboundCredits + credits,
      conn.maxCredits  // Cap credit accumulation
    );
    
    // Flush buffered inbound chunks
    while (conn.inboundBuffer.length > 0) {
      const frame = conn.inboundBuffer[0];
      const chunkSize = frame.data?.length || 0;
      
      if (conn.inboundCredits < chunkSize) break; // Not enough credits yet
      
      conn.inboundBuffer.shift();
      conn.totalBuffered.inbound -= chunkSize;
      conn.inboundCredits -= chunkSize;
      conn.worker.postMessage(frame);
    }
    
    // Notify operator that client can send more
    await this.sendCreditGrant(id, credits);
  }
  
  async handleOperatorCreditGrant(id, credits) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    // Operator grants credits for outbound chunks (applet → client)
    conn.outboundCredits = Math.min(
      conn.outboundCredits + credits,
      conn.maxCredits
    );
    
    // Flush buffered outbound chunks
    while (conn.outboundBuffer.length > 0) {
      const frame = conn.outboundBuffer[0];
      const chunkSize = frame.data?.length || 0;
      
      if (conn.outboundCredits < chunkSize) break;
      
      conn.outboundBuffer.shift();
      conn.totalBuffered.outbound -= chunkSize;
      conn.outboundCredits -= chunkSize;
      await this.sendBidiFrame(id, frame);
    }
    
    // Notify applet it can send more
    conn.worker.postMessage({
      type: 'bidi-credits',
      id,
      credits
    });
  }
}
```

#### Operator Process (Managing Client Credits)

```javascript
class OperatorProcess {
  async handleBidiUpgrade(id, socket) {
    const maxChunkSize = this.config.chunking.chunkSize;
    const initialCredits = 10 * maxChunkSize;
    
    const connState = {
      socket,
      outboundCredits: initialCredits,  // Bytes responder can send to client
      inboundCredits: initialCredits,   // Bytes client can send to responder
      outboundBuffer: [],
      inboundBuffer: [],
      maxBufferSize: 1048576, // Should be configurable, this is a good default
      totalBuffered: { outbound: 0, inbound: 0 },
      maxCredits: initialCredits
    };
    
    this.bidiConnections.set(id, connState);
  }
  
  async handleResponderFrame(id, frame) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    const chunkSize = frame.data?.length || 0;
    
    // Check credits
    if (conn.outboundCredits < chunkSize) {
      conn.outboundBuffer.push(frame);
      conn.totalBuffered.outbound += chunkSize;
      return;
    }
    
    conn.outboundCredits -= chunkSize;
    
    // Send to client (WebSocket or other transport)
    try {
      await conn.socket.send(frame.data);
      
      // Check transport-specific backpressure (e.g., socket.bufferedAmount for WebSocket)
      if (conn.socket.bufferedAmount && conn.socket.bufferedAmount > 65536) {
        // Socket buffer is filling up - don't grant more credits yet
        return;
      }
      
      // Grant credits back to responder (client consumed the chunk)
      await this.sendCreditGrant(id, chunkSize);
      
    } catch (error) {
      this.closeBidiConnection(id);
    }
  }
  
  async handleClientFrame(id, data) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    const chunkSize = data.length;
    
    // Check credits
    if (conn.inboundCredits < chunkSize) {
      // Client is sending too fast - buffer
      conn.inboundBuffer.push(data);
      conn.totalBuffered.inbound += chunkSize;
      
      if (conn.totalBuffered.inbound > conn.maxBufferSize) {
        // Too much buffered - close connection
        this.closeBidiConnection(id, 'Rate limit exceeded');
      }
      return;
    }
    
    conn.inboundCredits -= chunkSize;
    
    // Forward to responder
    await this.sendToResponder(id, {
      type: 'frame',
      id,
      mode: 'bidi',
      data,
      final: true  // Each transport message is one frame
    });
  }
  
  async handleResponderCreditGrant(id, credits) {
    const conn = this.bidiConnections.get(id);
    if (!conn) return;
    
    // Responder grants credits for inbound (client → responder)
    conn.inboundCredits = Math.min(
      conn.inboundCredits + credits,
      conn.maxCredits
    );
    
    // Flush buffered client chunks
    while (conn.inboundBuffer.length > 0) {
      const data = conn.inboundBuffer[0];
      const chunkSize = data.length;
      
      if (conn.inboundCredits < chunkSize) break;
      
      conn.inboundBuffer.shift();
      conn.totalBuffered.inbound -= chunkSize;
      conn.inboundCredits -= chunkSize;
      
      await this.sendToResponder(id, {
        type: 'frame',
        id,
        mode: 'bidi',
        data,
        final: true
      });
    }
  }
}
```

### Applet API

Applets use a simple API that abstracts credit management:

```javascript
// bidi-echo.esm.js
self.onmessage = async (event) => {
  const { type, id, mode, data, initialCredits, maxChunkSize } = event.data;
  
  if (type === 'request' && event.data.headers['Upgrade']) {
    // Accept bidirectional upgrade (e.g., WebSocket)
    self.postMessage({
      type: 'frame',
      id,
      mode: 'bidi',
      data: null,  // Upgrade response has no body
      final: false,
      keepAlive: true
    });
    
    // Responder will send bidi-ready with initialCredits
    return;
  }
  
  if (type === 'bidi-ready') {
    // Connection ready, we have initialCredits to send data
    console.log(`Bidi connection ready with ${initialCredits} credits (${maxChunkSize} max chunk)`);
    return;
  }
  
  if (type === 'frame' && mode === 'bidi') {
    // Received chunk from client
    const receivedBytes = data?.length || 0;
    
    // Process and echo back
    self.postMessage({
      type: 'frame',
      id,
      mode: 'bidi',
      data: data,   // echo
      final: true
    });
    
    // Grant credits for next inbound chunk (implicit - we processed this one)
    // Responder automatically grants receivedBytes credits when we finish processing
  }
  
  if (type === 'bidi-credits') {
    // Responder granted us more credits to send
    console.log(`Received ${event.data.credits} more credits`);
    // Can now send more data
  }
};
```

### Simplified Alternative: Implicit Credits

For simpler implementation, we can use **implicit credit grants**:

1. **Outbound (Applet → Client)**:
   - Applet sends chunk → consumes `data.length` credits
   - Operator sends chunk to client → grants `data.length` credits back to responder
   - Responder grants `data.length` credits back to applet
   - **No explicit credit messages needed**

2. **Inbound (Client → Applet)**:
   - Client sends data → operator forwards to responder
   - Responder forwards to applet → consumes `data.length` credits
   - Applet processes chunk → implicitly grants `data.length` credits
   - Responder notifies operator → operator allows client to send more
   - **No explicit credit messages needed**

This simplifies the protocol to just frame messages, with credits managed implicitly based on chunk processing.

## Protocol Parameters: The "Rule Book"

All parties need to know the rules to be good citizens. JSMAWS provides protocol parameters during connection establishment.

### Parameter Distribution

**Applet receives all parameters in `bidi-ready`:**
```javascript
{
  type: 'bidi-ready',
  id: 'conn-12345',
  initialCredits: 655360,       // Flow control
  maxChunkSize: 65536,          // Chunk size limit
  maxBytesPerSecond: 10485760,  // Rate limit
  idleTimeout: 60,              // Idle timeout
  maxBufferSize: 1048576        // Buffer limit (informational)
}
```

**Client receives parameters via application-level message:**

The applet can forward relevant parameters to the client:

```javascript
// Applet → Client (first message after connection)
{
  type: 'connection-params',
  maxBytesPerSecond: 10485760,  // 10MB/s - stay below this
  idleTimeout: 60,              // 60s - send keepalive before this
  serverVersion: '1.0.0'        // Optional metadata
}
```

**Why this works:**
- Applet knows the rules (from responder)
- Applet can inform client of relevant rules
- Client doesn't need direct access to server configuration
- Applet can translate/adapt parameters for client's needs

### Parameter Descriptions

- **`initialCredits`**: Initial byte credits for sending (e.g., 640KB)
- **`maxChunkSize`**: Maximum bytes per chunk (e.g., 64KB)
- **`maxBytesPerSecond`**: Rate limit in bytes/second (e.g., 10MB/s)
- **`idleTimeout`**: Idle timeout in seconds (e.g., 60s)
- **`maxBufferSize`**: Buffer limit in bytes (e.g., 1MB) - informational only

### Example: Applet Forwarding Parameters

```javascript
// bidi-echo.esm.js
self.onmessage = async (event) => {
  const { type, id, maxBytesPerSecond, idleTimeout } = event.data;
  
  if (type === 'bidi-ready') {
    // Forward relevant parameters to client
    self.postMessage({
      type: 'frame',
      id,
      mode: 'bidi',
      data: new TextEncoder().encode(JSON.stringify({
        type: 'connection-params',
        maxBytesPerSecond,
        idleTimeout,
        recommendedKeepalive: Math.floor(idleTimeout * 0.5) // 50% of timeout
      })),
      final: true
    });
  }
};
```

### Example: Client Using Parameters

```javascript
// Client-side JavaScript
const socket = new WebSocket('wss://example.com/chat');

let connectionParams = null;
let keepaliveInterval = null;

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.type === 'connection-params') {
    // Store parameters
    connectionParams = message;
    
    // Set up keepalive based on server's idle timeout
    const keepaliveMs = message.recommendedKeepalive * 1000;
    keepaliveInterval = setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, keepaliveMs);
    
    console.log(`Server rate limit: ${message.maxBytesPerSecond / 1048576}MB/s`);
    console.log(`Keepalive every ${message.recommendedKeepalive}s`);
  }
  
  // Handle other messages...
};

socket.onclose = () => {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
  }
};
```

## How Clients and Applets Know Available Capacity

### Applet Perspective (Sending to Client)

**Initial State:**
```javascript
// Applet receives bidi-ready message with all parameters
{
  type: 'bidi-ready',
  id: 'conn-12345',
  initialCredits: 655360,       // 640KB available to send
  maxChunkSize: 65536,          // 64KB max per chunk
  maxBytesPerSecond: 10485760,  // 10MB/s rate limit
  idleTimeout: 60,              // 60s idle timeout
  maxBufferSize: 1048576        // 1MB buffer limit
}
```

**Applet knows:**
1. **Available capacity**: `initialCredits` bytes (e.g., 640KB)
2. **Maximum chunk size**: `maxChunkSize` bytes (e.g., 64KB)
3. **Rate limit**: `maxBytesPerSecond` bytes/second (e.g., 10MB/s)
4. **Idle timeout**: `idleTimeout` seconds (e.g., 60s)
5. **How to be a good citizen**:
   - Send chunks ≤ `maxChunkSize`
   - Track credits consumed (each chunk consumes `data.length` bytes)
   - Stay below `maxBytesPerSecond` rate limit
   - Send keepalive before `idleTimeout` expires
   - Wait for more credits if depleted (responder will send `bidi-credits` message)

**Example - Good Citizen Applet:**
```javascript
let availableCredits = 655360; // From bidi-ready
const maxChunkSize = 65536;

function sendData(data) {
  // Split into chunks if needed
  for (let offset = 0; offset < data.length; offset += maxChunkSize) {
    const chunk = data.slice(offset, offset + maxChunkSize);
    const chunkSize = chunk.length;
    
    // Check if we have credits
    if (availableCredits < chunkSize) {
      // Buffer and wait for more credits
      bufferChunk(chunk);
      return;
    }
    
    // Send chunk
    self.postMessage({
      type: 'frame',
      id: 'conn-12345',
      mode: 'bidi',
      data: chunk,
      final: (offset + chunkSize >= data.length)
    });
    
    // Deduct credits
    availableCredits -= chunkSize;
  }
}

// When responder grants more credits
self.onmessage = (event) => {
  if (event.data.type === 'bidi-credits') {
    availableCredits += event.data.credits;
    flushBufferedChunks(); // Send any buffered data
  }
};
```

### Applet Perspective (Receiving from Client)

**Implicit credit grants:**
- Applet doesn't need to track inbound credits explicitly
- Processing a chunk automatically grants credits back to client
- **How to be a good citizen**: Process chunks promptly to maintain flow

**Example - Good Citizen Applet:**
```javascript
self.onmessage = async (event) => {
  if (event.data.type === 'frame' && event.data.mode === 'bidi') {
    const chunk = event.data.data;
    
    // Process chunk promptly
    await processChunk(chunk);
    
    // Credits automatically granted when this handler completes
    // Client can now send more data
  }
};
```

### Client Perspective (Browser WebSocket)

**Client doesn't see credits directly** - the operator manages flow control:

**Outbound (Client → Applet):**
```javascript
// Client sends WebSocket message
socket.send(data);

// Operator checks credits before forwarding
// If no credits available, operator buffers the message
// Client's WebSocket send() will block if operator's buffer fills
```

**Inbound (Applet → Client):**
```javascript
// Client receives WebSocket message
socket.onmessage = (event) => {
  const data = event.data;
  
  // Process data
  processData(data);
  
  // Operator automatically grants credits when TCP ACK received
  // (TCP flow control provides natural backpressure)
};
```

**How client is a good citizen:**
- Process messages promptly (don't block event loop)
- TCP flow control automatically applies backpressure if client is slow
- Operator detects backpressure via `socket.bufferedAmount` and stops granting credits

### Responder Perspective (Managing Flow)

**Responder tracks credits for both directions:**

```javascript
const connState = {
  outboundCredits: 655360,  // Bytes applet can send to client
  inboundCredits: 655360,   // Bytes client can send to applet
  maxCredits: 655360,       // Cap on credit accumulation
  outboundBuffer: [],       // Buffered when no credits
  inboundBuffer: []         // Buffered when no credits
};
```

**Responder enforces limits:**
1. **Chunk size**: Terminates applet if chunk > `maxChunkSize`
2. **Buffer size**: Closes connection if buffer > `maxBufferSize`
3. **Rate limit**: Closes connection if bytes/sec > `maxBytesPerSecond`
4. **Idle timeout**: Closes connection if no activity for `idleTimeout` seconds

### Operator Perspective (Managing Transport)

**Operator tracks credits and transport backpressure:**

```javascript
const connState = {
  outboundCredits: 655360,  // Bytes responder can send to client
  inboundCredits: 655360,   // Bytes client can send to responder
  socket: websocket,        // Transport (WebSocket, etc.)
  outboundBuffer: []        // Buffered when no credits or transport backpressure
};

// Check transport backpressure (WebSocket example)
if (socket.bufferedAmount > 65536) {
  // Transport buffer filling - don't grant more credits yet
  // Wait for buffer to drain before granting credits
}
```

### Summary: Being a Good Citizen

**Applet (Sending):**
1. Track available credits (from `bidi-ready` and `bidi-credits` messages)
2. Send chunks ≤ `maxChunkSize`
3. Stop sending when credits depleted
4. Resume when more credits granted

**Applet (Receiving):**
1. Process chunks promptly (don't block)
2. Credits automatically granted on completion

**Client (Browser):**
1. Process messages promptly
2. TCP flow control automatically applies backpressure
3. No explicit credit management needed
4. **Receive protocol parameters from applet** (via first message)

**Client Conditions That Trigger Termination:**

A "good client" avoids termination by:

1. **Rate Limit Violation** (Sending too fast)
   - **Trigger**: Client sends > `maxBytesPerSecond` (from protocol parameters)
   - **Client knows limit**: Applet sends `connection-params` message with `maxBytesPerSecond`
   - **How to avoid**:
     - Track bytes sent per second (rolling window)
     - Throttle if approaching limit (e.g., at 80% of limit)
     - Respect natural backpressure (if `send()` blocks, wait)
   - **Example**: If limit is 10MB/s, don't send more than 10MB in any 1-second window

2. **Buffer Overflow** (Sending while server is backpressured)
   - **Trigger**: Operator's inbound buffer exceeds `maxBufferSize`
   - **Client knows limit**: Applet sends `connection-params` message with `maxBufferSize` (informational)
   - **How to avoid**:
     - Process server responses promptly (don't block)
     - TCP flow control naturally prevents this (send() will block)
     - Don't queue unlimited messages client-side
   - **Metrics needed**: None - TCP handles this automatically
   - **Example**: If you try to send 2MB while server is slow, TCP will block your sends

3. **Idle Timeout** (No activity)
   - **Trigger**: No messages sent or received for `idleTimeout` seconds
   - **Client knows timeout**: Applet sends `connection-params` message with `idleTimeout` and `recommendedKeepalive`
   - **How to avoid**:
     - Set up `setInterval()` to send keepalive at `recommendedKeepalive` interval
     - Or accept that idle connections will be closed (reconnect as needed)
   - **Example**: If timeout is 60s, send keepalive every 30s (50% of timeout)

4. **Protocol Violation** (Malformed messages)
   - **Trigger**: Sending invalid WebSocket frames or violating protocol
   - **How to avoid**:
     - Use standard WebSocket client library (handles protocol correctly)
     - Don't try to manually construct WebSocket frames
   - **Example**: Sending corrupted binary data

**In Practice:**
- Most well-behaved clients never hit these limits
- TCP flow control naturally prevents rate limit violations
- Browser WebSocket APIs handle protocol correctly
- Main concern is idle timeout (implement keepalive based on `connection-params`)
- Applet acts as intermediary, translating server rules for client

**Responder:**
1. Enforce chunk size limits
2. Enforce buffer limits
3. Enforce rate limits
4. Grant credits when chunks processed

**Operator:**
1. Monitor transport backpressure (e.g., `socket.bufferedAmount`)
2. Grant credits only when transport ready
3. Buffer when transport or credits unavailable

### Why Implicit Credits Work

The key insight is that **processing speed naturally controls flow**:

1. **Fast applet**: Processes chunks quickly → credits granted quickly → high throughput
2. **Slow applet**: Processes chunks slowly → credits granted slowly → natural backpressure
3. **Fast client**: Consumes data quickly → TCP ACKs quickly → credits granted quickly
4. **Slow client**: Consumes data slowly → TCP backpressure → operator stops granting credits

No explicit coordination needed - the system self-regulates based on actual processing capacity.

### Why Implicit Credits Are Better

**Advantages**:
1. **Simpler protocol**: No separate credit message type needed
2. **Lower latency**: Credits piggyback on data frames (no extra round-trips)
3. **Automatic flow control**: Processing speed naturally controls credit grants
4. **Prevents credit exhaustion**: Applet can't "forget" to grant credits (it's automatic)
5. **Easier to implement**: Less state to track, fewer edge cases

**Potential Downsides**:
1. **Less explicit control**: Applet can't strategically withhold credits
   - **Mitigation**: Not needed - processing speed provides natural backpressure
2. **Requires chunk-level tracking**: Must track every chunk processed
   - **Mitigation**: Already required for security (DoS protection)

**Verdict**: Implicit credits are clearly superior for JSMAWS. The automatic nature prevents bugs and simplifies implementation while providing the same flow control benefits.

## Configuration Parameters

All flow control parameters should be configurable in the SLID configuration:

```slid
bidiFlowControl=[
  initialCredits=10          # Initial credit multiplier (× maxChunkSize)
  maxBufferSize=1048576      # 1MB max buffer per direction per connection
  maxBytesPerSecond=10485760 # 10MB/s rate limit per connection
  idleTimeout=60             # 60 seconds idle timeout
  maxChunkSize=65536         # 64KB max chunk size (from chunking config)
]
```

**Parameter Descriptions**:

- **`initialCredits`**: Multiplier for initial credit grant (default: 10)
  - Actual initial credits = `initialCredits × maxChunkSize`
  - Example: 10 × 64KB = 640KB initial burst capacity
  - Higher values allow larger bursts but use more memory

- **`maxBufferSize`**: Maximum buffered data per direction per connection (default: 1048576 bytes / 1MB)
  - Protects against memory exhaustion when credits are depleted
  - Connection closed if buffer exceeds this limit
  - Should be ≥ `initialCredits × maxChunkSize` to avoid premature closes

- **`maxBytesPerSecond`**: Rate limit per connection (default: 10485760 bytes / 10MB/s)
  - Prevents bandwidth exhaustion attacks
  - Measured as rolling average over 1-second windows
  - Connection closed if rate exceeded

- **`idleTimeout`**: Maximum idle time in seconds (default: 60)
  - Connection closed if no chunks sent/received for this duration
  - Prevents resource leaks from abandoned connections
  - Set to 0 to disable (not recommended)

- **`maxChunkSize`**: Maximum chunk size in bytes (default: 65536 / 64KB)
  - Inherited from `chunking.chunkSize` configuration
  - Enforced on all chunks from applets
  - Applet terminated if exceeded (DoS protection)

## Security Considerations

### 1. Buffer Overflow Protection

```javascript
// Maximum buffered data per connection per direction
const MAX_BUFFER_SIZE = 1048576; // 1MB

if (totalBuffered > MAX_BUFFER_SIZE) {
  closeConnection('Buffer overflow');
}
```

### 2. Rate Limiting

```javascript
// Maximum bytes per second per connection
const MAX_BYTES_PER_SECOND = 10485760; // 10MB/s

if (bytesThisSecond > MAX_BYTES_PER_SECOND) {
  closeConnection('Rate limit exceeded');
}
```

### 3. Chunk Size Enforcement

```javascript
// Maximum chunk size (from configuration)
const maxChunkSize = config.chunking.chunkSize; // e.g., 65536

if (chunk.data.length > maxChunkSize) {
  terminateApplet();
  closeConnection('Chunk size exceeded');
}
```

### 4. Timeout Enforcement

```javascript
// Maximum idle time (no chunks in either direction)
const IDLE_TIMEOUT = 60000; // 60 seconds

if (Date.now() - lastChunkTime > IDLE_TIMEOUT) {
  closeConnection('Idle timeout');
}
```

### 5. Credit Exhaustion (Not Applicable with Implicit Credits)

**With explicit credits**, an applet could maliciously or accidentally fail to grant credits, causing the connection to deadlock.

**With implicit credits**, this is impossible:
- Processing a chunk automatically grants credits
- If applet stops processing, it stops receiving chunks (natural backpressure)
- No special detection or timeout needed
- Connection remains healthy as long as applet is responsive

This is a major advantage of the implicit credit approach - it eliminates an entire class of bugs and attacks.

## Performance Characteristics

### Latency

- **Implicit credits**: 0 additional round-trips (credits piggyback on chunks)
- **Explicit credits**: 1 round-trip per credit grant (only when needed)
- **Compared to TCP**: Same latency (application-level credits mirror TCP window)

### Throughput

- **Initial burst**: 640KB (10 × 64KB chunks, configurable)
- **Sustained**: Limited by processing speed (natural backpressure)
- **Maximum**: Limited by `MAX_BYTES_PER_SECOND` (security)

### Memory Usage

- **Per connection**: 2 × `MAX_BUFFER_SIZE` (inbound + outbound buffers)
- **1000 connections**: ~2GB maximum (with 1MB buffers)
- **Typical**: Much less (buffers only fill under backpressure)

## Implementation Plan

### Phase 1: Basic Credit System (Implicit)

1. Add credit tracking to responder bidi connection state
2. Implement byte-based credit consumption
3. Implement implicit credit grants (grant `data.length` per processed chunk)
4. Add buffer overflow protection
   - Warn on configure/update if configured limit is less than initial credit grant
5. Test with simple echo applet

### Phase 2: Operator Integration

1. Add credit tracking to operator bidi connection state
2. Implement backpressure detection (transport-specific, e.g., `socket.bufferedAmount`)
3. Add rate limiting (bytes per second)
4. Test with high-throughput streaming

### Phase 3: Explicit Credits (Optional)

1. Add `bidi-credits` message type
2. Implement explicit credit grant API for applets
3. Add credit exhaustion detection
4. Test with slow consumers

### Phase 4: Security Hardening

1. Add timeout enforcement
2. Add hostile applet tests (never grants credits, floods chunks)
3. Add hostile client tests (floods chunks, ignores backpressure)
4. Performance testing under load

## Transport Integration

### WebSocket

The operator maps WebSocket messages to/from bidi protocol:

```javascript
// WebSocket → Bidi
socket.on('message', (data) => {
  // Each WebSocket message becomes one bidi frame
  handleClientFrame(id, data);
});

// Bidi → WebSocket
async function sendBidiFrame(id, frame) {
  const conn = bidiConnections.get(id);
  await conn.socket.send(frame.data);
}
```

**Key Points**:
- WebSocket opcodes (text/binary/close/ping/pong) are handled by operator
- Applet only sees generic bidi frames
- Operator translates between WebSocket protocol and bidi protocol

### Future Transports

The protocol is designed to work with any bidirectional transport:

- **HTTP/2 Server Push**: Bidirectional streams
- **QUIC**: Multiple bidirectional streams
- **Custom IPC**: Process-to-process communication
- **gRPC Streaming**: Bidirectional RPC

## Comparison to Alternatives

| Approach | Latency | Complexity | Security | Applicability |
|----------|---------|------------|----------|---------------|
| **Credit-based (our design)** | Low | Medium | Excellent | ✅ Perfect fit |
| WebStreams API | Low | High | Good | ⚠️ Internal only |
| HTTP/2 flow control | Low | High | Excellent | ✅ Inspiration |
| Socket.IO acks | High | Low | Good | ✅ Good pattern |

## References

- [RFC 7540 - HTTP/2 Flow Control](https://tools.ietf.org/html/rfc7540#section-5.2)
- [WHATWG Streams Standard](https://streams.spec.whatwg.org/)
- [Socket.IO Documentation](https://socket.io/docs/v4/)
- [`arch/unified-protocol-assessment.md`](unified-protocol-assessment.md) - Unified protocol design
- [`arch/frame-based-protocol.md`](frame-based-protocol.md) - Frame-based protocol
- [`arch/applet-protocol.md`](applet-protocol.md) - Applet communication protocol

[supplemental keywords: flow control, backpressure, credit-based flow control, window-based flow control, rate limiting, buffer management, bidirectional flow control, application-level flow control, streaming flow control, DoS protection, memory safety, multi-tenant isolation, transport-agnostic protocol]