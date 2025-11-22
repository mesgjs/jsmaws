# Pool Configuration Design

## Overview

Based on research into servlet containers and application servers (see [`service-class-research.md`](service-class-research.md)), JSMAWS will use **user-configurable pools** similar to PHP-FPM's model. Pools are no longer called "classes" - they are named, configurable process pools with specific characteristics.

## Core Design Principles

1. **User-Defined Pools**: Administrators define pools with specific characteristics
2. **Route-to-Pool Mapping**: Routes reference pools by name
3. **Sensible Defaults**: Ship with recommended configurations
4. **Incremental Complexity**: Start with hardcoded pools in Phase 4, add full configurability later

## Pool Configuration Format

### Terser SLID Format

```slid
[(pools=[
  fast=[
    minProcs=2
    maxProcs=10
    scaling=dynamic
    maxReqs=1000
    idleTimeout=300
    reqTimeout=5
  ]
  standard=[
    minProcs=1
    maxProcs=20
    scaling=dynamic
    maxReqs=100
    idleTimeout=600
    reqTimeout=60
  ]
  stream=[
    minProcs=1
    maxProcs=50
    scaling=ondemand
    maxReqs=1
    conTimeout=3600
    reqTimeout=0
  ]
])]
```

## Pool Parameters

### Required Parameters

- **`minProcs`**: Minimum number of processes (0 for ondemand)
- **`maxProcs`**: Maximum number of processes
- **`scaling`**: Scaling strategy (`static`, `dynamic`, `ondemand`)

### Optional Parameters

- **`minWorkers`**: Minimum worker threads per process (default: 1)
  - Minimum concurrent requests a process can handle
  - Must be >= 1
  - For `stream` pool, must be exactly 1
  
- **`maxWorkers`**: Maximum worker threads per process (default: 4)
  - Maximum concurrent requests a process can handle
  - Must be >= `minWorkers`
  - For `stream` pool, must be exactly 1
  - Higher values increase concurrency but memory usage per process
  
- **`maxReqs`**: Maximum requests per process before restart (default: unlimited if omitted)
  - Used for memory leak mitigation
  - Process gracefully exits after handling this many requests
  - Value of `1` means one-shot processes (like CGI)
  - Omit or set to `0` for unlimited
  
- **`idleTimeout`**: Seconds before idle process exits (default: 300)
  - Only applies when `scaling=dynamic` or `scaling=ondemand`
  - Processes beyond `minProcs` exit after being idle this long
  
- **`reqTimeout`**: Per-request timeout in seconds (default: 30)
  - Maximum time a single request can take
  - Value of `0` means no timeout
  - Useful for preventing runaway requests
  
- **`conTimeout`**: Connection timeout in seconds (default: 60)
  - For long-lived connections (WebSocket, SSE)
  - Maximum idle time before connection closed
  - Only relevant for streaming protocols

### Response Chunking Parameters

Response chunking configuration controls how responders handle large response bodies to prevent write-blocking (see [`arch/requirements.md`](requirements.md) for detailed flow-control answer):

- **`maxDirectWrite`**: Maximum response size for direct write without flow-control (default: 65536 bytes / 64KB)
  - Responses smaller than this are written directly to IPC socket without backpressure monitoring
  - Tier 1: Direct write (no overhead)
  - Typical for most API responses
  
- **`autoChunkThresh`**: Threshold at which chunked streaming is automatically activated (default: 10485760 bytes / 10MB)
  - Responses larger than this are streamed in chunks to IPC socket
  - Between `maxDirectWrite` and `autoChunkThresh`: Tier 2 backpressure monitoring
  - At or above `autoChunkThresh`: Tier 3 chunked streaming
  
- **`chunkSize`**: Size of chunks for streaming large responses (default: 65536 bytes / 64KB)
  - Used when streaming responses >= `autoChunkThresh`
  - Smaller chunks = more responsive but more overhead
  - Larger chunks = less overhead but less responsive
  
- **`maxWriteBuffer`**: IPC write buffer size threshold (default: 1048576 bytes / 1MB)
  - Legacy parameter, kept for compatibility
  - Not used with timing-based backpressure detection
  
- **`bpWriteTimeThresh`**: Backpressure write time threshold (default: 50 milliseconds)
  - Average write time indicating backpressure
  - Based on Unix pipe behavior - writes should be fast if buffer not full
  - Responder tracks recent write times and signals backpressure when average exceeds threshold

**Note**: These are global defaults; individual pools can override if needed.

### Derived Behavior

The `lifecycle` parameter mentioned in research is **redundant** - it's derived from `maxReqs`:
- `maxReqs=1` → oneshot lifecycle (process exits after one request)
- `maxReqs>1` or omitted → persistent lifecycle (process handles multiple requests)

## Scaling Strategies

### `static`
- Fixed number of processes (`minProcs` must equal `maxProcs`)
- Processes never scale up or down
- Simplest, most predictable
- Best for: Consistent, predictable workloads

