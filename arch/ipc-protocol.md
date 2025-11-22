# IPC Protocol Specification

## Overview

The IPC (Inter-Process Communication) protocol defines how processes communicate in JSMAWS's multi-process architecture. The system uses three process types:

1. **Operators** (privileged): Accept HTTP requests from clients, manage routing, coordinate responder pools, relay responses back to clients
2. **Routers** (semi-privileged, optional): Perform filesystem-based route resolution when `fsRouting` is enabled; communicate only with operators
3. **Responders** (unprivileged): Execute applets and send responses back to operators via IPC

Messages use SLID format for headers with separate binary data, allowing efficient handling of large request/response bodies and response streaming with flow-control.

## Process Architecture

```
┌──────────────────────────────────────────────────────┐
│  Operator (privileged, port binding)                 │
│  - Accepts HTTP requests from clients                │
│  - Routes to responders (or queries routers)         │
│  - Manages responder pools                           │
│  - Relays responses back to clients                  │
└──────────────┬───────────────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
   ┌─────────┐   ┌──────────────┐
   │Responder│   │Router (opt.) │
   │(IPC)    │   │(IPC)         │
   └─────────┘   └──────────────┘
        │
        │
   ┌─────────┐
   │Responder│
   │(IPC)    │
   └─────────┘
        │
        └─────────────────────────────────┐
                                          │
                                    ┌─────▼──────┐
                                    │HTTP Client │
                                    └────────────┘
```

**Key Points**:
- Operator maintains HTTP connection to client
- Operator communicates with routers (if `fsRouting` enabled) for route resolution
- Operator communicates with responders for request handling
- Routers communicate ONLY with operator (not with responders)
- Responders communicate ONLY with operator (not with routers)

## Message Structure

All IPC messages follow this structure:

```
[SLID Header with metadata]
[Binary Data (if present)]
```

### SLID Header Format

Headers are SLID-formatted lists with the following structure:

```slid
[(<message-type> id=<unique-id> [
  <type-specific-fields>
])]
```

## Message Types

### 1. Route Request Message (Operator → Router)

Sent by operator to router for filesystem-based route resolution (only when `fsRouting` is enabled).

```slid
[(route-request id=rr-12345 [
  method=get
  path=/api/users
  headers=[Host=example.com...]
  bodySize=0
  remote=192.168.1.100
])]
```

**Fields**:
- `id`: Unique route request identifier
- `method`: HTTP method
- `path`: Request path to resolve
- `headers`: Request headers
- `bodySize`: Size of binary data (0 for route requests)
- `remote`: Client IP address

