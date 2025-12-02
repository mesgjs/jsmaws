# Thrashing Prevention and Error Recovery

## Overview

This document assesses potential risks for fatal server component errors and defines mitigations to prevent rapid process respawning (thrashing), resource exhaustion, and cascading failures in JSMAWS.

## Risk Categories

### 1. Process Spawn Thrashing

**Risk**: Service processes crash immediately after spawn, causing rapid respawn loops that exhaust system resources.

**Potential Causes**:
- Configuration errors (invalid paths, permissions)
- Missing dependencies or modules
- Privilege dropping failures (invalid UID/GID)
- Memory exhaustion at startup
- Port binding conflicts (for future multi-instance scenarios)
- Corrupted applet code causing immediate crashes

**Current Mitigations**:
- **Validation at startup**: Operator validates UID/GID configuration before spawning processes ([`operator.esm.js:906-925`](../src/operator.esm.js:906-925))
- **Process monitoring**: ProcessManager tracks process state and exit codes ([`process-manager.esm.js:297-314`](../src/process-manager.esm.js:297-314))
- **Automatic restart**: Failed processes are automatically restarted ([`process-manager.esm.js:308-313`](../src/process-manager.esm.js:308-313))

**Recommended Additional Mitigations**:

1. **Exponential Backoff for Respawns**
   ```javascript
   // In ProcessManager
   class ProcessManager {
     constructor() {
       this.spawnAttempts = new Map(); // processId -> { count, lastAttempt, backoffMs }
       this.maxSpawnAttempts = 5;
       this.baseBackoffMs = 1000;
       this.maxBackoffMs = 60000;
     }
     
     async spawnProcess(type, poolName, poolConfig) {
       const key = `${type}-${poolName}`;
       const attempts = this.spawnAttempts.get(key) || { count: 0, lastAttempt: 0, backoffMs: this.baseBackoffMs };
       
       // Check if we're in backoff period
       const now = Date.now();
       if (now - attempts.lastAttempt < attempts.backoffMs) {
         throw new Error(`Process ${key} in backoff period (${attempts.backoffMs}ms remaining)`);
       }
       
       // Check max attempts
       if (attempts.count >= this.maxSpawnAttempts) {
         this.logger.error(`Process ${key} exceeded max spawn attempts (${this.maxSpawnAttempts})`);
         throw new Error(`Process ${key} spawn limit exceeded - manual intervention required`);
       }
       
       try {
         const process = await this.spawnProcessInternal(type, poolName, poolConfig);
         
         // Reset on successful spawn
         this.spawnAttempts.delete(key);
         return process;
       } catch (error) {
         // Increment attempts and backoff
         attempts.count++;
         attempts.lastAttempt = now;
         attempts.backoffMs = Math.min(
           attempts.backoffMs * 2,
           this.maxBackoffMs
         );
         this.spawnAttempts.set(key, attempts);
         throw error;
       }
     }
   }
   ```

2. **Minimum Uptime Threshold**
   - Track process uptime before considering it "healthy"
   - Only reset spawn attempts if process survives minimum uptime (e.g., 30 seconds)
   - Prevents rapid respawn of processes that crash after initialization
   
   ```javascript
   async monitorProcess(managedProc, stderrConn) {
     const minUptimeMs = 30000; // 30 seconds
     
     const status = await managedProc.process.status;
     const uptime = managedProc.getUptime();
     
     if (uptime < minUptimeMs / 1000) {
       this.logger.error(`Process ${managedProc.id} crashed after ${uptime}s (below minimum ${minUptimeMs/1000}s)`);
       // Don't restart immediately - use backoff
     } else {
       this.logger.warn(`Process ${managedProc.id} exited after ${uptime}s (healthy uptime)`);
       // Can restart with reduced backoff
     }
   }
   ```

