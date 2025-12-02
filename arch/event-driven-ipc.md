# Event-Driven IPC Architecture

**Status:** [APPROVED]
**Created:** 2025-12-01
**Implemented:** 2025-12-01
**Purpose:** Refactor IPC communication to be fully event-driven with continuous monitoring

## Problem Statement

The current IPC architecture has a critical flaw: the operator only reads from responder stdout when waiting for a response to a specific request. This causes:

1. **Lost console output**: Responder startup logging sits in stdout buffer unread
2. **Blocking architecture**: Request handlers block waiting for responses
3. **No asynchronous events**: Cannot handle unsolicited messages from service processes
4. **Competing readers**: Cannot have both console monitoring and request/response flows

### Current Flow (Broken)

```
Operator                          Responder
   |                                 |
   |--spawn process---------------->|
   |--CONFIG_UPDATE---------------->|
   |                                 |--console.log (buffered, unread)
   |                                 |--process messages loop
   |                                 |
   |--WEB_REQUEST (first request)-->|
   |                                 |--handle request
   |<--WEB_FRAME (response)----------|
   |  (NOW reads stdout, gets       |
   |   buffered console output)     |
```

## Solution: Event-Driven IPC with Stream Handlers

### Architecture Overview

Replace synchronous request/response with asynchronous event-driven communication using stream handlers:

1. **Continuous Monitoring**: Background task always reading from stdout/stderr
2. **Stream Handlers**: Each request gets a handler that receives multiple frames
3. **Message Routing**: Central dispatcher routes frames to appropriate stream handlers
4. **Request Correlation**: Track active streams by request ID

### New Flow (Event-Driven)

```
Operator                          Responder
   |                                 |
   |--spawn process---------------->|
   |--start stdout monitor--------->|
   |  (background task)              |
   |                                 |
   |--CONFIG_UPDATE---------------->|
   |                                 |--console.log
   |<--console output (immediate)----|
   |  (via callback)                 |
   |                                 |--process messages loop
   |                                 |
   |--WEB_REQUEST------------------>|
   |  (register stream handler)      |
   |                                 |--handle request
   |<--console output (immediate)----|
   |  (via callback)                 |
   |<--WEB_FRAME (chunk 1)-----------|
   |  (handler called)               |
   |<--WEB_FRAME (chunk 2)-----------|
   |  (handler called)               |
   |<--WEB_FRAME (final)-------------|
   |  (handler called, cleanup)      |
```

## Implementation Plan

### Phase 1: IPCConnection Refactoring

**File:** [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js)

#### 1.1 Add Stream Handler Registry

```javascript
export class IPCConnection {
    constructor(conn) {
        // ... existing fields ...
        this.streamHandlers = new Map(); // requestId -> handler function
        this.globalHandlers = new Map(); // messageType -> handler function
        this.monitoring = false;
    }

    /**
     * Register handler for specific request stream
     * Handler receives multiple frames until stream completes
     * @param {string} requestId Request ID
     * @param {Function} handler (message, binaryData) => void | Promise<void>
     * @param {number} timeout Timeout in milliseconds
     */
    registerStreamHandler(requestId, handler, timeout = 30000) {
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
    unregisterStreamHandler(requestId) {
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
    onMessage(type, handler) {
        this.globalHandlers.set(type, handler);
    }

    /**
     * Start continuous monitoring (background task)
     */
    async startMonitoring() {
        if (this.monitoring) return;
        this.monitoring = true;

        while (this.monitoring && !this.closed) {
            try {
                const result = await this.readMessage();
                if (!result) break; // Connection closed

                const { message, binaryData } = result;
                
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
    stopMonitoring() {
        this.monitoring = false;
        
        // Cleanup all pending streams
        for (const [requestId, entry] of this.streamHandlers) {
            clearTimeout(entry.timeout);
            entry.handler(new Error('Connection closed'), null);
        }
        this.streamHandlers.clear();
    }
}
```

