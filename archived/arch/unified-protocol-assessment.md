# Unified Applet Protocol Assessment

**Status**: [DRAFT]

## Terminology (from brief.md)

- **Frame**: Application message unit (content/size by agreement between applet and client)
  - Examples: One HTTP response body, one SSE event, one WebSocket message
- **Chunk**: Portion of a frame (max data applet sends per I/O operation)
  - Limited by `maxChunkSize` for flow-control and resource management
- **Standard response**: ONE frame (sent in as many chunks as needed)
- **Streaming response**: MANY frames over time (each sent in chunks)

## Context

JSMAWS needs a single, unified protocol for applet-to-responder communication that:
- Has NO backward compatibility constraints (fresh implementation)
- Assumes hostile, poorly-behaved user applets
- Protects all tenants from one bad applet
- Provides crash-proof operation under adversarial conditions
- Supports HTTP, SSE, and WebSocket without bypassing security

## Current State Analysis

### Unified Frame Protocol (Clean Slate)

**Single Message Type:** `frame`

All communication uses the `frame` message type with context-sensitive fields:

1. **First frame**: Includes `mode`, `status`, `headers`, establishes connection type
2. **Subsequent frames**: Minimal - only `id`, `data`, optionally `final`, `keepAlive` (if changing state)
3. **Sticky state**: `mode` and `keepAlive` persist across frames (don't repeat unless changing)

**Legacy Protocols Removed** (No backward compatibility needed):
- ❌ `response` message type → Unified into `frame` (first frame includes status/headers)
- ❌ `chunk` message type → Replaced by `frame`
- ❌ `stream-data`/`stream-close` → Replaced by `frame` with `mode: 'stream'`
- ❌ `ws-upgrade`/`ws-send`/`ws-close` → Replaced by `frame` with `mode: 'bidi'`
- ❌ `bidi-ready` message type → Integrated into `frame` (protocol params in first frame from responder)
- ❌ `wsOpcode` field → Transport-specific, handled by operator

### Communication Flow Patterns

**HTTP/SSE (Unidirectional: Applet → Responder → Operator → Client)**
```
Request:  Operator → Responder → Applet
Response: Applet → Responder → Operator → Client
```

**WebSocket (Bidirectional: Client ↔ Applet)**
```
Upgrade:  Client → Operator → Responder → Applet (request with Upgrade headers)
Accept:   Applet → Responder → Operator → Client (frame with status 101)
Params:   Responder → Applet (frame with protocol parameters)
To Client: Applet → Responder → Operator → Client
To Applet: Client → Operator → Responder → Applet
```

## Security Requirements

### Critical Properties

1. **Resource Isolation**: One applet's misbehavior cannot affect others
2. **DoS Protection**: Buffer limits, rate limits, timeout enforcement
3. **Validation**: All messages from applets validated before forwarding
4. **No Bypass**: WebSocket cannot circumvent security controls
5. **Memory Safety**: Bounded buffers prevent memory exhaustion
6. **Worker Lifecycle**: Responder controls all worker creation/termination

### Attack Vectors

**From Malicious Applets:**
1. Send oversized chunks (memory exhaustion)
2. Send chunks too rapidly (CPU/bandwidth DoS)
3. Hold connections open indefinitely (resource exhaustion)
4. Ignore incoming WebSocket messages (deadlock)
5. Send malformed data (crash responder)

**Protection Requirements:**
- `maxChunkSize`: Hard limit on chunk size per I/O operation (DoS protection)
- `autoChunkThresh`: Automatic forwarding threshold when accumulating chunks (memory safety)
- `reqTimeout`: Maximum request/connection duration
- `maxWorkers`: Limit concurrent applets per responder
- Message validation: Type and structure checking before forwarding

## Unified Frame Protocol Design

### Frame Message Structure

**Fields:**
- `type: 'frame'` - Always 'frame' (for future protocol versioning)
- `id: string` - Request/connection ID (required in all frames)
- `data: Uint8Array | null` - Frame chunk (up to `maxChunkSize` per message)
- `final: boolean` - Last chunk of current frame (optional, defaults to `false` if omitted)
- `keepAlive: boolean` - Connection stays open after this frame (sticky state, optional after first frame)
- `mode: string` - Connection mode: 'response', 'stream', 'bidi' (only in first frame)
- `status: number` - HTTP status code (only in first frame)
- `headers: object` - HTTP headers (only in first frame)

**Protocol Parameters** (bidi mode only, sent by responder in first frame):
- `initialCredits: number` - Initial byte credits for sending
- `maxChunkSize: number` - Maximum bytes per chunk
- `maxBytesPerSecond: number` - Rate limit (bytes/second)
- `idleTimeout: number` - Idle timeout (seconds)
- `maxBufferSize: number` - Buffer limit (bytes)

### Connection Modes

#### Mode: 'response' (Regular HTTP)

```javascript
// First frame (establishes connection and includes HTTP semantics)
{
  type: 'frame',
  id: 'req-12345',
  mode: 'response',      // Only in first frame
  status: 200,           // Only in first frame
  headers: {...},        // Only in first frame
  data: Uint8Array,
  // final: false,       // This is the default
  keepAlive: false       // Sticky state
}

// Subsequent frames (minimal) - final defaults to false
{
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array
  // mode omitted (already established)
  // status/headers omitted (not needed)
  // keepAlive omitted (sticky - still false)
  // final omitted (defaults to false)
}

// Final frame - explicitly mark as final
{
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,
  final: true
  // keepAlive still false (sticky)
}
```

**Flow:**
1. Applet sends first frame with mode, status, headers, keepAlive
2. Applet sends subsequent frames with only id, data, final
3. Applet marks last chunk with `final: true`
4. Responder accumulates chunks, forwards with chunking optimization
5. Worker terminated (keepAlive: false + final: true = response complete)

**Semantics:**
- `mode: 'response'` implies ONE frame
- `final: true` = end of frame = end of response
- `keepAlive: false` (default) = close after response

**Security:**
- `maxChunkSize` enforced per chunk (DoS protection)
- `reqTimeout` enforced for total request duration
- Chunk accumulation limited by `autoChunkThresh` (starts forwarding immediately)
- Worker terminated after `final: true` (since keepAlive: false)

#### Mode: 'stream' (SSE, Long-Polling)

```javascript
// First frame (establishes streaming connection)
{
  type: 'frame',
  id: 'req-12345',
  mode: 'stream',
  status: 200,
  headers: {...},
  data: null,            // Headers only
  // final: false,       // Default
  keepAlive: true        // Sticky state
}

// First event frame
{
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,
  final: true            // End of this event
  // mode omitted (already established)
  // keepAlive omitted (sticky - still true)
}

// Second event frame (later in time)
{
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,
  final: true
  // keepAlive still true (sticky)
}

// Stream close (orderly shutdown) - last frame changes keepAlive
{
  type: 'frame',
  id: 'req-12345',
  data: null,
  final: true,
  keepAlive: false       // Override sticky state to close
}
```

**Flow:**
1. Applet sends first frame with `mode: 'stream'`, `keepAlive: true`
2. Applet sends multiple frames over time
3. Each frame sent as one or more chunks (up to `maxChunkSize` each)
4. Last chunk of each frame marked with `final: true`
5. Last frame changes `keepAlive` to `false` to signal end of stream

**Semantics:**
- `keepAlive: true` = more frames coming later
- `keepAlive: false` on `final: true` chunk = last frame, close connection
- Each frame is independent (e.g., one SSE event)

**Security:**
- `maxChunkSize` enforced per chunk
- `reqTimeout` still enforced (can be higher for streams)
- Rate limiting on frames (not chunks)
- Responder can force-close based on frame rate
- Worker kept alive until explicit close or timeout

#### Mode: 'bidi' (Bidirectional)

```javascript
// Applet accepts WebSocket upgrade (first frame from applet)
{
  type: 'frame',
  id: 'req-12345',
  mode: 'bidi',
  status: 101,           // Switching Protocols
  headers: {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Accept': '...'
  },
  data: null,
  keepAlive: true
}

// Responder sends protocol parameters (first frame from responder)
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
  keepAlive: true
}

// Bidirectional frames (applet → client)
{
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,
  final: true            // Each WebSocket message is one frame
  // mode omitted (already established)
  // keepAlive omitted (sticky - still true)
}

// Bidirectional frames (client → applet)
{
  type: 'frame',
  id: 'req-12345',
  data: Uint8Array,
  final: true
}

// Close connection (either side)
{
  type: 'frame',
  id: 'req-12345',
  data: null,
  final: true,
  keepAlive: false       // Override sticky state to close
}
```

**Flow:**
1. Client sends WebSocket upgrade request
2. Applet receives normal `request` message with upgrade headers
3. Applet validates and sends first frame (accept with status 101, or reject with 4xx)
4. If accepted, responder sends protocol parameters in its first frame
5. Bidirectional frame exchange with credit-based flow control
6. Either side can close by sending final frame with `keepAlive: false`

**Security:**
- `maxChunkSize` enforced per chunk
- Credit-based flow control prevents buffer exhaustion (see [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md))
- Rate limiting on bytes per second (not frames)
- Worker terminated if it stops responding to incoming chunks
- Timeout if no activity for N seconds
- Buffer limits enforced per direction per connection

### WebSocket Upgrade Flow

**Complete Sequence:**

```
1. Client initiates upgrade:
   GET /chat HTTP/1.1
   Upgrade: websocket
   Connection: Upgrade
   Sec-WebSocket-Key: ...

2. Operator → Responder → Applet:
   {
     type: 'request',
     id: 'req-12345',
     method: 'GET',
     path: '/chat',
     headers: {
       'Upgrade': 'websocket',
       'Connection': 'Upgrade',
       ...
     }
   }

3a. Applet ACCEPTS:
    {
      type: 'frame',
      id: 'req-12345',
      mode: 'bidi',
      status: 101,
      headers: {...},
      data: null,
      keepAlive: true
    }

3b. OR Applet REJECTS:
    {
      type: 'frame',
      id: 'req-12345',
      mode: 'response',
      status: 403,
      headers: {...},
      data: new TextEncoder().encode('Forbidden'),
      final: true,
      keepAlive: false
    }

4. If accepted, Responder → Applet (protocol parameters):
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
     keepAlive: true
   }

5. Bidirectional communication begins
```

**Key Points:**
- Client initiates (not applet)
- Applet receives normal `request` message
- Applet can accept OR reject
- Responder sends protocol parameters immediately after acceptance
- Operator handles WebSocket protocol details (opcodes, framing, etc.)

### Bidirectional Flow (Bidi Mode)

**To Client (Applet → Responder → Operator → Client):**
```
Applet: postMessage({ type: 'frame', data: chunk, final: true })
Responder: Validates chunk size, checks credits
Responder: Consumes credits (data.length bytes)
Responder: Forwards via IPC to operator
Operator: Forwards to client (WebSocket or other transport)
Operator: Grants credits back when client consumes data (implicit)
```

**To Applet (Client → Operator → Responder → Applet):**
```
Client: Sends data (e.g., WebSocket message)
Operator: Receives via transport API
Operator: Checks credits, forwards via IPC to responder
Responder: Checks credits, creates frame message
Responder: Consumes credits (data.length bytes)
Responder: postMessage to applet worker
Applet: Processes chunk, implicitly grants credits
```

**Credit-Based Flow Control:**
- Each chunk consumes credits equal to its byte size
- Initial credits: 10 × maxChunkSize (e.g., 640KB)
- Credits automatically granted when chunks are processed (implicit)
- Prevents buffer exhaustion and provides natural backpressure
- See [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) for complete design

### Security Enforcement Points

**Responder Process (Primary Security Boundary):**

1. **Chunk Size Validation (DoS Protection)**
   ```javascript
   // Enforce maxChunkSize limit on every chunk from applet
   if (chunkData && chunkData.length > maxChunkSize) {
     console.warn(`Chunk exceeds maxChunkSize (${chunkData.length} > ${maxChunkSize}), terminating applet`);
     terminateApplet();
     return error(500, 'Internal Server Error');
   }
   ```

2. **Frame Accumulation Limit (Memory Safety)**
   ```javascript
   // Accumulate chunks into frames
   frameBuffer.push(chunkData);
   totalBuffered += chunkData.length;
   
   // Start forwarding if accumulated data exceeds threshold
   if (totalBuffered >= autoChunkThresh) {
     flushFrameBuffer(); // Forward to operator immediately
   }
   ```

3. **Mode-Specific Validation**
   ```javascript
   if (mode === 'bidi') {
     // Validate credit availability
     if (outboundCredits < chunkSize) {
       bufferChunk(); // Buffer until credits available
     }
   }
   ```

4. **Rate Limiting (Bytes per Second)**
   ```javascript
   // Track bytes sent per second (rolling average)
   if (bytesSentLastSecond > maxBytesPerSecond) {
     slowDown(); // Add backpressure or terminate
   }
   ```

5. **Timeout Enforcement**
   ```javascript
   setTimeout(() => {
     if (worker.isActive()) {
       terminateApplet();
       sendError(504, 'Gateway Timeout');
     }
   }, reqTimeout * 1000);
   ```

6. **Inbound Message Handling (Bidi Mode)**
   ```javascript
   // Responder forwards client messages to applet as frames
   operator.onClientMessage((id, data) => {
     const conn = bidiConnections.get(id);
     if (!conn) return; // Already closed
     
     const chunkSize = data.length;
     
     // Check credits before forwarding
     if (conn.inboundCredits < chunkSize) {
       bufferInbound(id, data); // Buffer until credits available
       return;
     }
     
     // Consume credits and forward
     conn.inboundCredits -= chunkSize;
     conn.worker.postMessage({
       type: 'frame',
       id,
       data: data,
       final: true
     });
     
     // Credits automatically granted when applet processes chunk (implicit)
   });
   ```

**Note:** Credit-based flow control prevents buffer exhaustion. See [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md).

### Applet Worker Lifecycle

**Regular HTTP (One-Shot):**
```
1. Responder spawns worker
2. Worker sends first frame with mode='response'
3. Worker sends subsequent frames
4. Worker sends final frame
5. Responder terminates worker
```

**SSE Streaming (Long-Lived):**
```
1. Responder spawns worker
2. Worker sends first frame with mode='stream', keepAlive=true
3. Worker sends frames over time
4. Worker sends final frame with keepAlive=false (or timeout)
5. Responder terminates worker
```

**Bidi (Bidirectional Long-Lived):**
```
1. Responder spawns worker
2. Worker sends first frame with mode='bidi' (accept upgrade)
3. Responder sends protocol parameters in first frame
4. Bidirectional frame exchange with credit-based flow control
5. Either side closes (final: true, keepAlive: false)
6. Responder terminates worker
```

## Benefits of Unified Frame Design

### Simpler Protocol
- **One message type**: Single handler for all applet messages
- **Fewer code paths**: Less complexity, fewer bugs
- **Consistent validation**: Same rules apply to all frames

### Smaller Messages
- **First frame**: Includes all setup (mode, status, headers)
- **Subsequent frames**: Minimal (id, data, final)
- **Sticky state**: Don't repeat mode or keepAlive unless changing

### Easier Implementation
- **Context-sensitive fields**: First frame has more fields, subsequent frames are minimal
- **No separate handlers**: One `handleFrame()` method handles all modes
- **Simpler state management**: Mode and keepAlive are sticky

### Better Security
- **Single validation path**: All frames validated the same way
- **Consistent enforcement**: Same limits apply to all modes
- **Fewer edge cases**: Less attack surface

## Migration Plan

### Phase 1: Unified Frame Protocol (Current Task)

- [x] Finalize unified frame protocol specification
- [ ] Implement frame handler with first-frame detection
- [ ] Add mode-specific validation (response, stream, bidi)
- [ ] Implement sticky state tracking (mode, keepAlive)
- [ ] Update static content applet to use unified frames
- [ ] Remove legacy message types (`response`, `bidi-ready`)

### Phase 2: Streaming Support

- [ ] Implement mode='stream' with multi-frame support
- [ ] Test SSE with unified frame protocol
- [ ] Verify frame rate limiting (not chunk limiting)
- [ ] Test timeout enforcement

### Phase 3: Bidirectional Support

- [ ] Implement mode='bidi' validation
- [ ] Add credit-based flow control (see [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md))
- [ ] Add bidirectional message routing (client→applet)
- [ ] Implement byte-based rate limiting
- [ ] Test with hostile applets (oversized chunks, credit exhaustion attempts)
- [ ] Add WebSocket upgrade flow (accept/reject)

### Phase 4: Clean Implementation (No Legacy Support)

Since there are no legacy applets, we implement a clean slate:

**Remove Entirely (Never Implement):**
- [x] ~~`response` message type~~ - Unified into `frame`
- [x] ~~`chunk` message type~~ - Replaced by `frame`
- [x] ~~`stream-data`/`stream-close` message types~~ - Replaced by `frame` with `mode: 'stream'`
- [x] ~~`ws-upgrade`/`ws-send`/`ws-close` message types~~ - Replaced by `frame` with `mode: 'bidi'`
- [x] ~~`bidi-ready` message type~~ - Integrated into `frame` (protocol params in first frame)
- [x] ~~`wsOpcode` field~~ - Transport-specific, handled by operator

**Implement Only:**
- [x] `frame` - Unified frame protocol (modes: `response`, `stream`, `bidi`)
- [x] `error` - Error responses

**Documentation:**
- [x] Update [`arch/frame-based-protocol.md`](frame-based-protocol.md) with unified design
- [ ] Update [`arch/frame-implementation-plan.md`](frame-implementation-plan.md) with refined protocol
- [ ] Remove references to legacy message types from all docs

## Security Verification Checklist

- [ ] Oversized chunk detection and rejection (≤ maxChunkSize)
- [ ] Frame accumulation limits enforced (autoChunkThresh)
- [ ] Timeout enforcement for all connection types
- [ ] Rate limiting for frames (not chunks)
- [ ] Malformed message rejection
- [ ] Worker lifecycle properly managed
- [ ] No resource leaks on error paths
- [ ] DoS scenarios tested and mitigated
- [ ] Multi-tenant isolation verified
- [ ] Inbound bidi message credit management works correctly
- [ ] Credit-based flow control prevents buffer exhaustion
- [ ] Byte-based rate limiting enforced
- [ ] WebSocket upgrade accept/reject flow works correctly

## References

- [`arch/frame-based-protocol.md`](frame-based-protocol.md) - Unified frame protocol specification
- [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) - Bidirectional flow control design
- [`arch/applet-protocol.md`](applet-protocol.md) - Applet communication protocol
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) - Responder implementation

[supplemental keywords: security, multi-tenant, DoS protection, resource limits, protocol unification, adversarial applets, bidirectional protocol, flow control, credit-based flow control, unified frame design, sticky state, context-sensitive fields, WebSocket upgrade, accept/reject]