3. **Circuit Breaker Pattern**
   - After N consecutive failures, stop attempting to spawn
   - Require manual intervention or configuration change
   - Log detailed error information for diagnosis
   
   ```javascript
   class PoolCircuitBreaker {
     constructor(poolName, threshold = 5, resetTimeoutMs = 300000) {
       this.poolName = poolName;
       this.threshold = threshold;
       this.resetTimeoutMs = resetTimeoutMs;
       this.state = 'closed'; // closed, open, half-open
       this.failureCount = 0;
       this.lastFailureTime = 0;
       this.openedAt = 0;
     }
     
     recordFailure() {
       this.failureCount++;
       this.lastFailureTime = Date.now();
       
       if (this.failureCount >= this.threshold) {
         this.state = 'open';
         this.openedAt = Date.now();
         console.error(`Circuit breaker OPEN for pool ${this.poolName} - manual intervention required`);
       }
     }
     
     canAttempt() {
       if (this.state === 'closed') return true;
       
       // Check if we should try half-open
       if (Date.now() - this.openedAt > this.resetTimeoutMs) {
         this.state = 'half-open';
         return true;
       }
       
       return false;
     }
     
     recordSuccess() {
       this.failureCount = 0;
       this.state = 'closed';
     }
   }
   ```

### 2. Resource Exhaustion

**Risk**: Processes consume excessive memory, CPU, or file descriptors, causing system instability.

**Potential Causes**:
- Memory leaks in applets or server code
- Unbounded buffer growth
- Too many concurrent connections
- File descriptor leaks
- Runaway processes consuming CPU

**Current Mitigations**:
- **Process recycling**: `maxReqs` parameter limits requests per process ([`pool-configuration-design.md:68-72`](../arch/pool-configuration-design.md:68-72))
- **Pool limits**: `maxProcs` caps total processes per pool ([`pool-configuration-design.md:52`](../arch/pool-configuration-design.md:52))
- **Worker limits**: `maxWorkers` caps concurrent requests per process ([`pool-configuration-design.md:62-66`](../arch/pool-configuration-design.md:62-66))
- **Timeout enforcement**: Request, idle, and connection timeouts prevent hung connections ([`pool-configuration-design.md:79-103`](../arch/pool-configuration-design.md:79-103))
- **Buffer limits**: Bidirectional flow control includes `maxBufferSize` ([`responder-process.esm.js:520`](../src/responder-process.esm.js:520))

**Recommended Additional Mitigations**:

1. **Memory Monitoring and Limits**
   ```javascript
   class ProcessManager {
     async monitorResourceUsage() {
       for (const [processId, proc] of this.processes) {
         try {
           // Deno doesn't have built-in process memory monitoring
           // Would need to use external tools or OS-specific APIs
           // For now, rely on OS-level limits (ulimit, cgroups)
           
           // Log warning if process is old and might have memory leaks
           const uptimeHours = proc.getUptime() / 3600;
           if (uptimeHours > 24) {
             this.logger.warn(`Process ${processId} has been running for ${uptimeHours.toFixed(1)} hours - consider recycling`);
           }
         } catch (error) {
           this.logger.error(`Resource monitoring error for ${processId}: ${error.message}`);
         }
       }
     }
   }
   ```

2. **Graceful Degradation Under Load**
   - Return 503 Service Unavailable when at capacity (already implemented: [`responder-process.esm.js:147-151`](../src/responder-process.esm.js:147-151))
   - Implement request queuing with timeout in operator
   - Shed load by rejecting new connections when system is overloaded
   
   ```javascript
   class OperatorProcess {
     constructor() {
       this.requestQueue = [];
       this.maxQueueSize = 1000;
       this.queueTimeout = 30000; // 30 seconds
     }
     
     async forwardToServiceProcess(req, route, match, remote) {
       const process = this.processManager.findProcessForRequest(poolName, appletPath);
       
       if (!process) {
         // Try queuing request
         if (this.requestQueue.length >= this.maxQueueSize) {
           return new Response('503 Service Unavailable - Queue Full', { status: 503 });
         }
         
         return await this.queueRequest(req, route, match, remote);
       }
       
       // Process available - handle immediately
       return await this.handleRequest(process, req, route, match, remote);
     }
   }
   ```

