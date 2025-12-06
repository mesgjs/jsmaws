# Bidirectional Parameters Configuration Method

**Status**: [APPROVED] - Implementation Complete

## Overview

This document describes the implementation plan for a `.getBidiParams()` configuration method that eliminates the need for the Bidi Params frame by allowing both operator and responder to independently derive the same bidirectional flow control parameters from configuration.

## Problem Statement

Currently, bidirectional flow control parameters are distributed via a dedicated "Bidi Params frame" sent from responder to operator after a WebSocket upgrade is accepted:

```javascript
// Current implementation (responder-process.esm.js:548-557)
const frameMsg = createFrame(id, {
  final: false,
  keepAlive: true,
  initialCredits,
  maxChunkSize,
  maxBytesPerSecond: connState.maxBytesPerSecond,
  idleTimeout: connState.idleTimeout,
  maxBufferSize: connState.maxBufferSize
});
await this.ipcConn.writeMessage(frameMsg);
```

**Issues with current approach:**
1. **Redundant IPC message**: Both operator and responder have access to the same configuration
2. **Race condition potential**: Operator must wait for params frame before initializing connection state
3. **Inconsistency risk**: If responder and operator calculate params differently, they diverge
4. **Complexity**: Extra message type and handling logic

## Solution: Configuration-Based Parameter Resolution

Following the successful pattern of `getTimeoutConfig()`, implement a `getBidiParams()` method that:
1. Uses the same three-tier hierarchy: **route > pool > global**
2. Returns all bidirectional flow control parameters
3. Ensures operator and responder derive identical parameters from the same configuration
4. Eliminates the need for the Bidi Params frame

## Design

### Configuration Method API

```javascript
/**
 * Get bidirectional flow control parameters with hierarchy: route > pool > global
 * @param {Object} options - Options object
 * @param {string} [options.poolName] - Pool name (optional if routeSpec has pool field)
 * @param {NANOS|null} [options.routeSpec] - Route specification (optional)
 * @returns {Object} Bidi parameters with all flow control settings
 */
getBidiParams({ poolName, routeSpec } = {}) {
  // Extract poolName from routeSpec if not explicitly provided
  if (!poolName && routeSpec) {
    poolName = routeSpec.at('pool');
  }
  
  // Default to 'standard' pool
  poolName = poolName || 'standard';
  
  // Global defaults (lowest priority)
  const bidiConfig = this.config.at('bidiFlowControl') || { at(_n, d) { return d; } };
  const chunkSize = this.chunking.chunkSize;
  
  const defaults = {
    initialCredits: (bidiConfig.at('initialCredits', 10)) * chunkSize,
    maxChunkSize: chunkSize,
    maxBytesPerSecond: bidiConfig.at('maxBytesPerSecond', 10485760),
    idleTimeout: bidiConfig.at('idleTimeout', 60),
    maxBufferSize: bidiConfig.at('maxBufferSize', 1048576)
  };

  // Pool overrides (medium priority)
  const poolConfig = this.getPoolConfig(poolName);
  const poolBidiConfig = poolConfig?.at('bidiFlowControl');
  const poolParams = {
    initialCredits: poolBidiConfig?.at('initialCredits') 
      ? poolBidiConfig.at('initialCredits') * chunkSize 
      : defaults.initialCredits,
    maxChunkSize: poolConfig?.at('maxChunkSize', defaults.maxChunkSize) ?? defaults.maxChunkSize,
    maxBytesPerSecond: poolBidiConfig?.at('maxBytesPerSecond', defaults.maxBytesPerSecond) ?? defaults.maxBytesPerSecond,
    idleTimeout: poolBidiConfig?.at('idleTimeout', defaults.idleTimeout) ?? defaults.idleTimeout,
    maxBufferSize: poolBidiConfig?.at('maxBufferSize', defaults.maxBufferSize) ?? defaults.maxBufferSize
  };

  // Route overrides (highest priority)
  if (routeSpec) {
    const routeBidiConfig = routeSpec.at('bidiFlowControl');
    return {
      initialCredits: routeBidiConfig?.at('initialCredits')
        ? routeBidiConfig.at('initialCredits') * chunkSize
        : poolParams.initialCredits,
      maxChunkSize: routeSpec.at('maxChunkSize', poolParams.maxChunkSize),
      maxBytesPerSecond: routeBidiConfig?.at('maxBytesPerSecond', poolParams.maxBytesPerSecond) ?? poolParams.maxBytesPerSecond,
      idleTimeout: routeBidiConfig?.at('idleTimeout', poolParams.idleTimeout) ?? poolParams.idleTimeout,
      maxBufferSize: routeBidiConfig?.at('maxBufferSize', poolParams.maxBufferSize) ?? poolParams.maxBufferSize
    };
  }

  return poolParams;
}
```

### Configuration Hierarchy

