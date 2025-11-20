# Phase 4 Sub-Plan: Multi-Process Architecture and Infrastructure [DRAFT]

## Overview

Phase 4 represents a fundamental architectural transformation from a single-process model to a secure multi-process architecture with privilege separation. This phase also establishes critical infrastructure components (logging and configuration overrides) that will support all subsequent development.

**Note**: This document uses the term "pools" (not "classes") to refer to named, configurable process pools. See [`pool-configuration-design.md`](pool-configuration-design.md) for detailed pool design.

## Architectural Goals

1. **Security Through Privilege Separation**: Initial privileged process handles only configuration and port binding, while de-privileged service processes handle all requests
2. **User-Configurable Process Pools**: Flexible pool management based on workload characteristics
3. **Centralized Logging**: Standardized logging infrastructure for debugging and monitoring
4. **Configuration Flexibility**: Command-line overrides for development and testing

## New Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    Privileged Process (root)                   │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ Config Loader  │  │ Port Binder  │  │  Process Manager   │  │
│  │  (SLID files)  │  │  (80, 443)   │  │  (spawn/monitor)   │  │
│  └────────────────┘  └──────────────┘  └────────────────────┘  │
│           │                  │                    │            │
│           └──────────────────┴────────────────────┘            │
│                              │                                 │
│                    ┌─────────▼─────────┐                       │
│                    │  Request Router   │                       │
│                    │  (IPC Forwarder)  │                       │
│                    └─────────┬─────────┘                       │
└──────────────────────────────┼─────────────────────────────────┘
                               │
                ┌──────────────┴─────────────┬──────────────┐
                │                            │              │
        ┌───────▼────────┐          ┌────────▼────────┐  ┌──▼─────┐
        │  "fast" Pool   │          │ "standard" Pool │  │"stream"│
        │  (persistent)  │          │  (persistent)   │  │  Pool  │
        └───────┬────────┘          └────────┬────────┘  └───┬────┘
                │                            │               │
    ┌───────────┴──────────┐          ┌──────┴───────┐       │
    │                      │          │              │       │
┌───▼────┐  ┌───────┐  ┌───▼────┐  ┌──▼─────┐  ┌─────▼──┐  ┌─▼─────┐
│Service │  │Service│  │Service │  │Service │  │Service │  │Service│
│Process │  │Process│  │Process │  │Process │  │Process │  │Process│
│(static)│  │(fast) │  │(fast)  │  │(std)   │  │(std)   │  │(strm) │
│        │  │       │  │        │  │        │  │        │  │       │
│Workers │  │Workers│  │Workers │  │Workers │  │Workers │  │1 Conn │
│        │  │       │  │        │  │        │  │        │  │       │
└────────┘  └───────┘  └────────┘  └────────┘  └────────┘  └───────┘
   (uid: www-data, gid: www-data)
```

## Process Communication Flow

```
Client Request
     │
     ▼
┌─────────────────┐
│ Privileged Proc │
│  (Port 80/443)  │
└────────┬────────┘
         │ IPC: Request + Config
         ▼
┌─────────────────┐
│ Service Process │
│ (de-privileged) │
└────────┬────────┘
         │ Process Request
         ▼
┌─────────────────┐
│ Worker/Handler  │
│  (applet code)  │
└────────┬────────┘
         │ IPC: Response
         ▼
┌─────────────────┐
│ Privileged Proc │
│ (send to client)│
└─────────────────┘
```

## Phase 4 Sub-Phases

### Phase 4.1: Logging Infrastructure

**Goal**: Establish centralized logging system before implementing complex multi-process architecture.

**Components**:
- `src/logger.esm.js` - Core logging utility

**Features**:
1. Apache-like log format with timestamps
2. Multiple output targets:
   - Console (stdout/stderr)
   - Syslog (via logtape or similar)
3. Log levels: ERROR, WARN, INFO, DEBUG
4. Structured logging for machine parsing
5. Log rotation compatibility (external tools)

**Log Format**:
```
[2025-11-19T17:30:45.123Z] [INFO] [server] 192.168.1.100 - "GET /api/users HTTP/1.1" 200 1234 0.045s
[timestamp] [level] [component] [message]
```

**Configuration** (in `jsmaws.slid`):
```
[(logging=[
  target=console
  level=info
  format=apache
])]

