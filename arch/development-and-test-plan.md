# JSMAWS Development and Test Plan

## Overview

This document consolidates the development roadmap and testing strategy for the JavaScript Multi-Applet Web Server (JSMAWS). It incorporates the latest architectural requirements including multi-process architecture with privilege separation, user-configurable process pools, routing (internal or delegated), flow-control for response streaming, and comprehensive testing strategies.

**Status**: [DRAFT]

**Authority Note**: This document supersedes all other development and planning documents (`phase-4-sub-plan.md`, `development-plan.md`, `test-plan.md`). When conflicts arise between this document and others, this document is authoritative.

**Architectural Pivot**: The current `src/server.esm.js` is treated as a prototype/POC (Phase 1-3) that led to the multi-process redesign. Phase 4 introduces the production architecture with clear process/worker naming conventions.

---

## Prototype Phase: Single-Process Foundation (Phases 1-3)

The initial implementation (`src/server.esm.js`) serves as a proof-of-concept that establishes core functionality before the architectural pivot to multi-process design.

### Phase 1: Project Setup and Basic HTTP Server

#### Goals
- Establish project structure and basic HTTP server
- Implement HTTP to HTTPS redirect with ACME bypass
- Create foundation for subsequent phases

#### Components
- `src/server.esm.js` \[subsequently renamed to `src/operator.esm.js`\] - Prototype main server entry point (single-process)

#### Implementation Tasks

1. **Project Structure**
   - Create `src/` directory for source files
   - Create `test/` directory for test files
   - Create `arch/` directory for architecture documents
   - Set up `.gitignore` and LICENSE

2. **Basic HTTP Server**
   - Implement HTTP server using Deno's HTTP server
   - Listen on port 80 (HTTP) and 443 (HTTPS)
   - Handle basic request/response cycle

3. **HTTP to HTTPS Redirect**
   - Redirect HTTP requests to HTTPS
   - Support path-prefix bypass for ACME HTTP-01 challenges (e.g., `/.well-known/acme-challenge/*`)
   - Preserve query strings and request paths in redirects

4. **Development Mode**
   - Implement "noSSL" mode for development/testing
   - Allow running without SSL certificates for localhost experimentation

#### Testing (Phase 1)
- **Unit Tests**: HTTP server initialization, request handling
- **Integration Tests**: HTTP to HTTPS redirect, ACME bypass functionality
- **Manual Tests**: Verify server starts and responds to requests

#### Success Criteria
- Server starts without errors
- HTTP requests redirect to HTTPS
- ACME challenges bypass HTTPS redirect
- noSSL mode works for development

---

### Phase 2: SSL Certificate Management

#### Goals
- Implement SSL certificate monitoring and graceful reload
- Support external ACME client integration (e.g., certbot)
- Handle certificate symlink updates

#### Components
- `src/ssl-manager.esm.js` - Certificate monitoring and reload

#### Implementation Tasks

1. **Certificate File Monitoring**
   - Watch certificate files for changes
   - Detect certificate updates from external ACME client
   - Support certificate symlink targets

2. **Graceful Reload/Restart**
   - Reload SSL certificates without stopping the server
   - Handle certificate update timing issues
   - Implement retry logic for transient failures

3. **Error Handling**
   - Log certificate loading errors
   - Fail fatally if SSL certificate is missing (except in noSSL mode)
   - Provide clear error messages for debugging

#### Testing (Phase 2)
- **Unit Tests**: Certificate file parsing, change detection
- **Integration Tests**: Certificate reload behavior, error handling
- **Manual Tests**: Verify certificate updates trigger reload

#### Success Criteria
- Certificate changes detected and reloaded
- Server continues serving requests during reload
- Invalid certificates fail with clear error messages
- noSSL mode bypasses certificate requirements

---

### Phase 3: Configuration and Routing

#### Goals
- Implement SLID configuration file parsing
- Create comprehensive routing system
- Support dynamic configuration reloading

#### Components
- `src/router.esm.js` - Request routing based on SLID configuration
- `src/config-monitor.esm.js` - Configuration file monitoring
- `src/cli-args.esm.js` - Command-line argument parsing

#### Implementation Tasks

1. **SLID Configuration Parser**
   - Use `NANOS.parseSLID` for configuration parsing
   - Support MIME type mappings
   - Support application root and filesystem root paths
   - Support route definitions

2. **Router Implementation**
   - Implement literal path matching
   - Implement parameter matching (`:name`)
   - Implement applet path matching (`@name`, `@*`)
   - Implement optional parameter matching (`:?name`)
   - Implement tail matching (`:*`)
   - Implement regex pattern matching
   - Implement HTTP method filtering (get, post, put, delete, patch, head, options, any)
   - Implement method shortcuts (read, write, modify)
   - Implement virtual routes with explicit applet paths
   - Implement response codes and redirects
   - Support route-to-pool mapping (for Phase 4)