```
Route Configuration > Pool Configuration > Global Configuration
```

**Example SLID Configuration:**

```slid
[(
  /* Global defaults */
  bidiFlowControl=[
    initialCredits=10          /* Multiplier (× maxChunkSize) */
    maxBytesPerSecond=10485760 /* 10MB/s */
    idleTimeout=60             /* 60 seconds */
    maxBufferSize=1048576      /* 1MB */
  ]
  chunkSize=65536              /* 64KB (used for maxChunkSize) */
  
  pools=[
    stream=[
      bidiFlowControl=[
        initialCredits=20      /* Override: 20 × 64KB = 1.28MB */
        idleTimeout=300        /* Override: 5 minutes */
      ]
      /* maxChunkSize inherits global: 64KB */
      /* maxBytesPerSecond inherits global: 10MB/s */
      /* maxBufferSize inherits global: 1MB */
    ]
    
    fast=[
      maxChunkSize=32768       /* Override: 32KB chunks */
      bidiFlowControl=[
        initialCredits=5       /* Override: 5 × 32KB = 160KB */
        maxBytesPerSecond=5242880  /* Override: 5MB/s */
      ]
    ]
  ]
  
  routes=[
    [
      path=/api/chat
      pool=stream
      bidiFlowControl=[
        idleTimeout=600        /* Override: 10 minutes for chat */
      ]
    ]
    [
      path=/api/realtime
      pool=fast
      maxChunkSize=16384       /* Override: 16KB chunks */
      bidiFlowControl=[
        initialCredits=10      /* Override: 10 × 16KB = 160KB */
      ]
    ]
  ]
)]
```

### Parameter Descriptions

All parameters support the three-tier hierarchy:

1. **`initialCredits`** (multiplier, default: 10)
   - Multiplied by `maxChunkSize` to get actual byte credits
   - Example: `initialCredits=10` × `maxChunkSize=65536` = 655,360 bytes (640KB)
   - Higher values allow larger bursts but use more memory

2. **`maxChunkSize`** (bytes, default: from `chunkSize` config)
   - Maximum bytes per frame chunk
   - Enforced as security limit (applet terminated if exceeded)
   - Can be overridden at pool or route level

3. **`maxBytesPerSecond`** (bytes/second, default: 10485760 / 10MB/s)
   - Rate limit per connection
   - Connection closed if exceeded
   - Measured as rolling average over 1-second windows

4. **`idleTimeout`** (seconds, default: 60)
   - Maximum idle time between frames
   - Connection closed if no activity for this duration
   - Set to 0 to disable

5. **`maxBufferSize`** (bytes, default: 1048576 / 1MB)
   - Maximum buffered data per direction per connection
   - Connection closed if buffer exceeds this limit
   - Should be ≥ `initialCredits × maxChunkSize`

## Implementation Plan

### Phase 1: Configuration Class Update

**File**: `src/configuration.esm.js`

1. Add `getBidiParams({ poolName, routeSpec })` method
2. Extract `poolName` from `routeSpec` if not provided
3. Implement three-tier hierarchy resolution
4. Handle `initialCredits` multiplier calculation
5. Add cache invalidation in `updateConfig()` and `mergeConfig()`

**Key Implementation Details:**
- Options object API: `{ poolName, routeSpec }`
- `poolName` extracted from `routeSpec.at('pool')` if not provided
- `initialCredits` is stored as multiplier, calculated as `multiplier × maxChunkSize`
- `maxChunkSize` can be overridden independently at each level
- All parameters use nullish coalescing (`??`) for proper 0-value handling
- Cache `_bidiRouteParams` map for performance (keyed by `poolName:routeSpecHash`)

### Phase 2: Responder Process Update

**File**: `src/responder-process.esm.js`

**Changes to `initializeBidiConnection()`** (lines 511-558):

```javascript
async initializeBidiConnection(id, requestInfo) {
  // Get bidi parameters from configuration (same as operator will use)
  // routeSpec already contains pool name, so we can pass just routeSpec
  const bidiParams = this.config.getBidiParams({ 
    routeSpec: requestInfo.routeSpec 
  });
  
  const connState = {
    worker: requestInfo.worker,
    outboundCredits: bidiParams.initialCredits,
    inboundCredits: bidiParams.initialCredits,
    outboundBuffer: [],
    inboundBuffer: [],
    maxBufferSize: bidiParams.maxBufferSize,
    totalBuffered: { outbound: 0, inbound: 0 },
    maxCredits: bidiParams.initialCredits,
    maxBytesPerSecond: bidiParams.maxBytesPerSecond,
    idleTimeout: bidiParams.idleTimeout,
    lastActivity: Date.now()
  };

  this.bidiConnections.set(id, connState);

  // Send protocol parameters to applet (unchanged)
  requestInfo.worker.postMessage({
    type: 'frame',
    id,
    mode: 'bidi',
    initialCredits: bidiParams.initialCredits,
    maxChunkSize: bidiParams.maxChunkSize,
    maxBytesPerSecond: bidiParams.maxBytesPerSecond,
    idleTimeout: bidiParams.idleTimeout,
    maxBufferSize: bidiParams.maxBufferSize,
    data: null,
    final: false,
    keepAlive: true
  });

  // REMOVE: No longer send params frame to operator
  // The operator will derive the same params from configuration
}
```