# Or for syslog:
[(logging=[
  target=syslog
  facility=local0
  level=info
])]
```

**Implementation Steps**:
1. Create logger module with pluggable backends
2. Implement console backend
3. Implement syslog backend (using logtape)
4. Add log rotation signal handling (SIGUSR1)
5. Write unit tests for each backend
6. Document logging configuration

**Testing**:
- Unit tests for log formatting
- Integration tests for each backend
- Log rotation verification
- Performance impact measurement

### Phase 4.2: SSL Configuration Override

**Goal**: Add `--no-ssl` command-line parameter for development/testing.

**Components**:
- `src/cli-args.esm.js` - Command-line argument parser
(Any reason to build our own instead of just using std/cli/parseArgs???)

**Features**:
1. Parse `--no-ssl` flag
2. Override SLID configuration
3. Warn when SSL is disabled
4. Document security implications

**Configuration Precedence**:
```
Command-line args > SLID config > Defaults
```

**Implementation Steps**:
1. Create CLI argument parser
2. Add `--no-ssl` flag handling
3. Integrate with server initialization
4. Add warning logs when SSL disabled
5. Update documentation
6. Write tests for argument parsing

**Testing**:
- Unit tests for CLI parser
- Integration tests with/without `--no-ssl`
- Verify HTTPS redirect behavior

### Phase 4.3: Process Architecture Design

**Goal**: Document the new multi-process architecture in detail.

**Deliverables**:
1. IPC protocol specification
2. Process lifecycle documentation
3. Pool management strategy
4. Security model documentation

**IPC Protocol Design**:

Messages between privileged and service processes use SLID format with binary data separation:

**Message Structure**:
1. SLID header with metadata (including data size)
2. Binary data/chunks (if present)

This separation allows efficient handling of large request/response bodies without embedding binary data in SLID structures.

```
# Request message (privileged → service)
# SLID header:
[(request id=req-12345 [
  method=get
  path=/api/users
  applet=api/users
  headers=[Host=example.com...]
  bodySize=1234
])]
# Followed by 1234 bytes of binary data

# Response message (service → privileged)
# SLID header:
[(response id=req-12345 [
  status=200
  headers=[Content-Type=application/json Set-Cookie=[...]...]
  bodySize=5678
  workersAvailable=3
  workersTotal=4
  requestsQueued=0
])]
# Followed by 5678 bytes of binary data

# Config update message (privileged → service)
[(update [
  pools=[ fast=[...] ]
  mimeTypes=[...]
])]

# Pool control messages
[(shutdown)]
```

**Worker Capacity and Applet Affinity Tracking**:

The privileged process tracks applet affinity directly from its own dispatch history, without requiring service processes to report module state. This eliminates unnecessary IPC traffic while maintaining accurate affinity information (see [`arch/worker-module-caching.md`](worker-module-caching.md)):

1. **Privileged process maintains affinity map**:
   - Tracks which applets have been dispatched to which service processes
   - Built from dispatch history (no IPC reporting needed)
   - Format: `appletPath → Set of process IDs`
   - Example: `@api/users → {proc-1, proc-3}`

2. **Service process reports worker status** (piggybacked on responses):
   - Every response includes: `workersAvailable`, `workersTotal`, `requestsQueued`
   - No artificial traffic during active request handling
   - Worker availability updated with each request completion

3. **Request assignment** (affinity-aware):
   - Check if requested applet is in affinity map with available workers
   - If yes, route to that process (cache hit optimization)
   - If no, find process with available workers (any process)
   - If no available process AND can spawn → spawn new process
   - If no available process AND cannot spawn → queue request
   - Send request to selected process
   - Update affinity map with dispatch

4. **Affinity invalidation**:
   - When service process crashes/restarts, remove from all affinity sets
   - When configuration reloads, clear affinity map (applets may have changed)
   - Affinity naturally rebuilds as requests are dispatched

**Process Lifecycle**:

1. **Privileged Process Startup**:
   - Load configuration
   - Bind to ports 80 and 443
   - Spawn initial service process pools
   - Enter request forwarding loop

2. **Service Process Startup**:
   - Spawned with dropped privileges
     - setuid/setgid via `Deno.Command` options
     - `--allow-net --allow-write --no-prompt` command-line options
     - disable write for workers (only needed at process level for logging)
   - Receive configuration via IPC
   - Initialize router and handlers
   - Signal ready to privileged process
   - Enter request handling loop

3. **Request Handling**:
   - Privileged process receives HTTP request
   - Routes to appropriate pool based on route configuration
   - Forwards request via IPC
   - Service process handles request
   - Response forwarded back via IPC
   - Privileged process sends to client

4. **Graceful Shutdown**:
   - Privileged process receives SIGTERM
   - Stops accepting new connections
   - Sends shutdown signal to all pools
   - Waits for in-flight requests (timeout: 30s)
   - Exits

**Pool Management Strategy**:

See [`pool-configuration-design.md`](pool-configuration-design.md) for complete pool configuration specification.

```slid
# User-configurable pools (terser format)
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