3. **Configuration Monitoring**
   - Watch SLID configuration file for changes
   - Debounce file change events (500ms default)
   - Reload routes on configuration changes
   - Gracefully handle configuration errors

4. **CLI Argument Parsing**
   - Parse `--no-ssl` flag for development mode
   - Parse `--config` flag for custom configuration file
   - Parse `--log-level` flag for logging control
   - Implement configuration precedence: CLI args > SLID config > Defaults

#### Testing (Phase 3)
- **Unit Tests**: Route matching (40+ test cases)
  - Literal paths
  - Parameter matching
  - Applet paths
  - Optional parameters
  - Tail matching
  - Regex patterns
  - HTTP method filtering
  - Virtual routes
  - Response codes and redirects
- **Unit Tests**: Configuration file parsing
- **Unit Tests**: CLI argument parsing
- **Integration Tests**: Configuration reload behavior
- **Integration Tests**: Route matching with real requests

#### Success Criteria
- All routing patterns work correctly
- Configuration changes trigger route reloads
- CLI arguments override configuration
- Invalid configurations handled gracefully
- 40+ routing tests pass

---

## Production Phase: Multi-Process Architecture (Phase 4+)

The POC was three whole phases. Let's stop numbering the production design as phase 4 sub-phases and give them each a proper, top-level phase.

### Phase 4: Multi-Process Architecture and Infrastructure

#### Overview

Phase 4 represents a fundamental architectural transformation from the single-process prototype to a secure multi-process architecture with privilege separation. This phase establishes critical infrastructure components that support all subsequent development.

**Key Architectural Concepts**:

- **Operator Process** (privileged): Accepts HTTP/HTTPS requests, manages routing, coordinates service process pools
- **Service Processes** (unprivileged sub-processes): Execute applets and send responses via IPC
  - **Responder Processes**: Execute applets and handle requests
  - **Router Processes** (semi-privileged, when `fsRouting` enabled): Perform filesystem-based route resolution
- **Workers** (implementation detail within processes):
  - **Responder Workers**: Run within responder processes to execute applets
  - **Router Workers**: Single implementation that runs in different contexts to perform route resolution
    - When `fsRouting` disabled: Router workers run within the operator process
    - When `fsRouting` enabled: Router workers run within router service processes
- **Routing**: Route resolution always occurs using the same router-worker implementation, but the execution context varies:
  - **Internal Routing** (when `fsRouting` disabled): Router workers execute within the operator process
  - **Delegated Routing** (when `fsRouting` enabled): Router workers execute within router service processes
- **User-Configurable Pools**: Named pools with flexible configuration (inspired by PHP-FPM)
  - **Responder Pools**: `fast`, `standard`, `stream` (and user-defined) - manage responder processes and their workers
  - **Router Pool**: `@router` - manages router workers (and router processes when `fsRouting` enabled)
  - The pool manager is a generic component that handles both process pools and worker pools
- **Flow-Control**: Tiered approach for response streaming to prevent write-blocking