**Additional Changes:**
- Store `routeSpec` in `requestInfo` during `handleWebRequest()` (line 161)
- Remove IPC params frame sending (lines 548-557)

### Phase 3: Operator Process Update

**File**: `src/operator-process.esm.js`

**Changes to bidi connection initialization:**

Currently, operator waits for params frame from responder. Instead, it should:

1. Derive params from configuration when handling bidi upgrade
2. Initialize connection state immediately (no waiting)
3. Remove params frame handling logic

**New approach in `handleBidiUpgrade()` (operator-request-state.esm.js):**

```javascript
// In handleBidiParams state handler
async handleBidiParams(message, binaryData) {
  // REMOVE: No longer receive params from responder
  // Instead, derive from configuration
  
  // routeSpec already contains pool name
  const bidiParams = this.operator.configuration.getBidiParams({
    routeSpec: this.context.routeSpec
  });
  
  // Initialize bidi connection state with derived params
  const connState = {
    socket: this.context.socket,
    process: this.context.process,
    outboundCredits: bidiParams.initialCredits,
    inboundCredits: bidiParams.initialCredits,
    outboundBuffer: [],
    inboundBuffer: [],
    maxBufferSize: bidiParams.maxBufferSize,
    totalBuffered: { outbound: 0, inbound: 0 },
    maxCredits: bidiParams.initialCredits,
    lastActivity: Date.now()
  };
  
  this.operator.bidiConnections.set(this.context.requestId, connState);
  
  // Transition to bidi frame handling
  this.context.state = 'bidi_frame';
}
```

### Phase 4: IPC Protocol Update

**File**: `src/ipc-protocol.esm.js`

**Changes:**
1. Remove bidi params fields from frame message creation (if they exist as special case)
2. Update `createFrame()` to not include params in second frame
3. Update documentation to reflect params are configuration-derived

**Note**: The current implementation already uses generic frame messages, so this may be minimal or no changes needed.

### Phase 5: Request State Machine Update

**File**: `src/operator-request-state.esm.js`

**Changes to `handleBidiParams()` state:**

```javascript
async handleBidiParams(message, binaryData) {
  // Derive params from configuration instead of receiving from responder
  const bidiParams = this.operator.configuration.getBidiParams({
    routeSpec: this.context.routeSpec
  });
  
  // Initialize bidi connection state
  const connState = {
    socket: this.context.socket,
    process: this.context.process,
    outboundCredits: bidiParams.initialCredits,
    inboundCredits: bidiParams.initialCredits,
    outboundBuffer: [],
    inboundBuffer: [],
    maxBufferSize: bidiParams.maxBufferSize,
    totalBuffered: { outbound: 0, inbound: 0 },
    maxCredits: bidiParams.initialCredits,
    lastActivity: Date.now()
  };
  
  this.operator.bidiConnections.set(this.context.requestId, connState);
  
  // Set up WebSocket message handler
  this.context.socket.onmessage = (event) => {
    this.operator.handleClientBidiMessage(
      this.context.requestId,
      event.data,
      connState
    );
  };
  
  // Transition to bidi frame handling
  this.context.state = 'bidi_frame';
  
  // Note: No need to wait for next message - we're ready immediately
  // The next frame from responder will be actual data, not params
}
```

### Phase 6: Documentation Updates

**Files to update:**
1. `arch/bidirectional-flow-control.md` - Update protocol parameters section
2. `arch/frame-based-protocol.md` - Remove bidi params frame documentation
3. `arch/unified-protocol-assessment.md` - Update with configuration-based approach
4. `.kilocode/rules/memory-bank/architecture.md` - Update key decisions

**Key documentation changes:**
- Remove references to "Bidi Params frame"
- Add documentation for `getBidiParams()` method
- Update sequence diagrams to show configuration-based initialization
- Add examples of hierarchical parameter configuration

### Phase 7: Testing

**Test files to create/update:**

1. **`test/bidi-params-configuration.test.js`** (new)
   - Test `getBidiParams()` method
   - Test options object API: `{ poolName, routeSpec }`
   - Test poolName extraction from routeSpec
   - Test hierarchy: route > pool > global
   - Test `initialCredits` multiplier calculation
   - Test all parameter types
   - Test edge cases (null route spec, missing configs)
   - Test typical pool configurations