#### 1.2 Console Output Handling

Console output continues to be handled via callback in `readMessage()` (already works correctly).

### Phase 2: ProcessManager Integration

**File:** [`src/process-manager.esm.js`](../src/process-manager.esm.js)

#### 2.1 Start Monitoring on Spawn

```javascript
async spawnProcess(type, poolName, poolConfig) {
    // ... existing spawn code ...

    // Set console output handler for stdout
    ipcConn.setConsoleOutputHandler((text, logLevel) => {
        this.logger[logLevel](`[${processId}] ${text}`);
    });

    // Register global handlers for unsolicited messages
    ipcConn.onMessage(MessageType.HEALTH_CHECK, async (message, binaryData) => {
        await this.handleHealthCheckResponse(processId, message, binaryData);
    });

    // Start continuous monitoring (background task)
    ipcConn.startMonitoring();

    // ... rest of spawn code ...
}
```

#### 2.2 Capacity Tracking Integration

**Design Decision: Integrate capacity with health checks**

Capacity information is provided through two mechanisms:

1. **Piggybacked on every message** (real-time during active requests)
2. **Included in health check responses** (periodic updates during idle periods)

**Message Structure with Capacity Metadata:**

```javascript
// SLID format: capacity as named parameter at message level
[(WFRM id=req-123 capacity=[availableWorkers=5 totalWorkers=10]
  [status=200 headers=[...] ...]
]
```

**IPC Protocol Changes:**

```javascript
// In createMessage() - add capacity parameter
export function createMessage({ type, id, capacity }, fields = {}) {
    const message = new NANOS(type, { id });
    message.setOpts({ transform: true });
    if (capacity) {
        message.push({ capacity });  // Add as named parameter
    }
    message.push([fields]);
    return message;
}

// In parseMessage() - extract capacity
export function parseMessage(slidText) {
    const message = parseSLID(slidText);
    const type = message.at(0);
    const id = message.at('id');
    const capacity = message.at('capacity');  // Extract capacity metadata
    const fields = message.at(1);
    
    return { type, id, capacity, fields };
}
```

**Monitoring Loop Integration:**

```javascript
async startMonitoring() {
    while (this.monitoring && !this.closed) {
        const result = await this.readMessage();
        if (!result) break;

        const { message, binaryData } = result;
        
        // Update capacity from message metadata (if present)
        if (message.capacity) {
            this.onCapacityUpdate?.(message.capacity);
        }
        
        // Route message to appropriate handler
        // ... existing routing logic ...
    }
}
```

**Health Check Response:**

```javascript
// In responder process
async handleHealthCheck(id, fields) {
    const response = new NANOS(MessageType.HEALTH_CHECK, {
        id,
        capacity: {  // Include current capacity
            availableWorkers: this.bpAvailWorkers(),
            totalWorkers: this.maxConcurrentRequests
        }
    });
    response.setOpts({ transform: true });
    response.push([{
        timestamp: fields.at('timestamp'),
        status: 'ok',
        uptime: Math.floor(performance.now() / 1000),
        activeRequests: this.activeRequests.size,
        // ... other health metrics ...
    }]);
    
    await this.ipcConn.writeMessage(response);
}
```

**Benefits of Integration:**

- **Real-time updates**: Capacity piggybacked on every message during active requests
- **Idle updates**: Health checks provide capacity updates when no requests active
- **No redundancy**: No separate CAPACITY_UPDATE message type needed
- **Consistent**: Same capacity data structure in both contexts
- **Efficient**: No extra messages, just metadata on existing messages

**ProcessManager Integration:**

```javascript
// Set capacity update callback
ipcConn.onCapacityUpdate = (capacity) => {
    if (capacity) {
        process.updateCapacity(
            capacity.at('availableWorkers'),
            capacity.at('totalWorkers')
        );
    }
};

// Health check handler also updates capacity
ipcConn.onMessage(MessageType.HEALTH_CHECK, async (message) => {
    // Capacity already updated via onCapacityUpdate callback
    // Just log health status
    this.logger.debug(`Health check from ${processId}: ${message.fields.at('status')}`);
});
```