#### Phase 4.1: Logging Infrastructure

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
[2025-11-19T17:30:45.123Z] [INFO] [operator] 192.168.1.100 - "GET /api/users HTTP/1.1" 200 1234 0.045s
```

**Configuration** (in `jsmaws.slid`):
```slid
[(logging=[
  target=console
  level=info
  format=apache
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

**Timeline**: 2-3 days

---

#### Phase 4.2: SSL Configuration Override

**Goal**: Add `--no-ssl` command-line parameter for development/testing.

**Components**:
- `src/cli-args.esm.js` - Command-line argument parser (already created in Phase 3)

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
1. Extend CLI argument parser (from Phase 3)
2. Add `--no-ssl` flag handling
3. Integrate with operator initialization
4. Add warning logs when SSL disabled
5. Update documentation
6. Write tests for argument parsing

**Testing**:
- Unit tests for CLI parser
- Integration tests with/without `--no-ssl`
- Verify HTTPS redirect behavior

**Timeline**: 1 day

---

#### Phase 4.3: Process Architecture Design

**Goal**: Document the new multi-process architecture in detail.

**Deliverables**:
1. IPC protocol specification (see [`arch/ipc-protocol.md`](ipc-protocol.md))
2. Process lifecycle documentation
3. Pool management strategy (see [`arch/pool-configuration-design.md`](pool-configuration-design.md))
4. Security model documentation

**Key Architectural Decisions**:

**Routing Architecture** (Unconditional):

Routing always occurs, but the implementation location varies based on `fsRouting` configuration:

1. **Internal Routing** (when `fsRouting` disabled):
   - Operator performs route resolution internally
   - No additional processes needed
   - Route resolution can be synchronous (simple virtual routes) or asynchronous (database-driven routes)
   - Operator handles routing logic "directly" via same-process workers
   - Router workers perform only virtual-route resolution
   - Filesystem-based routes generate a warning when loaded and are skipped during resolution

2. **Delegated Routing** (when `fsRouting` enabled):
   - Operator delegates route resolution to router processes
   - Router workers perform filesystem-based route resolution
   - Implemented as workers (like responders) to standardize approach
   - Managed via `@router` pool configuration
   - Enables security isolation and scalability for filesystem-based routing

**Process Types**:
- **Operator** (privileged process): Accepts HTTP/HTTPS requests, manages routing (internal or delegated), coordinates responder and router service process pools
- **Router Processes** (when `fsRouting` enabled): Semi-privileged processes that host router workers for filesystem-based route resolution
  - Router workers run within these processes to isolate routing logic from execution environment
  - Retain read access for filesystem traversal
  - No write/execute/network access (except IPC to operator)
- **Responder Processes**: Unprivileged processes that execute applets and send responses via IPC

**IPC Protocol**:
- SLID format headers with binary data separation
- Length-prefixed message framing
- Support for request/response bodies, configuration updates, pool control
- Flow-control signaling via `workersAvailable=0`
- Route request/response messages for delegated routing (when `fsRouting` enabled)

**Pool Configuration**:
- **Router Pool** (`@router`): Special pool for route resolution workers
  - Only used when `fsRouting=@t` is enabled
  - Semi-privileged: retains read access (using non-privileged uid/gid) for filesystem traversal
  - Handles async file access for route matching
  - Recommended: `minProcs=1`, `maxProcs=5` (scale for high-frequency routing)
  - Can scale based on route resolution load
  - Implemented as workers to standardize with responder pool approach and to provide a consistent API from the prospective of the routing algorithm
  
- **Responder Pools**: User-configurable named pools (e.g., `fast`, `standard`, `stream`)
  - Scaling strategies: `static`, `dynamic`, `ondemand`
  - Per-pool configuration: `minProcs`, `maxProcs`, `minWorkers`, `maxWorkers`, `maxReqs`, timeouts
  - Response chunking parameters: `maxDirectWrite`, `autoChunkThresh`, `chunkSize`, `maxWriteBuffer`

**Affinity Tracking**:
- Operator maintains affinity map built from dispatch history
- No IPC reporting needed for affinity
- Enables cache-aware routing and reduced module loading overhead

**Worker Capacity Tracking**:
- Responders report `workersAvailable`, `workersTotal`, `requestsQueued` in responses
- Piggybacked on responses (no extra IPC traffic)
- Enables load-aware request distribution

**Flow-Control Strategy**:
- **Tier 1** (< 64KB): Direct write, no flow-control
- **Tier 2** (64KB - 10MB): Async write with backpressure monitoring
- **Tier 3** (> 10MB): Chunked streaming with event loop yielding
- Backpressure signaling via `workersAvailable=0`

**Timeline**: 2-3 days (design only, no code changes)

---

#### Phase 4.4: Operator Process Implementation

**Goal**: Implement the operator (privileged process) that manages configuration, ports, and service sub-processes.

**Components**:
- `src/operator.esm.js` - Operator process (privileged, runs as root)
- `src/process-manager.esm.js` - Service process lifecycle management (responders and optional routers)
- `src/ipc-protocol.esm.js` - IPC message handling

**Features**:
1. Configuration file loading
2. Port binding (80, 443)
3. Service process spawning (responders and optional routers)
4. Request forwarding via IPC
5. Route resolution delegation (when `fsRouting` enabled)
6. Process health monitoring
7. Graceful shutdown handling
8. Affinity map management
9. Request queuing when capacity exceeded

**Implementation Steps**:
1. Create operator process entry point
2. Implement configuration loading
3. Implement port binding
4. Create IPC protocol handler
5. Implement service process spawning with privilege dropping
6. Implement router process pool management (when `fsRouting` enabled) and router worker pool management (when `fsRouting` disabled)
7. Implement responder process pool management
8. Add health monitoring
9. Implement affinity tracking
10. Add graceful shutdown
11. Write integration tests

**Security Considerations**:
- Operator process (privileged) MUST NOT handle requests directly
- All request data forwarded via IPC to service processes
- No user code execution in operator process
- Validate all IPC messages from service processes (routers and responders)
- Router processes retain read access only (unprivileged uid/gid, no write/execute/network)

**Testing**:
- Unit tests for IPC protocol
- Integration tests for process spawning
- Integration tests for router pool management (when `fsRouting` enabled)
- Security tests (verify no request handling)
- Shutdown behavior tests
- Affinity tracking tests

**Timeline**: 3-4 days

---

#### Phase 4.5: Router Worker and Process Implementation

**Goal**: Implement the single router-worker implementation that can run in either the operator process or dedicated router service processes.

**Components**:
- `src/router-worker.esm.js` - **Single router worker implementation** for hybrid route resolution
  - Handles both virtual routes (always) and filesystem-based routes (when `fsRouting` enabled)
  - Same implementation runs in two different contexts:
    - Within operator process (when `fsRouting` disabled)
    - Within router service processes (when `fsRouting` enabled)
  - `fsRouting` is an operational control parameter that determines if filesystem-based routes are processed or skipped with a warning
- `src/router-process.esm.js` - Router service process entry point (only used when `fsRouting` enabled)
  - Hosts router workers in a separate process for security isolation
  - Semi-privileged: retains read access for filesystem traversal

**Router Worker Features** (always available):
1. Virtual route resolution (always enabled)
2. Filesystem-based route resolution (only when `fsRouting=@t`)
3. Single implementation used in both internal and delegated routing modes
4. Managed by the generic pool manager via `@router` pool configuration

**Router Process Features** (only when `fsRouting=@t`):
1. Receive configuration via IPC from operator
2. Host router workers in isolated process
3. Retain read access for filesystem traversal
4. Handle route request messages from operator
5. Send route response messages back to operator
6. Support configuration updates via IPC

**Implementation Steps**:
1. **Implement router worker** (single implementation for both contexts):
   - Virtual route resolution logic
   - Filesystem-based route resolution logic (conditional on `fsRouting`)
   - Warning generation for filesystem routes when `fsRouting` disabled
   - Integration with pool manager
2. **Create router process entry point** (only for delegated routing):
   - IPC configuration receiver
   - Router worker hosting
   - Route request/response handling
3. **Integrate with operator** (for internal routing):
   - Router worker pool management within operator
   - Direct worker invocation (no IPC)
4. Add error handling and recovery
5. Write unit and integration tests for both contexts

**Privilege Model**:
- Router processes run with reduced privileges
- Retain read access for filesystem traversal
- No write access (except for logging)
- No network access (except IPC to operator)
  - User note: I believe the plan is to use named (i.e. filesystem) sockets
- No execution of user code

**Testing**:
- Unit tests for filesystem route resolution
- Integration tests for route request/response
- IPC communication tests
- Error handling tests (missing files, permission errors)
- Performance tests (route resolution latency)

**Timeline**: 2-3 days

**Note**: This phase is conditional and only implemented when `fsRouting` is enabled in configuration.

---

#### Phase 4.6: Responder Process Implementation

**Goal**: Implement de-privileged responder processes that handle actual requests.

**Components**:
- `src/responder-process.esm.js` - Responder process entry point
- `src/responder-worker.esm.js` - Responder web worker for request handling and response streaming (runs within responder process)

**Features**:
1. Receive configuration via IPC from operator
2. Drop privileges (setuid/setgid)
3. Initialize request handlers
4. Process requests from operator
5. Send responses via IPC
6. Implement flow-control for response streaming
7. Report worker capacity in responses

**Implementation Steps**:
1. Create responder process entry point
2. Implement IPC configuration receiver
3. Implement privilege dropping
4. Integrate router and handlers
5. Implement request processing loop
6. Implement response streaming with flow-control:
   - Tier 1: Direct write for small responses
   - Tier 2: Async write with backpressure for medium responses
   - Tier 3: Chunked streaming for large responses
7. Implement worker capacity reporting
8. Add error handling and recovery
9. Write unit and integration tests

**Privilege Dropping**:

Privileges are dropped at process spawn time using `Deno.Command` options:

```javascript
// In operator.esm.js
async function spawnResponderProcess(config) {
  const uid = config.uid; // Numeric UID from config
  const gid = config.gid; // Numeric GID from config
  
  const command = new Deno.Command('deno', {
    args: ['run', '--allow-read', '--allow-write', '--allow-net', 'src/responder-process.esm.js'],
    uid: uid,  // Drop to this UID
    gid: gid,  // Drop to this GID
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  });
  
  return await command.spawn();
}
```

**Flow-Control Implementation**:

```javascript
// Pseudo-code for response handling with flow-control
async function sendResponse(ipcSocket, response) {
  const bodySize = response.bodySize;
  const maxDirectWrite = config.maxDirectWrite || 65536;
  const autoChunkThresh = config.autoChunkThresh || 10485760;
  const chunkSize = config.chunkSize || 65536;
  const maxWriteBuffer = config.maxWriteBuffer || 1048576;
  
  // Tier 1: Small responses (< 64KB)
  if (bodySize < maxDirectWrite) {
    await ipcSocket.write(response.body);
    return;
  }
  
  // Tier 2/3: Larger responses with flow control
  let offset = 0;
  while (offset < bodySize) {
    const chunk = response.body.slice(offset, offset + chunkSize);
    
    // Check if write buffer is full (backpressure)
    if (ipcSocket.writeBufferSize > maxWriteBuffer) {
      // Wait for buffer to drain
      await ipcSocket.drain();
    }
    
    await ipcSocket.write(chunk);
    offset += chunkSize;
    
    // Yield to event loop to process other requests
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
```

**Testing**:
- Unit tests for privilege dropping
- Integration tests for request handling
- Security tests (verify privileges dropped)
- IPC communication tests
- Flow-control tests:
  - Small response handling
  - Medium response with backpressure
  - Large response with chunking
  - Backpressure signaling

**Timeline**: 3-4 days

---

#### Phase 4.7: Pool and Process Manager Implementation

**Goal**: Implement a generic pool manager that handles both process pools and worker pools, plus a process manager for service process lifecycle.

**Components**:
- `src/pool-manager.esm.js` - **Generic pool manager** supporting all pool types
  - Manages responder process pools and their worker pools
  - Manages router worker pools (within operator when `fsRouting` disabled)
  - Manages router process pools (when `fsRouting` enabled)
  - Single implementation handles both process-level and worker-level pooling
  - Adapts behavior based on pool configuration parameters
- `src/process-manager.esm.js` - Service process lifecycle management
  - Uses pool manager for all pool operations
  - Handles process spawning, monitoring, and recycling

**Features**:
1. Spawn responder processes according to pool configuration
2. Spawn router processes when `fsRouting` enabled
3. Manage router workers within operator when `fsRouting` disabled
4. Track which pool each service process serves
5. Monitor process health and restart on failure
6. Implement scaling strategies (static, dynamic, ondemand)
7. Handle process recycling based on `maxReqs`
8. Manage request queuing when capacity exceeded
9. Collect metrics per process and pool
10. Implement affinity-aware request routing

**Pool Configuration**:

```slid
[(pools=[
  @router=[
    minProcs=1
    maxProcs=5
    scaling=dynamic
    maxReqs=0
    idleTimeout=300
    reqTimeout=30
  ]
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
  stream=[
    minProcs=1
    maxProcs=50
    scaling=ondemand
    maxWorkers=1
    maxReqs=1
    conTimeout=3600
    reqTimeout=0
  ]
])]
```

**Router Pool** (`@router`):
- Special pool for router workers (always needed, regardless of `fsRouting` setting)
- **When `fsRouting` disabled**: Manages router workers within operator process
  - `minWorkers` and `maxWorkers` control worker pool size
  - `minProcs` and `maxProcs` ignored (no separate processes)
  - Workers execute directly in operator context
- **When `fsRouting` enabled**: Manages router service processes and their workers
  - `minProcs` and `maxProcs` control process pool size
  - `minWorkers` and `maxWorkers` control workers per process
  - Semi-privileged processes retain read access for filesystem traversal
- Handles route resolution using the same router-worker implementation in both modes
- Can scale based on route resolution load
- Recommended: `minProcs=1`, `maxProcs=5` (when `fsRouting` enabled)

**Responder Pools**:
- **fast**: Short-duration, high-frequency requests
- **standard**: General application requests
- **stream**: Long-lived streaming connections

**Scaling Strategies**:

- **static**: Fixed process count, no scaling
- **dynamic**: Scale between min/max based on load
- **ondemand**: Spawn on demand, kill after idle timeout

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

**Implementation Steps**:
1. **Implement generic pool manager**:
   - Worker pool management (for all pool types)
   - Process pool management (for responder and router pools)
   - Single implementation adapts based on pool configuration
   - Handles `@router` pool in both internal and delegated modes
2. **Implement process manager**:
   - Service process lifecycle management
   - Uses pool manager for all pool operations
   - Process health monitoring and restart
   - Process recycling based on `maxReqs`
3. Implement all scaling strategies (static, dynamic, ondemand)
4. Implement affinity-aware request routing
5. Implement request queuing
6. Add metrics collection
7. Add configuration validation
8. Write comprehensive tests for both pool manager modes

**Testing**:
- Unit tests for pool logic
- Load tests for scaling behavior
- Failure recovery tests
- Performance benchmarks
- Affinity tracking tests
- Request queuing tests
- Router process pool management tests (when `fsRouting` enabled)

**Timeline**: 4-5 days

---

#### Phase 4.8: Integration and Testing

**Goal**: Integrate all Phase 4 components and verify the complete system.

**Integration Tasks**:
1. Create operator process entry point (replaces prototype server)
2. Migrate existing handlers to responder processes
3. Implement router process spawning (when `fsRouting` enabled)
4. Update configuration loading
5. Add logging throughout
6. Update documentation

**Testing Strategy**:

**Security Tests**:
- Verify operator process never handles requests
- Verify responder processes run as configured user/group
- Verify router processes retain read access only (when `fsRouting` enabled)
- Test IPC message validation
- Verify process isolation

**Performance Tests**:
- Benchmark request throughput
- Measure pool scaling behavior
- Test under high load
- Compare to Phase 3 baseline
- Measure route resolution latency (when `fsRouting` enabled)

**Integration Tests**:
- End-to-end request flow (internal routing)
- End-to-end request flow (delegated routing with routers, when `fsRouting` enabled)
- Configuration reload
- Graceful shutdown
- Process failure recovery
- Pool scaling under load
- Affinity tracking accuracy
- Flow-control under various response sizes
- Router process pool scaling (when `fsRouting` enabled)

**Regression Tests**:
- Verify all Phase 1-3 functionality still works
- Test SSL certificate handling
- Test configuration monitoring
- Test routing logic

**Timeline**: 3-4 days

**Total Phase 4 Timeline**: 19-25 days

---

## Phase 5: Static File Serving

### Goals
- Implement HTTPS static file delivery
- Support range requests (resumable downloads)
- Implement CORS headers

### Components
- `src/static-request.esm.js` - Static file request processor

### Implementation Tasks

1. **Static File Serving**
   - Serve files from configured root directory
   - Support MIME type detection
   - Handle file not found errors

2. **Range Requests**
   - Support HTTP Range header
   - Implement resumable downloads
   - Handle multiple ranges

3. **CORS Headers**
   - Add configurable CORS headers
   - Support preflight requests

### Testing (Phase 5)
- **Unit Tests**: File serving, MIME type detection
- **Integration Tests**: Range requests, CORS headers
- **Performance Tests**: Large file downloads

### Success Criteria
- Static files served correctly
- Range requests work
- CORS headers present
- Performance acceptable

---

## Phase 6: Applet Loading

(Historical design; in current design, applets are just web worker scripts)

### Goals
- Implement JavaScript applet loading
- Support ES module imports
- Support Mesgjs applets via msjsload

### Components
- `src/applet-loader.esm.js` - Applet loading and caching

### Implementation Tasks

1. **ES Module Loading**
   - Load .esm.js files as ES modules
   - Support relative and absolute paths
   - Implement module caching

2. **Mesgjs Support**
   - Support msjsload-transpiled applets
   - Handle Mesgjs runtime integration

3. **Error Handling**
   - Handle missing applets
   - Handle syntax errors
   - Provide clear error messages

### Testing (Phase 6)
- **Unit Tests**: Module loading, caching
- **Integration Tests**: Applet execution
- **Error Tests**: Missing/invalid applets

### Success Criteria
- Applets load correctly
- Module caching works
- Mesgjs applets supported
- Errors handled gracefully

---

## Phase 7: Internal Request Handling

(Historical design; in current design, applet routes are assigned to behavioral "pools")

### Goals
- Implement internal applet request handling
- Restrict to approved, short-running operations
- Use worker threads for isolation

### Components
- `src/worker-manager.esm.js` - Internal request manager

### Implementation Tasks

1. **Worker Thread Management**
   - Create worker thread pool
   - Load applets in workers
   - Execute request handlers

2. **Request Restriction**
   - Enforce timeout limits
   - Restrict resource access
   - Validate request parameters

3. **Response Handling**
   - Collect response from worker
   - Handle worker errors
   - Implement timeout handling

### Testing (Phase 7)
- **Unit Tests**: Worker management, request handling
- **Integration Tests**: Worker execution, timeouts
- **Security Tests**: Resource restrictions

### Success Criteria
- Workers execute applets
- Timeouts enforced
- Resources restricted
- Errors handled

---

## Phase 8: External Request Handling

(Historical design; in current design, applet routes are assigned to behavioral "pools")

### Goals
- Implement external applet request handling
- Spawn isolated sub-processes
- Relay messages between processes

### Components
- `src/subprocess-manager.esm.js` - External request manager

### Implementation Tasks

1. **Sub-Process Management**
   - Spawn sub-processes for external requests
   - Manage sub-process lifecycle
   - Handle sub-process failures

2. **Message Relaying**
   - Forward requests to sub-processes
   - Collect responses from sub-processes
   - Handle streaming responses

3. **Error Handling**
   - Handle sub-process crashes
   - Implement timeout handling
   - Provide error responses

### Testing (Phase 8)
- **Unit Tests**: Sub-process management
- **Integration Tests**: Message relaying, streaming
- **Error Tests**: Crashes, timeouts

### Success Criteria
- Sub-processes spawn correctly
- Messages relay properly
- Streaming works
- Errors handled

---

## Phase 9: WebSocket Support

### Goals
- Implement WebSocket connection handling
- Support WebSocket upgrades
- Handle message passing

### Components
- `src/websocket-handler.esm.js` - WebSocket connection management

### Implementation Tasks

1. **WebSocket Upgrade**
   - Handle WebSocket upgrade requests
   - Validate upgrade headers
   - Establish WebSocket connection

2. **Message Handling**
   - Receive messages from clients
   - Forward to applets
   - Send responses back to clients

3. **Connection Management**
   - Handle connection lifecycle
   - Implement ping/pong
   - Handle disconnections

### Testing (Phase 9)
- **Unit Tests**: WebSocket protocol handling
- **Integration Tests**: Message passing, connections
- **Performance Tests**: Concurrent connections

### Success Criteria
- WebSocket upgrades work
- Messages pass correctly
- Connections managed properly
- Performance acceptable

---

## Phase 10: Integration and Optimization

### Goals
- Integrate all components
- Optimize performance
- Prepare for deployment

### Implementation Tasks

1. **Component Integration**
   - Integrate all modules
   - Verify end-to-end flows
   - Handle edge cases

2. **Performance Optimization**
   - Profile and optimize hot paths
   - Optimize memory usage
   - Optimize request handling

3. **Documentation**
   - Update all documentation
   - Create deployment guide
   - Create troubleshooting guide

### Testing (Phase 10)
- **Integration Tests**: All components together
- **Performance Tests**: Full system benchmarks
- **Stress Tests**: High load scenarios
- **Regression Tests**: All functionality

### Success Criteria
- All components integrated
- Performance meets targets
- Documentation complete
- Ready for deployment

---

## Testing Strategy

### Unit Testing

**Scope**: Individual modules in isolation

**Coverage**:
- Logger formatting and backends
- CLI argument parsing
- Router pattern matching (40+ test cases)
- Configuration parsing
- IPC protocol message handling
- Process manager pool logic
- Flow-control logic
- Static file serving
- Applet loading and caching

**Framework**: Deno's built-in testing framework

**Test Files**: `.test.js` extension

**Approach**:
- Load actual external dependencies where possible
- Mock only when necessary
- Test both success and error paths

### Integration Testing

**Scope**: Multiple components working together

**Coverage**:
- HTTP request flow (HTTP → HTTPS redirect → routing → response)
- Configuration reload triggering route updates
- SSL certificate updates triggering server reload
- IPC request/response round-trip
- Service process spawning and lifecycle
- Pool scaling under load
- Affinity tracking accuracy
- Flow-control under various response sizes
- End-to-end request handling through all layers
- Router process spawning and route resolution (when `fsRouting` enabled)
- Delegated routing flow (when `fsRouting` enabled)

**Approach**:
- Use integration test server
- Test realistic scenarios
- Verify component interactions

### Security Testing

**Scope**: Security-critical functionality

**Coverage**:
- Privilege separation (operator process never handles requests)
- Responder processes run as configured user/group
- Router processes retain read access only (when `fsRouting` enabled)
- IPC message validation
- Process isolation
- Privilege dropping verification
- Access control enforcement

**Approach**:
- Verify process UIDs/GIDs
- Validate IPC message handling
- Test with untrusted input
- Verify isolation boundaries

### Performance Testing

**Scope**: Performance-critical functionality

**Coverage**:
- Request throughput
- Latency under load
- Pool scaling behavior
- Memory usage
- Connection pooling efficiency
- Flow-control overhead
- Static file serving performance
- Applet loading performance
- Route resolution latency (when `fsRouting` enabled)

**Approach**:
- Benchmark against baselines
- Load test with concurrent requests
- Profile memory usage
- Measure latency percentiles

### Configuration Testing

**Scope**: Configuration handling

**Coverage**:
- SLID parsing (various formats and edge cases)
- Route matching with different URL patterns
- File monitoring and change detection
- Invalid configuration handling and recovery
- Pool configuration validation
- CLI argument precedence
- Router process pool configuration (when `fsRouting` enabled)

**Approach**:
- Test valid and invalid configurations
- Test edge cases
- Verify error messages

### WebSocket Testing

**Scope**: WebSocket functionality

**Coverage**:
- Connection handling
- Message relay
- Sub-protocol support
- Connection lifecycle
- Concurrent connections

**Approach**:
- Use WebSocket client library
- Test message passing
- Verify connection management

### Regression Testing

**Scope**: Verify existing functionality still works

**Coverage**:
- All Phase 1-3 functionality
- SSL certificate handling
- Configuration monitoring
- Routing logic
- HTTP/HTTPS behavior

**Approach**:
- Run full test suite after each phase
- Compare behavior to previous phases
- Verify no regressions

---

## Test Execution Plan

### Phase 1 Tests
- HTTP server initialization
- Request handling
- HTTP to HTTPS redirect
- ACME bypass

### Phase 2 Tests
- Certificate file monitoring
- Certificate reload
- Error handling

### Phase 3 Tests
- Route matching (40+ tests)
- Configuration parsing
- CLI argument parsing
- Configuration reload

### Phase 4 Tests
- Logging (all backends)
- IPC protocol
- Service process spawning
- Privilege dropping
- Pool management
- Router process pool management (when `fsRouting` enabled)
- Flow-control
- Affinity tracking
- Security tests

### Phase 5-10 Tests
- Static file serving
- Applet loading
- Worker management
- Sub-process management
- WebSocket handling
- Integration tests
- Performance tests

---

## Success Criteria

### Phase 1
- Server starts without errors
- HTTP requests redirect to HTTPS
- ACME challenges bypass HTTPS redirect
- noSSL mode works for development

### Phase 2
- Certificate changes detected and reloaded
- Server continues serving requests during reload
- Invalid certificates fail with clear error messages
- noSSL mode bypasses certificate requirements

### Phase 3
- All routing patterns work correctly
- Configuration changes trigger route reloads
- CLI arguments override configuration
- Invalid configurations handled gracefully
- 40+ routing tests pass

### Phase 4
- Logging system operational with both console and syslog
- `--no-ssl` flag works correctly
- Operator process successfully spawns responder and router processes
- Responder processes run as configured user/group
- Router processes retain read access only (when `fsRouting` enabled)
- User-configurable pools work with all scaling strategies
- Fast pool handles high-frequency requests efficiently
- Standard pool handles general applet requests
- Stream pool handles long-lived connections (WebSocket)
- Router pool handles route resolution (when `fsRouting` enabled)
- Flow-control prevents write-blocking on large responses
- Affinity tracking improves cache hit rates
- All security tests pass
- Performance meets or exceeds Phase 3 baseline
- All Phase 1-3 functionality still works
- Documentation updated

### Phase 5-10
- All components integrated
- Performance meets targets
- Documentation complete
- Ready for deployment

---

## Risk Assessment

### High Risk
- Process communication overhead may impact performance
- Privilege dropping may fail on some systems
- IPC protocol bugs could cause data corruption
- Flow-control implementation complexity
- Router process async file access performance

### Medium Risk
- Pool sizing may need tuning for different workloads
- Log rotation integration may be complex
- Migration from Phase 3 may reveal edge cases
- Affinity tracking accuracy under high load
- Router pool scaling under high-frequency routing

### Low Risk
- CLI argument parsing
- Log formatting
- Configuration precedence
- Static file serving

---

## Dependencies

### External
- Deno's process spawning APIs
- Deno's HTTP server
- System user/group management
- Syslog daemon (for syslog logging)
- Deno's file watching APIs

### Internal
- SLID parser (NANOS)
- Phase 1-3 components (router, config-monitor, etc.)

---

## Timeline Estimate

- Phase 1 (Basic HTTP Server): 2-3 days
- Phase 2 (SSL Management): 2-3 days
- Phase 3 (Configuration and Routing): 3-4 days
- Phase 4 (Multi-Process Architecture): 19-25 days
  - Phase 4.1 (Logging): 2-3 days
  - Phase 4.2 (SSL Override): 1 day
  - Phase 4.3 (Design): 2-3 days
  - Phase 4.4 (Operator Process): 3-4 days
  - Phase 4.5 (Router Process): 2-3 days
  - Phase 4.6 (Responder Process): 3-4 days
  - Phase 4.7 (Process Manager): 4-5 days
  - Phase 4.8 (Integration): 3-4 days
- Phase 5 (Static File Serving): 2-3 days
- Phase 6 (Applet Loading): 2-3 days
- Phase 7 (Internal Request Handling): 3-4 days
- Phase 8 (External Request Handling): 3-4 days
- Phase 9 (WebSocket Support): 2-3 days
- Phase 10 (Integration and Optimization): 3-4 days

**Total**: 46-62 days

---

## References

- [`arch/ipc-protocol.md`](ipc-protocol.md) - IPC protocol specification
- [`arch/pool-configuration-design.md`](pool-configuration-design.md) - Pool configuration specification
- [`arch/requirements.md`](requirements.md) - Configuration and requirements (including flow-control answer)
- [`arch/worker-module-caching.md`](worker-module-caching.md) - Worker module caching and affinity architecture
- [`arch/service-class-research.md`](service-class-research.md) - Research on servlet container patterns
- [`arch/configuration.md`](configuration.md) - Configuration specification
- [`.kilocode/rules/memory-bank/architecture.md`](../.kilocode/rules/memory-bank/architecture.md) - System architecture overview