```slid
worker=[
  minProcs=4
  maxProcs=4
  scaling=static
]
```

### `dynamic`
- Scales between `minProcs` and `maxProcs` based on load
- Spawns new processes when all busy
- Kills idle processes after `idleTimeout`
- Best for: Variable workloads with baseline demand

```slid
api=[
  minProcs=2
  maxProcs=20
  scaling=dynamic
  idleTimeout=300
]
```

### `ondemand`
- Spawns processes only when needed (`minProcs` typically 0)
- Kills processes after `idleTimeout` of inactivity
- Highest resource efficiency, higher latency on first request
- Best for: Sporadic, low-frequency workloads

```slid
batch=[
  minProcs=0
  maxProcs=5
  scaling=ondemand
  idleTimeout=60
]
```

## Standard Pool Profiles

### Fast Pool (Static Files + Short Applets)
```slid
fast=[
  minProcs=2
  maxProcs=10
  scaling=dynamic
  minWorkers=2
  maxWorkers=8
  maxReqs=1000
  idleTimeout=300
  reqTimeout=5
]
```

**Characteristics**:
- Persistent processes with high request capacity
- High worker concurrency (up to 8 concurrent requests per process)
- Short timeout (5s) for fast operations
- Handles static files and approved short-running applets
- Memory leak protection via `maxReqs`

### Standard Pool (General Applets)
```slid
standard=[
  minProcs=1
  maxProcs=20
  scaling=dynamic
  minWorkers=1
  maxWorkers=4
  maxReqs=100
  idleTimeout=600
  reqTimeout=60
]
```

**Characteristics**:
- Persistent processes with moderate request capacity
- Moderate worker concurrency (up to 4 concurrent requests per process)
- Longer timeout (60s) for general operations
- Lower `maxReqs` for more frequent process recycling
- Handles general JavaScript applet execution

### Stream Pool (WebSocket, SSE)
```slid
stream=[
  minProcs=1
  maxProcs=50
  scaling=ondemand
  maxWorkers=1
  maxReqs=1
  conTimeout=3600
  reqTimeout=0
]
```

**Characteristics**:
- One connection per process (`maxReqs=1`, `maxWorkers=1`)
- Long connection timeout (1 hour)
- No request timeout (streaming can be indefinite)
- Spawned on demand, killed when connection closes
- Exactly one worker per process (enforced)

**Note**: `maxReqs=1` means each process handles exactly one connection, then exits. This is effectively "oneshot per connection" but the process persists for the duration of that connection. `maxWorkers=1` is enforced to ensure one connection per process.

## Route-to-Pool Mapping

Routes reference pools by name:

```slid
[(routes=[
  [path=/static/* pool=fast handler=static]
  [path=/api/health pool=fast applet=@health]
  [path=/api/* pool=standard applet=@*]
  [path=/ws/* pool=stream type=websocket applet=@*]
])]
```

## Relationship Between Pools

### Standard vs Stream

Initially, we considered whether `stream` should be a special case of `standard`. Analysis shows they are **fundamentally different**:

**Standard Pool**:
- Request-response model
- Process handles many requests sequentially
- Timeout per request
- Scales based on request queue depth

**Stream Pool**:
- Connection-oriented model
- Process handles one connection for its entire lifetime
- Timeout per connection (not per message)
- Scales based on active connection count

**Conclusion**: They should be **separate pools** with different management strategies, not variants of the same pool.

### Fast vs Standard

These are more similar - both are request-response pools. The difference is **workload characteristics**:

**Fast Pool**:
- Short-duration requests (< 5s)
- High frequency
- Reviewed/approved code
- Higher `maxReqs` (processes live longer)

**Standard Pool**:
- Arbitrary-duration requests (up to 60s)
- Variable frequency
- Unrestricted code
- Lower `maxReqs` (more frequent recycling for safety)

**Conclusion**: These **could** be the same pool with different parameters, but separate pools provide clearer intent and easier tuning.

## Configuration Validation

### Required Validations

1. **Pool name uniqueness**: No duplicate pool names
2. **Pool references**: Routes must reference defined pools
3. **Parameter ranges**:
   - `minProcs >= 0`
   - `maxProcs > 0`
   - `minProcs <= maxProcs`
   - For `scaling=static`: `minProcs == maxProcs`
4. **Timeout values**: All timeouts >= 0
5. **maxReqs**: If specified, must be > 0

### Validation Errors

```slid
# ERROR: minProcs > maxProcs
bad=[minProcs=10 maxProcs=5 scaling=dynamic]

# ERROR: static requires minProcs == maxProcs
bad=[minProcs=2 maxProcs=10 scaling=static]

# ERROR: undefined pool reference
[(routes=[
  [path=/api/* pool=undefined applet=@*]
])]
```

## Default Configuration

If no pools are defined, use these defaults:

```slid
[(
pools=[
  fast=[minProcs=2 maxProcs=10 scaling=dynamic minWorkers=2 maxWorkers=8 maxReqs=1000 reqTimeout=5]
  standard=[minProcs=1 maxProcs=20 scaling=dynamic minWorkers=1 maxWorkers=4 maxReqs=100 reqTimeout=60]
  stream=[minProcs=1 maxProcs=50 scaling=ondemand maxWorkers=1 maxReqs=1 conTimeout=3600]
]

# Response chunking configuration (global defaults)
chunking=[
  maxDirectWrite=65536
  autoChunkThresh=10485760
  chunkSize=65536
  maxWriteBuffer=1048576
]
)]
```

## Example Configurations

### Minimal (Single Pool)
```slid
[(pools=[
  default=[minProcs=2 maxProcs=10 scaling=dynamic minWorkers=1 maxWorkers=4]
])]

[(routes=[
  [path=/* pool=default applet=@*]
])]
```

### Standard (Three Pools)
```slid
[(pools=[
  fast=[minProcs=2 maxProcs=10 scaling=dynamic minWorkers=2 maxWorkers=8 maxReqs=1000 reqTimeout=5]
  standard=[minProcs=1 maxProcs=20 scaling=dynamic minWorkers=1 maxWorkers=4 maxReqs=100 reqTimeout=60]
  stream=[minProcs=1 maxProcs=50 scaling=ondemand maxWorkers=1 maxReqs=1 conTimeout=3600]
])]

[(routes=[
  [path=/static/* pool=fast handler=static]
  [path=/api/* pool=standard applet=@*]
  [path=/ws/* pool=stream type=websocket applet=@*]
])]
```

### Advanced (Custom Pools)
```slid
[(pools=[
  # Static files - high capacity, minimal overhead
  static=[minProcs=4 maxProcs=4 scaling=static minWorkers=4 maxWorkers=8 maxReqs=10000 reqTimeout=2]
  
  # Public API - moderate capacity, strict timeout
  public=[minProcs=2 maxProcs=15 scaling=dynamic minWorkers=1 maxWorkers=4 maxReqs=500 reqTimeout=30]
  
  # Admin API - low capacity, longer timeout
  admin=[minProcs=1 maxProcs=5 scaling=dynamic minWorkers=1 maxWorkers=2 maxReqs=100 reqTimeout=120]
  
  # Background jobs - on-demand, long timeout
  batch=[minProcs=0 maxProcs=3 scaling=ondemand minWorkers=1 maxWorkers=1 reqTimeout=600]
  
  # WebSocket - per-connection processes
  websocket=[minProcs=0 maxProcs=100 scaling=ondemand maxWorkers=1 maxReqs=1 conTimeout=7200]
])]

[(routes=[
  [path=/static/* pool=static handler=static]
  [path=/api/public/* pool=public applet=@public]
  [path=/api/admin/* pool=admin applet=@admin]
  [path=/batch/* pool=batch applet=@batch]
  [path=/ws/* pool=websocket type=websocket applet=@*]
])]
```

## Implementation Phases

### Phase 4.1-4.3: Hardcoded Pools
- Implement with three hardcoded pools: `fast`, `standard`, `stream`
- Pool parameters are constants in code
- Validates multi-process architecture

### Phase 4.4-4.6: Configurable Parameters
- Make pool parameters configurable in SLID
- Keep pool names hardcoded (`fast`, `standard`, `stream`)
- Add validation for parameter ranges

### Phase 4.7 or Later: User-Defined Pools
- Allow arbitrary pool names
- Validate pool references in routes
- Provide example configurations
- Document pool design patterns

## Pool Metrics and Monitoring

Future enhancement: Expose pool metrics for monitoring:

```slid
# Potential metrics endpoint
[path=/metrics pool=fast handler=metrics]
```

Metrics to track:
- Active processes per pool
- Idle processes per pool
- Request queue depth
- Average request duration
- Process spawn/exit rate
- Memory usage per pool

## Open Questions

1. **Should pools support inheritance?**
   ```slid
   api=[minProcs=2 maxProcs=20 scaling=dynamic]
   admin=[extends=api maxProcs=5]  # Inherits other params from api
   ```

2. **Should routes support per-route parameter overrides?**
   ```slid
   [path=/api/slow pool=standard reqTimeout=300]  # Override timeout for this route
   ```

3. **How to handle pool hot-reload?**
   - Can pool parameters be changed without restart?
   - What happens to active processes in a pool being reconfigured?

4. **Should we support pool-level user/group?**
   ```slid
   untrusted=[minProcs=0 maxProcs=10 uid=1001 gid=1001]
   ```

## Conclusion

The pool configuration design provides:

1. **Flexibility**: Administrators can define custom pools for their workload
2. **Simplicity**: Sensible defaults for common cases
3. **Clarity**: Pool names and parameters clearly express intent
4. **Proven Pattern**: Based on successful PHP-FPM model
5. **Incremental Adoption**: Can start simple and add complexity as needed

The key insight: **Pools are workload profiles, not just process management**. They encode operational knowledge about how different types of requests should be handled.