### Phase 3: Operator Request Handling

**File:** [`src/operator.esm.js`](../src/operator.esm.js)

#### 3.1 Replace Blocking Request/Response with Stream Handler

**Before:**
```javascript
await process.ipcConn.writeMessage(requestMsg, bodyBytes);
const { message, binaryData } = await process.ipcConn.readMessage();
// Handle single response
```

**After:**
```javascript
// Create response stream
const responseStream = new ReadableStream({
    start: async (controller) => {
        // Register stream handler for this request
        process.ipcConn.registerStreamHandler(
            requestMsg.at('id'),
            async (message, binaryData) => {
                // Handle error
                if (message instanceof Error) {
                    controller.error(message);
                    return;
                }

                // Update capacity from frame
                const availableWorkers = message.fields.at('availableWorkers');
                const totalWorkers = message.fields.at('totalWorkers');
                if (availableWorkers !== undefined) {
                    process.updateCapacity(availableWorkers, totalWorkers);
                }

                // Enqueue frame data
                if (binaryData && binaryData.length > 0) {
                    controller.enqueue(binaryData);
                }

                // Check if stream is complete
                const final = message.fields.at('final', false);
                const keepAlive = message.fields.at('keepAlive', false);
                if (final && !keepAlive) {
                    controller.close();
                }
            }
        );

        // Send request
        await process.ipcConn.writeMessage(requestMsg, bodyBytes);
    }
});

// Return response with stream
return new Response(responseStream, {
    status,
    headers
});
```

#### 3.2 Bidirectional Connection Handling

For WebSocket/bidi connections, the stream handler manages the entire connection lifecycle:

```javascript
// Register bidirectional stream handler
process.ipcConn.registerStreamHandler(
    requestId,
    async (message, binaryData) => {
        if (message instanceof Error) {
            socket.close(1011, 'Internal error');
            return;
        }

        // Handle protocol parameters (second frame after status 101)
        if (message.fields.has('initialCredits')) {
            // Store protocol parameters
            connState.initialCredits = message.fields.at('initialCredits');
            // ... other parameters ...
            return;
        }

        // Forward data to WebSocket client
        if (binaryData && binaryData.length > 0) {
            socket.send(binaryData);
        }

        // Handle connection close
        const final = message.fields.at('final', false);
        const keepAlive = message.fields.at('keepAlive', true);
        if (final && !keepAlive) {
            socket.close(1000, 'Normal closure');
        }
    },
    300000 // 5 minute timeout for long-lived connections
);
```

### Phase 4: Service Process Updates

**File:** [`src/service-process.esm.js`](../src/service-process.esm.js)