3. **File Descriptor Monitoring**
   - Track open connections and file handles
   - Warn when approaching system limits
   - Force-close oldest idle connections if needed

### 3. Configuration Errors

**Risk**: Invalid configuration causes startup failures or runtime errors.

**Potential Causes**:
- Malformed SLID syntax
- Invalid file paths (applets, certificates, roots)
- Conflicting pool parameters
- Invalid timeout values
- Missing required fields

**Current Mitigations**:
- **Configuration validation**: Pool parameters validated at load time ([`pool-manager.esm.js:138-172`](../src/pool-manager.esm.js:138-172))
- **Privilege validation**: UID/GID checked based on operator privileges ([`operator.esm.js:906-925`](../src/operator.esm.js:906-925))
- **SLID parsing**: Vendor library handles syntax errors

**Recommended Additional Mitigations**:

1. **Configuration Schema Validation**
   ```javascript
   class ConfigurationValidator {
     static validate(config) {
       const errors = [];
       
       // Validate pools
       const pools = config.at('pools');
       if (pools) {
         for (const [poolName, poolConfig] of pools.entries()) {
           // Check required fields
           if (!poolConfig.has('minProcs')) errors.push(`Pool ${poolName}: missing minProcs`);
           if (!poolConfig.has('maxProcs')) errors.push(`Pool ${poolName}: missing maxProcs`);
           if (!poolConfig.has('scaling')) errors.push(`Pool ${poolName}: missing scaling`);
           
           // Validate ranges
           const minProcs = poolConfig.at('minProcs', 0);
           const maxProcs = poolConfig.at('maxProcs', 0);
           if (minProcs > maxProcs) {
             errors.push(`Pool ${poolName}: minProcs (${minProcs}) > maxProcs (${maxProcs})`);
           }
           
           // Validate scaling strategy
           const scaling = poolConfig.at('scaling');
           if (!['static', 'dynamic', 'ondemand'].includes(scaling)) {
             errors.push(`Pool ${poolName}: invalid scaling strategy '${scaling}'`);
           }
           
           // Static pools must have minProcs == maxProcs
           if (scaling === 'static' && minProcs !== maxProcs) {
             errors.push(`Pool ${poolName}: static scaling requires minProcs == maxProcs`);
           }
         }
       }
       
       // Validate routes
       const routes = config.at('routes');
       if (routes) {
         for (const route of routes) {
           const pool = route.at('pool');
           if (pool && !pools?.has(pool)) {
             errors.push(`Route ${route.at('path')}: references undefined pool '${pool}'`);
           }
         }
       }
       
       // Validate file paths
       const certFile = config.at('certFile');
       const keyFile = config.at('keyFile');
       const noSSL = config.at('noSSL', false);
       
       if (!noSSL && (!certFile || !keyFile)) {
         errors.push('SSL enabled but certFile or keyFile not configured');
       }
       
       return errors;
     }
   }
   ```

2. **Configuration Dry-Run Mode**
   - Add `--check-config` flag to validate without starting server
   - Test configuration changes before applying
   - Rollback on validation failure

3. **Safe Configuration Reload**
   - Validate new configuration before applying
   - Keep old configuration if new one is invalid
   - Log validation errors clearly
   
   ```javascript
   async handleConfigUpdate(newConfig) {
     // Validate before applying
     const errors = ConfigurationValidator.validate(newConfig);
     if (errors.length > 0) {
       this.logger.error('Configuration validation failed:');
       errors.forEach(err => this.logger.error(`  - ${err}`));
       this.logger.error('Keeping previous configuration');
       return;
     }
     
     // Apply validated configuration
     this.configData = newConfig;
     // ... rest of update logic
   }
   ```