**Pool Characteristics (Suggested Pools)**:
- **fast pool**: Short-duration, high-frequency requests
  - Persistent processes with high request capacity
  - Handles static files and approved short-running applets
  - Short timeout (5s), high `maxReqs` (1000)

- **standard pool**: General application requests
  - Persistent processes with moderate request capacity
  - Handles general JavaScript applet execution
  - Longer timeout (60s), moderate `maxReqs` (100)

- **stream pool**: Long-lived streaming connections
  - One connection per process (`maxReqs=1`)
  - Handles WebSocket, Server-Sent Events
  - Long connection timeout (3600s), no request timeout
  - Process persists for duration of connection

**Key Insight**: Pools are **workload profiles**, not just process management. They encode operational knowledge about how different types of requests should be handled.

### Phase 4.4: Privileged Process Implementation

**Goal**: Implement the initial privileged process that manages configuration, ports, and service processes.

**Components**:
- `src/privileged-process.esm.js` - Main privileged process
- `src/process-manager.esm.js` - Service process lifecycle management
- `src/ipc-protocol.esm.js` - IPC message handling

**Features**:
1. Configuration file loading
2. Port binding (80, 443)
3. Service process spawning
4. Request forwarding via IPC
5. Process health monitoring
6. Graceful shutdown handling

**Implementation Steps**:
1. Create privileged process entry point
2. Implement configuration loading
3. Implement port binding
4. Create IPC protocol handler
5. Implement process spawning
6. Add health monitoring
7. Add graceful shutdown
8. Write integration tests

**Security Considerations**:
- Privileged process MUST NOT handle requests directly
- All request data forwarded via IPC
- No user code execution in privileged process
- Validate all IPC messages from service processes

**Testing**:
- Unit tests for IPC protocol
- Integration tests for process spawning
- Security tests (verify no request handling)
- Shutdown behavior tests

### Phase 4.5: Service Process Implementation

**Goal**: Implement de-privileged service processes that handle actual requests.

**Components**:
- `src/service-process.esm.js` - Service process entry point
- `src/privilege-drop.esm.js` - UID/GID switching

**Features**:
1. Receive configuration via IPC
2. Drop privileges (setuid/setgid)
3. Initialize request handlers
4. Process requests from privileged process
5. Send responses via IPC

**Implementation Steps**:
1. Create service process entry point
2. Implement IPC configuration receiver
3. Implement privilege dropping
4. Integrate router and handlers
5. Implement request processing loop
6. Add error handling and recovery
7. Write unit and integration tests

**Privilege Dropping**:

Privileges are dropped at process spawn time using `Deno.Command` options:

```javascript
// In privileged-process.esm.js
async function spawnServiceProcess(config) {
  const uid = config.uid; // Numeric UID from config
  const gid = config.gid; // Numeric GID from config
  
  const command = new Deno.Command('deno', {
    args: ['run', '--allow-read', '--allow-write', '--allow-net', 'src/service-process.esm.js'],
    // (service workers to run with net access only)
    uid: uid,  // Drop to this UID
    gid: gid,  // Drop to this GID
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  });
  
  return await command.spawn();
}
```

**Note**: Configuration requires numeric UID/GID values rather than usernames to avoid parsing `/etc/passwd`. This aligns with Deno's POSIX capabilities and keeps the implementation focused.

**Testing**:
- Unit tests for privilege dropping
- Integration tests for request handling
- Security tests (verify privileges dropped)
- IPC communication tests

### Phase 4.6: Process Manager Implementation

**Goal**: Implement a process manager that spawns and monitors service processes according to pool configuration.

**Components**:
- `src/process-manager.esm.js` - Service process lifecycle management
- `src/process-metrics.esm.js` - Process monitoring and metrics collection

