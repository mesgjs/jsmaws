# IPC Protocol Specification

## Overview

The IPC (Inter-Process Communication) protocol defines how the privileged process communicates with service processes in JSMAWS. Messages use SLID format for headers with separate binary data, allowing efficient handling of large request/response bodies.

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

### Message Types

#### 1. Request Message (Privileged → Service)

Sent by privileged process to service process to handle an HTTP request.

```slid
[(request id=req-12345 [
  method=get
  path=/api/users
  applet=api/users
  pool=standard
  headers=[Host=example.com Content-Type=application/json Set-Cookie=[...]...]
  bodySize=1234
  remote=192.168.1.100
])]
```

**Fields**:
- type (0): Always `request`
- `id`: Unique request identifier (e.g., `req-12345`)
- type-specific (1):
  - `method`: HTTP method (get, post, put, delete, patch, head, options)
  - `path`: Request path (e.g., `/api/users`)
  - `applet`: Resolved applet path from routing (e.g., `api/users`)
  - `pool`: Pool name for this request (e.g., `standard`, `fast`, `stream`)
  - `headers`: List of header objects `[name=value...]`
  - `bodySize`: Size of binary data following header (0 if no body)
  - `remote`: Client IP address

**Binary Data**: Request body (if `bodySize > 0`)

#### 2. Response Message (Service → Privileged)

Sent by service process back to privileged process with response data.

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
- type (0): Always `response`
- `id`: Matches request ID
- type-specific (1):
  - `status`: HTTP status code (200, 404, 500, etc.)
  - `headers`: Array of response headers
  - `bodySize`: Size of binary data following header
  - `workersAvailable`: Number of available workers in this process
  - `workersTotal`: Total workers in this process
  - `requestsQueued`: Number of requests queued in this process

**Binary Data**: Response body (if `bodySize > 0`)

#### 3. Config Update Message (Privileged → Service)

Sent when configuration changes (routes, MIME types, etc.).

```slid
[(config-update [
  pools=[ fast=[...] ]
  mimeTypes=[
    '.html'=text/html
    '.json'=application/json
  ]
])]
```

**Fields**:
- type (0): Always `config-update`
- type-specific (1):
  - `pools`: Updated pool configuration (filtered for assigned pool)
  - `mimeTypes`: Updated MIME type mappings

#### 4. Pool Control Message (Privileged → Service)

Sent to control pool behavior (shutdown, etc.).

```slid
[(shutdown [ timeout=30 ])]
[(scale-down)]
```

**Actions**:
- `shutdown`: Gracefully shutdown the service process
  - `timeout`: Seconds to wait for in-flight requests (default: 30)
- `scale-down`: Reduce worker count if idle

#### 5. Health Check Message (Privileged → Service)

Sent periodically to verify service process is alive.

```slid
[(health-check id=hc-12345 [
  timestamp=1700000000000
])]
```

**Response**: Service process responds with same message type and ID.

#### 6. Health Check Response (Service → Privileged)

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

## Communication Flow

### Request Handling Flow

```
1. Client sends HTTP request to privileged process
2. Privileged process receives request
3. Privileged process routes request to appropriate pool
4. Privileged process sends Request message to service process
5. Service process receives Request message
6. Service process extracts binary body data
7. Service process processes request (loads applet, executes handler)
8. Service process sends Response message to privileged process
9. Privileged process receives Response message
10. Privileged process extracts binary body data
11. Privileged process sends HTTP response to client
```

### Configuration Update Flow

```
1. Configuration file changes
2. Privileged process detects change (via file watcher)
3. Privileged process parses new configuration
4. Privileged process sends Config Update message to all service processes
5. Each service process receives Config Update message
6. Each service process updates its route table \[WHY DO THEY HAVE ONE?\]
7. Privileged process updates its affinity map
```

### Graceful Shutdown Flow

```
1. Privileged process receives SIGTERM
2. Privileged process stops accepting new connections
3. Privileged process sends Pool Control (shutdown) message to all pools
4. Each service process receives shutdown message
5. Each service process stops accepting new requests
6. Each service process waits for in-flight requests to complete (timeout: 30s)
7. Each service process closes connections and exits
8. Privileged process waits for all service processes to exit
9. Privileged process exits
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

If a service process connection is lost:
1. Privileged process detects connection close
2. Privileged process marks service process as dead
3. Privileged process removes from affinity map
4. Privileged process spawns replacement service process
5. In-flight requests to dead process are retried or failed

### Message Format Errors

If a message cannot be parsed:
1. Receiver logs error with message details
2. Receiver closes connection
3. Sender detects connection close and handles accordingly

### Timeout Errors

If a service process doesn't respond within timeout:
1. Privileged process marks request as timed out
2. Privileged process sends error response to client
3. Service process may still be processing (will be killed if it doesn't respond to shutdown)

## Performance Considerations

### Affinity Tracking

The privileged process maintains an affinity map to optimize request routing:

```javascript
affinity = {
  'api/users': Set(['proc-1', 'proc-3']),
  'api/posts': Set(['proc-2']),
  'static': Set(['proc-1', 'proc-2', 'proc-3']),
}
```

This map is built from dispatch history (no IPC reporting needed) and enables:
- Cache-aware routing (send request to process that has applet cached)
- Reduced module loading overhead
- Better CPU cache utilization

### Worker Capacity Tracking

Service processes report worker availability in every response:
- `workersAvailable`: Workers ready to handle requests
- `workersTotal`: Total workers in process
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

- Privileged process NEVER executes user code
- Service processes NEVER bind to ports
- Service processes NEVER read configuration files directly
- All configuration passed via IPC from privileged process

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

### Integration Tests

- Request/response round-trip
- Configuration updates
- Graceful shutdown
- Connection recovery
- Affinity tracking

### Performance Tests

- Message throughput
- Latency under load
- Memory usage with large bodies
- Connection pooling efficiency

## References

- [`arch/phase-4-sub-plan.md`](phase-4-sub-plan.md) - Phase 4 implementation plan
- [`arch/pool-configuration-design.md`](pool-configuration-design.md) - Pool configuration
- [`arch/worker-module-caching.md`](worker-module-caching.md) - Affinity tracking details