### 4. Applet Errors

**Risk**: Malicious or buggy applets crash workers or consume excessive resources.

**Potential Causes**:
- Infinite loops
- Excessive memory allocation
- Synchronous blocking operations
- Uncaught exceptions
- Resource leaks (timers, connections)

**Current Mitigations**:
- **Worker isolation**: Each request runs in separate Web Worker ([`responder-process.esm.js:101-122`](../src/responder-process.esm.js:101-122))
- **Permission restrictions**: Workers have limited permissions ([`responder-process.esm.js:105-111`](../src/responder-process.esm.js:105-111))
- **Request timeouts**: Prevent hung workers ([`responder-process.esm.js:175-181`](../src/responder-process.esm.js:175-181))
- **Process recycling**: `maxReqs` limits impact of memory leaks
- **Chunk size limits**: DoS protection via `maxChunkSize` ([`responder-process.esm.js:312-317`](../src/responder-process.esm.js:312-317))

**Recommended Additional Mitigations**:

1. **Worker Resource Limits**
   - Implement CPU time limits (if Deno adds support)
   - Memory limits per worker (OS-level cgroups)
   - Maximum execution time per request

2. **Applet Sandboxing Levels**
   ```javascript
   // Define trust levels for applets
   const AppletTrustLevel = {
     BUILTIN: 'builtin',     // Built-in applets (static-content)
     TRUSTED: 'trusted',     // Reviewed, approved applets
     UNTRUSTED: 'untrusted', // User-provided applets
   };
   
   function getAppletPermissions(appletPath, trustLevel) {
     switch (trustLevel) {
       case AppletTrustLevel.BUILTIN:
         return {
           read: true,
           write: false,
           net: true,
           run: false,
           env: false,
         };
       case AppletTrustLevel.TRUSTED:
         return {
           read: [appletPath],
           write: false,
           net: true,
           run: false,
           env: false,
         };
       case AppletTrustLevel.UNTRUSTED:
         return {
           read: [appletPath],
           write: false,
           net: false, // No network access
           run: false,
           env: false,
         };
     }
   }
   ```

3. **Applet Health Monitoring**
   - Track error rates per applet
   - Automatically disable problematic applets
   - Alert administrators to repeated failures

### 5. IPC Communication Failures

**Risk**: IPC protocol errors cause message loss or process hangs.

**Potential Causes**:
- Malformed messages
- Buffer overflows
- Deadlocks in bidirectional communication
- Pipe buffer exhaustion
- Process crashes during message transmission

**Current Mitigations**:
- **Message validation**: Required fields checked ([`ipc-protocol.esm.js`](../src/ipc-protocol.esm.js))
- **Unified buffering**: Proper handling of partial messages ([`ipc-protocol.esm.js`](../src/ipc-protocol.esm.js))
- **Flow control**: Credit-based system for bidirectional communication ([`arch/bidirectional-flow-control.md`](../arch/bidirectional-flow-control.md))
- **Timeout enforcement**: Prevents hung connections
- **Stream monitoring**: Both stdout and stderr monitored ([`process-manager.esm.js:277-294`](../src/process-manager.esm.js:277-294))

**Recommended Additional Mitigations**:

1. **IPC Health Checks**
   - Periodic ping/pong to verify connection health
   - Detect and recover from silent failures
   - Already implemented: [`process-manager.esm.js:443-457`](../src/process-manager.esm.js:443-457)