**Features**:
1. Spawn service processes according to pool configuration
2. Track which pool each service process serves
3. Monitor process health and restart on failure
4. Implement scaling strategies (static, dynamic, ondemand)
5. Handle process recycling based on `maxReqs`
6. Manage request queuing when capacity exceeded
7. Collect metrics per process and pool

**Key Insight**: Pool configuration is user-managed; process manager implements the configuration:
- **Pool Configuration** (user-defined): `minProcs`, `maxProcs`, `scaling`, `maxReqs`, timeouts, workers
- **Process Manager** (server-managed): Spawns/monitors processes to match configuration
- **Independent Timelines**: Pool config can change without affecting running processes; processes come and go independently

**Process Manager Behavior**:
```javascript
class ProcessManager {
  constructor(config) {
    this.poolConfig = config.pools;  // User-defined pool configurations
    this.processes = new Map();       // processId → {pool, workers, affinity}
    this.affinity = new Map();        // appletPath → Set of processIds
    this.requestQueue = [];
  }
  
  async handleRequest(request) {
    const poolName = request.pool;
    const appletPath = request.applet;
    
    // Strategy 1: Find process with cached applet and available workers
    let process = this.findProcessWithAffinity(appletPath, poolName);
    
    // Strategy 2: Find any process in pool with available workers
    if (!process) {
      process = this.findAvailableProcess(poolName);
    }
    
    // Strategy 3: Spawn new process if pool allows
    if (!process && this.canSpawnProcess(poolName)) {
      process = await this.spawnProcess(poolName);
    }
    
    // Strategy 4: Queue if no capacity
    if (!process) {
      return this.queueRequest(request);
    }
    
    return process.handleRequest(request);
  }
  
  canSpawnProcess(poolName) {
    const config = this.poolConfig[poolName];
    const currentCount = this.getProcessCount(poolName);
    return currentCount < config.maxProcs;
  }
  
  async scaleDown() {
    for (const [poolName, config] of Object.entries(this.poolConfig)) {
      if (config.scaling === 'static') continue;
      
      const poolProcesses = this.getPoolProcesses(poolName);
      const idleProcesses = poolProcesses
        .filter(p => p.isIdle() && p.idleTime > config.idleTimeout)
        .slice(config.minProcs);
      
      for (const process of idleProcesses) {
        await process.shutdown();
      }
    }
  }
}
```

**Scaling Strategy Implementation**:
- `static`: Fixed process count, no scaling
- `dynamic`: Scale between min/max based on load
- `ondemand`: Spawn on demand, kill after idle timeout

**Implementation Steps**:
1. Implement process manager with lifecycle management
2. Implement all scaling strategies (static, dynamic, ondemand)
3. Add process health monitoring and restart
4. Implement affinity-aware request routing (see [`arch/worker-module-caching.md`](worker-module-caching.md))
5. Implement request queuing
6. Add process recycling based on `maxReqs`
7. Add metrics collection
8. Add configuration validation
9. Write comprehensive tests

**Testing**:
- Unit tests for pool logic
- Load tests for scaling behavior
- Failure recovery tests
- Performance benchmarks

### Phase 4.7: Integration and Testing

**Goal**: Integrate all Phase 4 components and verify the complete system.

**Integration Tasks**:
1. Update [`src/server.esm.js`](../../../src/server.esm.js) to use privileged process
2. Migrate existing handlers to service processes
3. Update configuration loading
4. Add logging throughout
5. Update documentation

**Testing Strategy**:

**Security Tests**:
- Verify privileged process never handles requests
- Verify service processes run as configured user/group
- Test IPC message validation
- Verify process isolation

**Performance Tests**:
- Benchmark request throughput
- Measure pool scaling behavior
- Test under high load
- Compare to Phase 3 baseline

**Integration Tests**:
- End-to-end request flow
- Configuration reload
- Graceful shutdown
- Process failure recovery
- Pool scaling under load

**Regression Tests**:
- Verify all Phase 1-3 functionality still works
- Test SSL certificate handling
- Test configuration monitoring
- Test routing logic

## Configuration Changes

New configuration options in `jsmaws.slid`:

**Note**: User and group are specified as numeric UID/GID values to avoid system-specific user database parsing. This keeps the implementation portable and focused on core functionality.

See [`pool-configuration-design.md`](pool-configuration-design.md) for complete pool configuration specification.