No changes needed - service processes continue to use `readMessage()` loop as they only receive messages (don't need to monitor for unsolicited events).

### Phase 5: Testing Strategy

#### 5.1 Unit Tests

- Test IPCConnection stream handler registration/unregistration
- Test multiple frames delivered to same handler
- Test timeout handling for streams
- Test console output forwarding during monitoring
- Test handler cleanup on connection close

#### 5.2 Integration Tests

- Test responder startup logging appears immediately
- Test concurrent requests to same responder (multiple active streams)
- Test streaming responses (SSE, large files)
- Test bidirectional connections (WebSocket)
- Test request timeout scenarios
- Test process crash during active stream

#### 5.3 Manual Testing

- Start operator and verify responder logs appear immediately
- Send multiple concurrent requests
- Test streaming endpoints
- Test WebSocket connections
- Monitor for any lost console output

## Migration Path

### Step 1: Add Event Infrastructure (Non-Breaking)

Add stream handler methods to IPCConnection without changing existing code.

### Step 2: Update ProcessManager (Non-Breaking)

Start monitoring in background, but keep existing request/response code working.

### Step 3: Update Operator Request Flow (Breaking)

Replace blocking `readMessage()` calls with stream handler registration.

### Step 4: Testing and Validation

Comprehensive testing of new event-driven flow.

### Step 5: Cleanup

Remove old blocking code paths.

## Benefits

1. **Immediate console output**: All logging appears in operator logs immediately
2. **Non-blocking**: Request handlers don't block waiting for responses
3. **Concurrent requests**: Multiple requests can be in-flight simultaneously
4. **Streaming support**: Natural handling of multi-frame responses
5. **Extensible**: Easy to add new message types and handlers
6. **Robust**: Proper timeout handling and error recovery

## Stream Handler Patterns

### Pattern 1: Single Response (response mode)

```javascript
ipcConn.registerStreamHandler(requestId, async (message, binaryData) => {
    if (message instanceof Error) {
        reject(message);
        return;
    }
    
    // First frame has status and headers
    const status = message.fields.at('status', 200);
    const headers = message.fields.at('headers');
    
    // Accumulate data
    buffer.push(binaryData);
    
    // Final frame
    if (message.fields.at('final')) {
        resolve({ status, headers, body: concatenate(buffer) });
    }
});
```

### Pattern 2: Streaming Response (stream mode)

```javascript
const stream = new ReadableStream({
    start: (controller) => {
        ipcConn.registerStreamHandler(requestId, async (message, binaryData) => {
            if (message instanceof Error) {
                controller.error(message);
                return;
            }
            
            if (binaryData) controller.enqueue(binaryData);
            
            if (message.fields.at('final') && !message.fields.at('keepAlive')) {
                controller.close();
            }
        });
    }
});
```

### Pattern 3: Bidirectional (bidi mode)

```javascript
ipcConn.registerStreamHandler(requestId, async (message, binaryData) => {
    if (message instanceof Error) {
        socket.close(1011, 'Error');
        return;
    }
    
    // Handle protocol parameters
    if (message.fields.has('initialCredits')) {
        setupFlowControl(message.fields);
        return;
    }
    
    // Forward data
    if (binaryData) socket.send(binaryData);
    
    // Handle close
    if (message.fields.at('final') && !message.fields.at('keepAlive')) {
        socket.close(1000, 'Normal');
    }
});
```

## Risks and Mitigations

### Risk: Handler Memory Leaks

**Issue:** Stream handlers not cleaned up properly  
**Mitigation:** Always use timeouts, cleanup on connection close, automatic cleanup on final frame

### Risk: Race Conditions

**Issue:** Multiple frames arriving before handler processes them  
**Mitigation:** Handlers are called sequentially (await in monitoring loop), use proper async/await

### Risk: Backpressure

**Issue:** Frames arrive faster than handler can process  
**Mitigation:** ReadableStream provides natural backpressure, monitoring loop awaits handler completion

### Risk: Error Propagation

**Issue:** Errors in handlers not properly reported  
**Mitigation:** Pass errors to handler as first parameter, log handler errors, cleanup on error

## Open Questions

1. Should we add flow control between monitoring loop and handlers?
2. How to handle handler exceptions - retry, log, or terminate stream?
3. Should we add metrics for stream handler performance?
4. How to handle partial frames if connection drops mid-frame?

## Related Documents

- [`arch/ipc-protocol.md`](ipc-protocol.md) - Current IPC protocol specification
- [`arch/unified-protocol-assessment.md`](unified-protocol-assessment.md) - Unified frame protocol
- [`arch/frame-based-protocol.md`](frame-based-protocol.md) - Frame-based applet protocol

## Supplemental Keywords

[supplemental keywords: asynchronous messaging, event loop, stream processing, callback pattern, observer pattern, reactive programming, non-blocking I/O, concurrent requests, message correlation, request tracking, multi-frame responses, streaming protocol]