2. **Message Sequence Numbers**
   - Detect dropped or duplicate messages
   - Enable message replay on failure
   
   ```javascript
   class IPCConnection {
     constructor() {
       this.sendSeq = 0;
       this.recvSeq = 0;
       this.pendingAcks = new Map();
     }
     
     async writeMessage(message, binaryData) {
       const seq = this.sendSeq++;
       message.fields.set('seq', seq);
       
       // Store for potential replay
       this.pendingAcks.set(seq, { message, binaryData, timestamp: Date.now() });
       
       await this.writeMessageInternal(message, binaryData);
     }
     
     async readMessage() {
       const result = await this.readMessageInternal();
       if (!result) return null;
       
       const seq = result.message.fields.at('seq');
       if (seq !== undefined) {
         // Check for gaps
         if (seq !== this.recvSeq) {
           console.warn(`IPC sequence gap: expected ${this.recvSeq}, got ${seq}`);
         }
         this.recvSeq = seq + 1;
       }
       
       return result;
     }
   }
   ```

3. **Graceful Degradation on IPC Failure**
   - Return 502 Bad Gateway to client
   - Mark process as unhealthy
   - Attempt reconnection or respawn

### 6. Cascading Failures

**Risk**: Failure in one component triggers failures in others.

**Potential Causes**:
- All processes in a pool crash simultaneously
- Operator process crashes
- Configuration file corruption
- SSL certificate expiration
- Disk full / filesystem errors

**Current Mitigations**:
- **Process isolation**: Failures contained to individual processes
- **Pool isolation**: Different workloads in separate pools
- **Automatic restart**: Failed processes respawned
- **Configuration monitoring**: Reloads on file changes ([`config-monitor.esm.js`](../src/config-monitor.esm.js))
- **SSL monitoring**: Certificate updates trigger reload ([`ssl-manager.esm.js`](../src/ssl-manager.esm.js))

**Recommended Additional Mitigations**:

1. **Operator Process Supervision**
   - Run operator under systemd or similar supervisor
   - Automatic restart on crash
   - Rate limiting on restarts
   
   ```ini
   # systemd unit file example
   [Unit]
   Description=JSMAWS Operator Process
   After=network.target
   
   [Service]
   Type=simple
   User=root
   ExecStart=/usr/bin/deno run --allow-all /opt/jsmaws/src/operator.esm.js
   Restart=on-failure
   RestartSec=10s
   StartLimitInterval=300s
   StartLimitBurst=5
   
   [Install]
   WantedBy=multi-user.target
   ```

2. **Health Check Endpoint**
   - Expose `/health` endpoint for monitoring
   - Return detailed status of all pools
   - Enable external monitoring systems to detect issues
   
   ```javascript
   async handleHealthEndpoint(req) {
     const health = {
       status: 'ok',
       timestamp: new Date().toISOString(),
       uptime: Math.floor(performance.now() / 1000),
       pools: {},
     };
     
     for (const [poolName, poolSet] of this.processManager.poolProcesses) {
       const stats = this.processManager.getPoolStats(poolName);
       health.pools[poolName] = {
         processCount: stats.processCount,
         readyCount: stats.readyCount,
         busyCount: stats.busyCount,
         availableWorkers: stats.availableWorkers,
       };
       
       // Mark unhealthy if no ready processes
       if (stats.readyCount === 0) {
         health.status = 'degraded';
       }
     }
     
     const status = health.status === 'ok' ? 200 : 503;
     return new Response(JSON.stringify(health), {
       status,
       headers: { 'Content-Type': 'application/json' },
     });
   }
   ```

3. **Bulkhead Pattern**
   - Isolate critical vs. non-critical workloads
   - Prevent non-critical failures from affecting critical services
   - Already partially implemented via pool separation

### 7. Deadlocks and Race Conditions

**Risk**: Concurrent operations cause deadlocks or data corruption.

**Potential Causes**:
- Multiple processes accessing shared resources
- Race conditions in pool scaling
- Concurrent configuration updates
- Bidirectional flow control deadlocks

**Current Mitigations**:
- **Process isolation**: No shared memory between processes
- **IPC serialization**: Messages processed sequentially
- **Credit-based flow control**: Prevents deadlocks in bidirectional communication
- **Route spec in closure**: Prevents race conditions in concurrent requests ([`operator.esm.js:383-384`](../src/operator.esm.js:383-384))