2. **`test/responder-process.test.js`** (update)
   - Update bidi initialization tests
   - Verify params derived from configuration
   - Verify no params frame sent to operator

3. **`test/request-state-machine.test.js`** (update)
   - Update bidi upgrade tests
   - Verify params derived from configuration
   - Verify immediate state transition (no waiting)

4. **Integration tests** (new)
   - End-to-end WebSocket upgrade with configuration-based params
   - Verify operator and responder use identical params
   - Test with various configuration hierarchies

## Benefits

1. **Eliminates redundant IPC message**: One less message type to handle
2. **Removes race condition**: No waiting for params frame
3. **Ensures consistency**: Both sides derive from same configuration
4. **Simplifies code**: Less state management, fewer edge cases
5. **Follows established pattern**: Consistent with `getTimeoutConfig()`
6. **Better testability**: Configuration-based logic is easier to test
7. **More flexible**: Easy to add route-specific overrides
8. **Cleaner API**: Options object with smart defaults (poolName from routeSpec)

## Migration Path

This is a **breaking change** that requires coordinated updates:

1. Update Configuration class first (backward compatible)
2. Update responder to use new method (still sends params frame for compatibility)
3. Update operator to use new method (ignores params frame if received)
4. Remove params frame sending from responder
5. Remove params frame handling from operator
6. Update tests and documentation

**Rollback strategy**: Keep params frame handling in operator as fallback during transition period.

## Example Usage

### Global Configuration
```slid
[(
  bidiFlowControl=[
    initialCredits=10
    maxBytesPerSecond=10485760
    idleTimeout=60
    maxBufferSize=1048576
  ]
  chunkSize=65536
)]
```

### Pool-Specific Configuration
```slid
[(
  pools=[
    stream=[
      bidiFlowControl=[
        initialCredits=20      /* 20 × 64KB = 1.28MB */
        idleTimeout=300        /* 5 minutes */
      ]
    ]
  ]
)]
```

### Route-Specific Configuration
```slid
[(
  routes=[
    [
      path=/api/chat
      pool=stream
      bidiFlowControl=[
        idleTimeout=600        /* 10 minutes for chat */
      ]
    ]
  ]
)]
```

### Code Usage

```javascript
// In responder - poolName extracted from routeSpec
const bidiParams = this.config.getBidiParams({ 
  routeSpec: requestInfo.routeSpec 
});
// Returns: {
//   initialCredits: 655360,    // 10 × 65536
//   maxChunkSize: 65536,
//   maxBytesPerSecond: 10485760,
//   idleTimeout: 60,
//   maxBufferSize: 1048576
// }

// In operator - same approach
const bidiParams = this.configuration.getBidiParams({
  routeSpec: this.context.routeSpec
});
// Returns identical object

// Can also specify poolName explicitly if needed
const bidiParams = this.config.getBidiParams({ 
  poolName: 'stream',
  routeSpec: null  // Use pool config only
});

// Or just poolName for pool-level defaults
const bidiParams = this.config.getBidiParams({ 
  poolName: 'fast'
});
```

## Risks and Mitigations

### Risk 1: Configuration Mismatch
**Risk**: Operator and responder might calculate different params if configuration is inconsistent.

**Mitigation**: 
- Use identical calculation logic in single method
- Both processes use same Configuration instance
- Add validation tests to ensure consistency

### Risk 2: Breaking Change
**Risk**: Existing deployments might break during upgrade.

**Mitigation**:
- Implement gradual migration path
- Keep params frame handling as fallback initially
- Document upgrade procedure clearly

### Risk 3: Performance Impact
**Risk**: Calculating params on every request might be slower than caching.

**Mitigation**:
- Cache calculated params in Configuration class
- Invalidate cache only on config updates
- Use efficient lookup (Map keyed by poolName:routeSpecHash)

## Success Criteria

1. ✅ `getBidiParams({ poolName, routeSpec })` method implemented and tested
2. ✅ poolName extraction from routeSpec works correctly
3. ✅ Responder derives params from configuration
4. ✅ Operator derives params from configuration
5. ✅ Bidi params frame removed from IPC protocol
6. ✅ All tests passing (unit, integration, end-to-end)
7. ✅ Documentation updated
8. ✅ No performance regression
9. ✅ Operator and responder always derive identical params

## References

- [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) - Flow control protocol
- [`src/configuration.esm.js`](../src/configuration.esm.js) - Configuration class
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) - Responder implementation
- [`src/operator-request-state.esm.js`](../src/operator-request-state.esm.js) - Request state machine
- [`test/timeout-configuration.test.js`](../test/timeout-configuration.test.js) - Similar pattern for timeouts

[supplemental keywords: bidirectional parameters, configuration hierarchy, flow control, credit-based flow control, parameter resolution, route configuration, pool configuration, global configuration, IPC optimization, protocol simplification, options object API]