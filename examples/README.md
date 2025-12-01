# JSMAWS Examples

This directory contains example applets and test clients to demonstrate the JSMAWS unified frame protocol.

## Example Applets

### hello-world.esm.js
Simple HTTP request/response applet that returns JSON.

**Features:**
- Single-frame response
- Query parameter handling
- JSON response

**Test:**
```bash
deno run --allow-net examples/clients/http-client.js
```

### sse-clock.esm.js
Server-Sent Events (SSE) applet that streams time updates.

**Features:**
- Streaming mode (`mode: 'stream'`)
- Long-lived connection (`keepAlive: true`)
- Multiple frames over time
- Graceful close

**Test:**
```bash
deno run --allow-net examples/clients/sse-client.js
```

### websocket-echo.esm.js
WebSocket echo server that demonstrates bidirectional communication.

**Features:**
- Bidirectional mode (`mode: 'bidi'`)
- WebSocket upgrade handling
- Protocol parameter negotiation
- Credit-based flow control
- Message echoing

**Test:**
```bash
deno run --allow-net examples/clients/websocket-client.js
```

## Test Clients

### http-client.js
Tests the hello-world applet with various HTTP requests.

### sse-client.js
Connects to the SSE clock applet and displays received events.

### websocket-client.js
Connects to the WebSocket echo applet and sends test messages.

## Running the Examples

1. **Start JSMAWS server** (when implemented):
   ```bash
   deno run --allow-all src/operator.esm.js --config examples/jsmaws-examples.slid
   ```

2. **Run a test client**:
   ```bash
   deno run --allow-net examples/clients/http-client.js
   deno run --allow-net examples/clients/sse-client.js
   deno run --allow-net examples/clients/websocket-client.js
   ```

## Configuration

Create `examples/jsmaws-examples.slid` to configure routes for these applets:

```slid
[(
  routes=[
    [path=/hello app=examples/applets/hello-world.esm.js pool=fast]
    [path=/sse-clock app=examples/applets/sse-clock.esm.js pool=stream]
    [path=/ws-echo app=examples/applets/websocket-echo.esm.js pool=stream]
  ]
  
  pools=[
    fast=[
      minProcs=1
      maxProcs=5
      minWorkers=2
      maxWorkers=8
      scaling=dynamic
      reqTimeout=5
    ]
    stream=[
      minProcs=1
      maxProcs=10
      maxWorkers=1
      scaling=ondemand
      reqTimeout=0
      conTimeout=3600
    ]
  ]
)]
```

## Protocol Patterns

### Simple Response (hello-world)
```javascript
self.postMessage({
  type: 'frame',
  id,
  mode: 'response',
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  data: responseData,
  final: true,
  keepAlive: false
});
```

### Streaming (sse-clock)
```javascript
// First frame
self.postMessage({
  type: 'frame',
  id,
  mode: 'stream',
  status: 200,
  headers: { 'Content-Type': 'text/event-stream' },
  data: null,
  keepAlive: true
});

// Subsequent frames
self.postMessage({
  type: 'frame',
  id,
  data: eventData,
  final: true  // Each event is one frame
});

// Close
self.postMessage({
  type: 'frame',
  id,
  data: null,
  final: true,
  keepAlive: false
});
```

### Bidirectional (websocket-echo)
```javascript
// Accept upgrade
self.postMessage({
  type: 'frame',
  id,
  mode: 'bidi',
  status: 101,
  headers: { 'Upgrade': 'websocket', ... },
  data: null,
  keepAlive: true
});

// Receive protocol parameters
if (initialCredits !== undefined) {
  // Connection ready
}

// Send/receive messages
self.postMessage({
  type: 'frame',
  id,
  data: messageData,
  final: true
});
```

## Key Concepts

### Frame Protocol
- **First frame**: Includes `mode`, `status`, `headers`
- **Subsequent frames**: Only `data` and `final`
- **Sticky state**: `mode` and `keepAlive` persist

### Modes
- **response**: Single request/response (default `keepAlive: false`)
- **stream**: Long-lived streaming (SSE, chunked responses)
- **bidi**: Bidirectional (WebSocket, future transports)

### Security
- Applets receive `maxChunkSize` limit
- Chunks exceeding limit cause termination
- Built-in applets get additional `config` object
- User applets are sandboxed

## Next Steps

- Add more example applets (file upload, JSON-RPC, etc.)
- Add load testing clients
- Add error handling examples
- Add authentication examples