**Recommended Additional Mitigations**:

1. **Configuration Update Locking**
   ```javascript
   class OperatorProcess {
     constructor() {
       this.configUpdateLock = false;
     }
     
     async handleConfigUpdate(newConfig) {
       if (this.configUpdateLock) {
         this.logger.warn('Configuration update already in progress, skipping');
         return;
       }
       
       this.configUpdateLock = true;
       try {
         await this.applyConfigUpdate(newConfig);
       } finally {
         this.configUpdateLock = false;
       }
     }
   }
   ```

2. **Pool Scaling Coordination**
   - Ensure only one scaling operation per pool at a time
   - Use atomic operations for process count tracking
   - Already implemented via single-threaded event loop

3. **Timeout on All Async Operations**
   - Never wait indefinitely
   - All promises should have timeouts
   - Use `Promise.race()` with timeout promises

## Implementation Priority

### High Priority (Implement Immediately)
1. **Exponential backoff for process respawns** - Prevents thrashing
2. **Circuit breaker for pools** - Stops repeated failures
3. **Configuration validation** - Prevents startup failures
4. **Minimum uptime threshold** - Detects immediate crashes

### Medium Priority (Implement Soon)
1. **Health check endpoint** - Enables monitoring
2. **Graceful degradation under load** - Improves reliability
3. **Safe configuration reload** - Prevents runtime errors
4. **Resource usage monitoring** - Detects leaks early

### Low Priority (Future Enhancement)
1. **Message sequence numbers** - Improves debugging
2. **Applet trust levels** - Enhanced security
3. **Advanced metrics** - Better observability
4. **Operator supervision** - Production deployment

## Testing Strategy

### Unit Tests
- Test backoff logic with mock process spawns
- Test circuit breaker state transitions
- Test configuration validation with invalid configs
- Test timeout enforcement

### Integration Tests
- Simulate process crashes and verify recovery
- Test configuration reload with invalid configs
- Test resource exhaustion scenarios
- Test cascading failure scenarios

### Chaos Engineering
- Randomly kill processes during load testing
- Corrupt configuration files during operation
- Exhaust file descriptors
- Fill disk during operation
- Network partition between operator and processes

## Monitoring and Alerting

### Key Metrics to Track
- Process spawn rate and failure rate
- Process uptime distribution
- Request queue depth
- Error rates per pool and applet
- Resource usage (memory, CPU, file descriptors)
- IPC message latency
- Configuration reload frequency

### Alert Conditions
- Process spawn failures exceed threshold
- Circuit breaker opens for any pool
- Request queue exceeds capacity
- Error rate exceeds threshold
- Resource usage exceeds limits
- Configuration validation failures

## Recovery Procedures

### Process Thrashing
1. Check logs for root cause
2. Fix configuration or applet code
3. Reset circuit breaker manually if needed
4. Restart operator process

### Resource Exhaustion
1. Identify resource-hungry processes
2. Reduce pool sizes temporarily
3. Recycle long-running processes
4. Investigate and fix leaks

### Configuration Errors
1. Rollback to last known good configuration
2. Validate new configuration offline
3. Apply fixes and reload

### Cascading Failures
1. Identify root cause component
2. Isolate affected pools
3. Restart operator if needed
4. Gradually restore service

## Conclusion

JSMAWS has solid foundations for error handling and recovery, but additional mitigations are needed to prevent thrashing and cascading failures in production environments. The recommended mitigations focus on:

1. **Prevention**: Configuration validation, resource limits
2. **Detection**: Health checks, monitoring, circuit breakers
3. **Recovery**: Exponential backoff, graceful degradation
4. **Isolation**: Pool separation, process isolation

Implementing the high-priority mitigations will significantly improve system resilience and prevent the most common failure modes.