```slid
[(
  # Existing configuration...
  mimeTypes=[...]
  appRoot=/path/to/apps
  root=/var/www
  
  # New Phase 4 configuration
  
  # Logging
  logging=[
    target=syslog
    facility=local0
    level=info
    format=apache
  ]
  
  # Process management (numeric UID/GID)
  uid=33      # www-data user (typically 33 on Debian/Ubuntu)
  gid=33      # www-data group
  
  # User-configurable pools (terser format)
  pools=[
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
  ]
  
  # Routes reference pools by name
  routes=[
    [path=/static/* pool=fast handler=static]
    [path=/api/health pool=fast applet=@health]
    [path=/api/* pool=standard applet=@*]
    [path=/ws/* pool=stream type=websocket applet=@*]
  ]
)]
```

## Command-Line Interface

```bash
# Normal operation (with SSL)
deno run --allow-all src/server.esm.js jsmaws.slid

# Development mode (no SSL)
deno run --allow-all src/server.esm.js --no-ssl jsmaws.slid

# Custom configuration file
deno run --allow-all src/server.esm.js --config /path/to/config.slid

# Specify log level
deno run --allow-all src/server.esm.js --log-level debug jsmaws.slid
```

## Migration Path from Phase 3

1. **Phase 4.1-4.2**: Can be implemented without breaking Phase 3
   - Logging is additive
   - `--no-ssl` is optional

2. **Phase 4.3**: Design phase, no code changes

3. **Phase 4.4-4.6**: Requires architectural migration
   - Create new entry point for privileged process
   - Keep Phase 3 code as fallback during development
   - Use feature flag to switch between architectures

4. **Phase 4.7**: Complete migration
   - Remove Phase 3 single-process code
   - Update all documentation
   - Verify all tests pass

## Success Criteria

Phase 4 is complete when:

1. ✅ Logging system operational with both console and syslog
2. ✅ `--no-ssl` flag works correctly
3. ✅ Privileged process successfully spawns service processes
4. ✅ Service processes run as configured user/group
5. ✅ User-configurable pools work with all scaling strategies
6. ✅ Fast pool handles high-frequency requests efficiently
7. ✅ Standard pool handles general applet requests
8. ✅ Stream pool handles long-lived connections (WebSocket)
9. ✅ All security tests pass
10. ✅ Performance meets or exceeds Phase 3 baseline
11. ✅ All Phase 1-3 functionality still works
12. ✅ Documentation updated

## Risk Assessment

**High Risk**:
- Process communication overhead may impact performance
- Privilege dropping may fail on some systems
- IPC protocol bugs could cause data corruption

**Medium Risk**:
- Pool sizing may need tuning for different workloads
- Log rotation integration may be complex
- Migration from Phase 3 may reveal edge cases

**Low Risk**:
- CLI argument parsing
- Log formatting
- Configuration precedence

## Dependencies

**External**:
- Deno's process spawning APIs
- System user/group management
- Syslog daemon (for syslog logging)

**Internal**:
- Phase 1-3 components (router, config-monitor, etc.)
- SLID parser (NANOS)

## Timeline Estimate

- Phase 4.1 (Logging): 2-3 days
- Phase 4.2 (SSL Override): 1 day
- Phase 4.3 (Design): 2-3 days
- Phase 4.4 (Privileged Process): 3-4 days
- Phase 4.5 (Service Process): 3-4 days
- Phase 4.6 (Pool Management): 4-5 days
- Phase 4.7 (Integration): 3-4 days

**Total**: 18-24 days

## Next Steps After Phase 4

With the multi-process architecture in place, Phase 5 (Static File Serving) can be implemented as a service process handler, and subsequent phases will benefit from the established infrastructure.

## References

- [`arch/pool-configuration-design.md`](pool-configuration-design.md) - Pool configuration specification
- [`arch/worker-module-caching.md`](worker-module-caching.md) - Worker module caching and affinity architecture
- [`arch/service-class-research.md`](service-class-research.md) - Research on servlet container patterns
- [`arch/development-plan.md`](development-plan.md) - Overall development plan
- [`arch/configuration.md`](configuration.md) - Configuration specification
- [`arch/test-plan.md`](test-plan.md) - Testing strategy
- [`.kilocode/rules/memory-bank/architecture.md`](../.kilocode/rules/memory-bank/architecture.md) - System architecture overview