**Binary Data**: None (route requests don't include body)

### 2. Route Response Message (Router → Operator)

Sent by router back to operator with resolved route information.

```slid
[(route-response id=rr-12345 [
  pool=standard
  app=api/users
  params=[id=123]
  tail=
  status=200
])]
```

**Fields**:
- `id`: Matches route request ID
- `pool`: Pool name for this request
- `app`: Resolved applet path
- `params`: Route parameters (if any)
- `tail`: Remaining path (if any)
- `status`: 200 if matched, 404 if no match

**Binary Data**: None

### 3. Request Message (Operator → Responder)

Sent by operator to responder to handle an HTTP request. The responder processes the request and sends a response back to the operator via IPC.

```slid
[(request id=req-12345 [
  method=get
  path=/api/users
  app=api/users
  pool=standard
  headers=[Host=example.com Content-Type=application/json...]
  bodySize=1234
  remote=192.168.1.100
  params=[id=123]
  tail=
])]
```

**Fields**:
- `id`: Unique request identifier (used to correlate response)
- `method`: HTTP method (get, post, put, delete, patch, head, options)
- `path`: Original request path
- `app`: Resolved applet path from routing
- `pool`: Pool name for this request
- `headers`: List of header objects `[name=value...]`
- `bodySize`: Size of binary data following header (0 if no body)
- `remote`: Client IP address
- `params`: Route parameters (if any)
- `tail`: Remaining path (if any)

**Binary Data**: Request body (if `bodySize > 0`)

### 4. Response Message (Responder → Operator)

Sent by responder back to operator with response data. The operator then sends this response to the client via HTTP.

```slid
[(response id=req-12345 [
  status=200
  headers=[Content-Type=application/json Content-Length=5678...]
  bodySize=5678
  workersAvailable=3
  workersTotal=4
  requestsQueued=0
])]
```

**Fields**:
- `id`: Matches request ID (so operator knows which client request this response is for)
- `status`: HTTP status code (200, 404, 500, etc.)
- `headers`: Array of response headers
- `bodySize`: Size of binary data following header
- `workersAvailable`: Number of available workers in this responder
- `workersTotal`: Total workers in this responder
- `requestsQueued`: Number of requests queued in this responder

**Binary Data**: Response body (if `bodySize > 0`)

**Flow-Control Note**: For large responses, responders implement tiered flow-control (see "Response Streaming and Flow-Control" section below). The responder streams the response body to the operator via IPC, and the operator then streams it to the client via HTTP.

### 5. Config Update Message (Operator → Router/Responder)

Sent when configuration changes (routes, MIME types, pools, etc.).

```slid
[(config-update [
  pools=[ fast=[...] standard=[...] ]
  mimeTypes=[
    '.html'=text/html
    '.json'=application/json
  ]
  routes=[...]
  fsRouting=@t
])]
```

**Fields**:
- `pools`: Updated pool configuration
- `mimeTypes`: Updated MIME type mappings
- `routes`: Updated route configuration (for routers only)
- `fsRouting`: Whether filesystem-based routing is enabled

**Binary Data**: None

### 6. Pool Control Message (Operator → Responder)

Sent to control responder pool behavior (shutdown, scale-down, etc.).

```slid
[(shutdown [ timeout=30 ])]
[(scale-down)]
```

**Actions**:
- `shutdown`: Gracefully shutdown the responder process
  - `timeout`: Seconds to wait for in-flight requests (default: 30)
- `scale-down`: Reduce worker count if idle

**Binary Data**: None

### 7. Health Check Message (Operator → Router/Responder)

Sent periodically to verify process is alive.

```slid
[(health-check id=hc-12345 [
  timestamp=1700000000000
])]
```

**Response**: Process responds with same message type and ID.

### 8. Health Check Response (Router/Responder → Operator)

```slid
[(health-check id=hc-12345 [
  timestamp=1700000000000
  status=ok
  workersAvailable=3
  workersTotal=4
  requestsQueued=0
  uptime=3600
])]
```

## Communication Flows

### Request Handling Flow (Internal Routing)

When `fsRouting` is disabled, operator performs route resolution internally:

```
1. Client sends HTTP request to operator
2. Operator receives request and holds HTTP connection open
3. Operator resolves route internally
4. Operator selects responder pool
5. Operator sends Request message to responder via IPC
6. Responder receives Request message
7. Responder extracts binary body data
8. Responder processes request (loads applet, executes handler)
9. Responder sends Response message to operator via IPC
10. Operator receives Response message
11. Operator extracts binary body data from IPC response
12. Operator sends HTTP response to client (via original HTTP connection)
```

### Request Handling Flow (Delegated Routing)

When `fsRouting` is enabled, operator delegates route resolution to router:

```
1. Client sends HTTP request to operator
2. Operator receives request and holds HTTP connection open
3. Operator sends Route Request message to router via IPC
4. Router receives Route Request message
5. Router performs (filesystem-based or virtual) route resolution
6. Router sends Route Response message to operator via IPC
7. Operator receives Route Response message
8. Operator selects responder pool
9. Operator sends Request message to responder via IPC (with resolved route info)
10. Responder receives Request message
11. Responder extracts binary body data
12. Responder processes request (loads applet, executes handler)
13. Responder sends Response message to operator via IPC
14. Operator receives Response message
15. Operator extracts binary body data from IPC response
16. Operator sends HTTP response to client (via original HTTP connection)
```

### Configuration Update Flow

```
1. Configuration file changes
2. Operator detects change (via file watcher)
3. Operator parses new configuration
4. Operator sends Config Update message to all routers (if fsRouting enabled)
5. Operator sends Config Update message to all responders
6. Each router/responder receives Config Update message
7. Each router/responder updates its configuration
8. Operator updates its affinity map and routing state
```

### Graceful Shutdown Flow

```
1. Operator receives SIGTERM
2. Operator stops accepting new connections
3. Operator sends Pool Control (shutdown) message to all responders
4. Each responder receives shutdown message
5. Each responder stops accepting new requests
6. Each responder waits for in-flight requests to complete (timeout: 30s)
7. Each responder closes IPC connections and exits
8. Operator waits for all responder processes to exit
9. Operator exits
```

## Binary Data Handling

Binary data (request/response bodies) is NOT embedded in SLID structures. Instead:

1. SLID header includes `bodySize` field indicating binary data size
2. Binary data immediately follows SLID header in the message stream
3. Receiver reads SLID header first
4. Receiver then reads exactly `bodySize` bytes of binary data

**Example**:
```
Message: [(request id=req-1 [method=post path=/api/data bodySize=13])]
Binary:  Hello, World!
```

This approach:
- Avoids SLID encoding overhead for binary data
- Enables efficient streaming of large bodies
- Simplifies handling of binary content (images, files, etc.)

### Response Streaming and Flow-Control

For large response bodies, responders implement a tiered flow-control strategy to prevent write-blocking on the main event loop (see [`arch/requirements.md`](requirements.md) for detailed flow-control answer):

**Tier 1: Small Responses (< 64KB)**
- Write directly to IPC socket
- No flow-control overhead needed
- Typical for most API responses

**Tier 2: Medium Responses (64KB - 10MB)**
- Use async write operations to IPC socket
- Monitor write buffer size
- Implement backpressure: pause request processing if IPC buffer exceeds threshold
- When backpressure is active, report `workersAvailable=0` in response
- Resume when buffer drains and report actual worker availability

**Tier 3: Large Responses (> 10MB)**
- Stream in chunks (e.g., 64KB chunks) to IPC socket
- Yield to event loop between chunks
- Allow other requests/IPC messages to be processed
- Operator receives chunks and streams them to client via HTTP

**Backpressure Signaling**:
- Responder detects backpressure by monitoring write operation timing
- When average write time exceeds `bpWriteTimeThresh` (default: 50ms), backpressure is detected
- Responder reports `workersAvailable=0` in the next response message
- Operator sees no available workers and either queues the request or routes to another responder
- No explicit backpressure flag needed - `workersAvailable=0` is the signal
- When writes become fast again, responder clears backpressure and reports actual worker availability
- This approach leverages Unix pipe behavior: writes are fast when buffer has space, slow when full

**Key Points**:
- Responders use Deno's async write operations (non-blocking) to IPC socket
- Write buffer monitoring on IPC socket prevents blocking
- Event loop yielding between chunks maintains responsiveness
- Operator handles streaming from IPC to HTTP client
- No changes to IPC protocol needed (binary data separation already supports this)
- Configuration thresholds are tunable via `chunking` config (see [`arch/requirements.md`](requirements.md))

## Message Framing

Messages are framed using length-prefixed encoding:

```
[4 bytes: message length in bytes (big-endian)]
[N bytes: SLID header]
[M bytes: binary data (if bodySize > 0)]
```

This allows receivers to:
1. Read 4-byte length prefix
2. Read exactly that many bytes for SLID header
3. Read `bodySize` bytes for binary data
4. Know when message is complete

## Error Handling

### Connection Errors

If a responder or router connection is lost:
1. Operator detects connection close
2. Operator marks process as dead
3. Operator removes from affinity map (responders only)
4. Operator spawns replacement process
5. In-flight requests to dead process are retried or failed

### Message Format Errors

If a message cannot be parsed:
1. Receiver logs error with message details
2. Receiver closes connection
3. Sender detects connection close and handles accordingly

### Timeout Errors

If a responder doesn't respond within timeout:
1. Operator marks request as timed out
2. Operator sends error response to client
3. Responder may still be processing (will be killed if it doesn't respond to shutdown)

## Performance Considerations

### Affinity Tracking

The operator maintains an affinity map to optimize request routing to responders:

```javascript
affinity = {
  'api/users': Set(['proc-1', 'proc-3']),
  'api/posts': Set(['proc-2']),
  'static': Set(['proc-1', 'proc-2', 'proc-3']),
}
```

This map is built from dispatch history (no IPC reporting needed) and enables:
- Cache-aware routing (send request to responder that has applet cached)
- Reduced module loading overhead
- Better CPU cache utilization

### Worker Capacity Tracking

Responders report worker availability in every response:
- `workersAvailable`: Workers ready to handle requests
- `workersTotal`: Total workers in responder
- `requestsQueued`: Requests waiting for workers

This information is piggybacked on responses (no extra IPC traffic) and enables:
- Load-aware request distribution
- Queue depth monitoring
- Scaling decisions

## Security Considerations

### Message Validation

All messages must be validated:
1. SLID header must be valid
2. Required fields must be present
3. Field values must be in expected ranges
4. Binary data size must match `bodySize` field

### Privilege Boundaries

- Operator NEVER executes user code
- Router (if present) NEVER binds to ports or executes user code
- Responders NEVER bind to ports
- Responders NEVER read configuration files directly
- All configuration passed via IPC from operator
- Operator maintains all HTTP connections to clients

### IPC Channel Security

- IPC uses Unix domain sockets (local only)
- No network exposure
- Process isolation via OS (different UID/GID)
- No authentication needed (OS enforces process boundaries)

## Testing Strategy

### Unit Tests

- SLID header parsing and generation
- Binary data extraction
- Message validation
- Error handling
- Flow-control logic

### Integration Tests

- Request/response round-trip (internal routing)
- Request/response round-trip (delegated routing)
- Configuration updates
- Graceful shutdown
- Connection recovery
- Affinity tracking
- Response streaming with backpressure

### Performance Tests

- Message throughput
- Latency under load
- Memory usage with large bodies
- Connection pooling efficiency
- Flow-control overhead

## References

- [`arch/requirements.md`](requirements.md) - Configuration and requirements (including flow-control answer)
- [`arch/phase-4-sub-plan.md`](phase-4-sub-plan.md) - Phase 4 implementation plan
- [`arch/pool-configuration-design.md`](pool-configuration-design.md) - Pool configuration
- [`arch/worker-module-caching.md`](worker-module-caching.md) - Affinity tracking details
