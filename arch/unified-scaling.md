# Unified Scaling Strategy

## Problem Statement

The current implementation has three scaling strategies (`static`, `dynamic`, `ondemand`) that add code complexity and cognitive load without providing meaningful behavioral differences. Analysis reveals:

1. **`ondemand` vs `dynamic` with `minProcs=0`**: Functionally identical
2. **`static` vs `dynamic`/`ondemand` with `minProcs === maxProcs`**: Only difference is that `static` stops the scaling timer, which `dynamic`/`ondemand` should also do
3. **Unnecessary complexity**: Three code paths for what is essentially one parameterized behavior

## Proposed Solution

Replace the three strategies with a **single unified scaling algorithm** that adapts its behavior based on configuration parameters. The strategy name becomes documentation/UX sugar, not a code-level distinction.

## Unified Scaling Algorithm

```javascript
async performScaling() {
    if (this.isShuttingDown) return;
    
    const currentCount = this.items.size;
    const { minProcs, maxProcs, idleTimeout } = this.config;
    
    // Stop timer only when:
    // 1. No scaling is possible (min === max)
    // 2. Current count is within spec (min <= current <= max)
    if (minProcs === maxProcs && currentCount === minProcs) {
        this.stopScalingTimer();
        return;
    }
    
    const idleItems = Array.from(this.items.values()).filter(item => item.isIdle());
    
    // Scale down: Remove idle items beyond minProcs
    if (currentCount > minProcs) {
        for (const item of idleItems) {
            if (this.items.size <= minProcs) break;
            
            const idleTime = item.getIdleTime();
            if (idleTime >= idleTimeout) {
                await this.recycleItem(item.id);
            }
        }
    }
    
    // Scale up: Spawn items if below minProcs
    while (this.items.size < minProcs && this.canSpawnItem()) {
        await this.spawnItem();
    }
    
    // Scale up: Spawn if all busy and below maxProcs
    const availableCount = Array.from(this.items.values())
        .filter(item => item.isAvailable()).length;
    if (availableCount === 0 && this.canSpawnItem()) {
        await this.spawnItem();
    }
}
```

**Key insight**: When configuration changes, the pool may be temporarily out of spec (e.g., 10 processes when new config says `maxProcs=5`). The scaling timer must continue running until the pool converges to the new configuration.

## Configuration Parameters

The unified algorithm is controlled entirely by configuration:

- **`minProcs`**: Minimum processes to maintain (0 = spawn on demand)
- **`maxProcs`**: Maximum processes allowed
- **`idleTimeout`**: Seconds before idle process exits (when above minProcs)
- **`maxReqs`**: Requests before process recycling (0 = unlimited)

## Behavioral Equivalents

### Static Pool (Fixed Size)
```slid
pool=[
    minProcs=4
    maxProcs=4      /* min === max stops scaling timer once at equilibrium */
    idleTimeout=300 /* Ignored (no scaling possible) */
]
```

**Behavior**: Spawns 4 processes at startup, scaling timer stops when count reaches 4, processes never exit due to idleness.

### Dynamic Pool (Baseline with Scaling)
```slid
pool=[
    minProcs=2
    maxProcs=20
    idleTimeout=300 /* Processes beyond minProcs exit after 5 minutes idle */
]
```

**Behavior**: Maintains 2-20 processes based on load, scales down after idle timeout.

### On-Demand Pool (Zero Baseline)
```slid
pool=[
    minProcs=0      /* No baseline processes */
    maxProcs=50
    idleTimeout=60  /* Aggressive cleanup after 1 minute */
]
```

**Behavior**: Spawns processes only when needed, aggressive cleanup when idle.

## Configuration Hot-Reload Handling

When configuration changes mid-operation:

### Scenario 1: Increase Limits
```
Old: minProcs=2, maxProcs=10, current=5
New: minProcs=5, maxProcs=20
```
**Action**: Scaling timer spawns 3 more processes to reach new minimum (5)

### Scenario 2: Decrease Limits
```
Old: minProcs=5, maxProcs=20, current=15
New: minProcs=2, maxProcs=10
```
**Action**: Scaling timer waits for processes to become idle, then recycles down to new maximum (10), then down to new minimum (2) based on idle timeout

### Scenario 3: Change to Fixed Size
```
Old: minProcs=2, maxProcs=20, current=8
New: minProcs=5, maxProcs=5
```
**Action**: 
- If current < 5: Spawn to reach 5
- If current > 5: Wait for idle timeout, recycle down to 5
- Once at 5: Stop scaling timer

**Critical**: Timer must not stop until `currentCount === minProcs === maxProcs`

## Code Simplification

### Remove Strategy Enum
```javascript
// DELETE: ScalingStrategy enum
const ScalingStrategy = {
    STATIC: 'static',
    DYNAMIC: 'dynamic',
    ONDEMAND: 'ondemand',
};
```

### Remove Strategy-Specific Logic
```javascript
// DELETE: Strategy checks in initialize()
const spawnCount = this.config.scaling === ScalingStrategy.ONDEMAND 
    ? 0 
    : this.config.minProcs;
```

Replace references to `spawnCount` with appropriate references to `minProcs`.

```javascript
// DELETE: Strategy-specific timer logic
if (this.config.scaling !== ScalingStrategy.STATIC) {
    this.startScalingTimer();
}

// REPLACE WITH: Always start timer (it will self-stop at equilibrium)
this.startScalingTimer();
```

```javascript
// DELETE: Strategy check in canSpawnItem()
if (this.config.scaling === ScalingStrategy.STATIC) {
    return this.items.size < this.config.minProcs;
}

// REPLACE WITH: Unified logic
return this.items.size < this.config.maxProcs;
```

```javascript
// DELETE: Strategy-specific timer stop in performScaling()
if (this.items.size === this.config.minProcs && this.config.scaling === ScalingStrategy.STATIC) {
    this.stopScalingTimer();
}

// REPLACE WITH: Condition-based timer stop
if (this.config.minProcs === this.config.maxProcs && this.items.size === this.config.minProcs) {
    this.stopScalingTimer();
}
```

### Simplified Validation
```javascript
validateConfig(config) {
    const validated = {
        minProcs: config.minProcs ?? 1,
        maxProcs: config.maxProcs ?? 10,
        minWorkers: config.minWorkers ?? 1,
        maxWorkers: config.maxWorkers ?? 4,
        maxReqs: config.maxReqs ?? 0,
        idleTimeout: config.idleTimeout ?? 300,
        // ... other params
    };
    
    // Validation rules
    if (validated.minProcs < 0) {
        throw new Error(`Invalid minProcs: ${validated.minProcs} (must be >= 0)`);
    }
    if (validated.maxProcs <= 0) {
        throw new Error(`Invalid maxProcs: ${validated.maxProcs} (must be > 0)`);
    }
    if (validated.minProcs > validated.maxProcs) {
        throw new Error(`minProcs (${validated.minProcs}) > maxProcs (${validated.maxProcs})`);
    }
    // DELETE: Static strategy validation
    
    return validated;
}
```

## User Documentation

Instead of explaining three strategies in code, document **effective patterns** in user documentation:

### Static Pool Pattern
**Use case**: Predictable, consistent workloads

**Configuration**:
```slid
pool=[minProcs=4 maxProcs=4]
```

**Characteristics**:
- Fixed process count
- Zero scaling overhead (timer stops at equilibrium)
- Most predictable performance
- Best for: Web servers, API gateways, consistent traffic

### Dynamic Pool Pattern
**Use case**: Variable workloads with baseline demand

**Configuration**:
```slid
pool=[minProcs=2 maxProcs=20 idleTimeout=300]
```

**Characteristics**:
- Maintains baseline capacity
- Scales up under load
- Scales down after idle period
- Best for: Business applications, variable traffic patterns

### On-Demand Pool Pattern
**Use case**: Sporadic, low-frequency workloads

**Configuration**:
```slid
pool=[minProcs=0 maxProcs=50 idleTimeout=60]
```

**Characteristics**:
- Zero baseline (maximum resource efficiency)
- Higher latency on first request
- Aggressive cleanup
- Best for: Batch jobs, webhooks, infrequent tasks

### Streaming Pool Pattern
**Use case**: Long-lived connections (WebSocket, SSE)

**Configuration**:
```slid
pool=[minProcs=0 maxProcs=100 maxReqs=1 maxWorkers=1 idleTimeout=60]
```

**Characteristics**:
- One connection per process
- Process exits when connection closes
- Spawned on demand
- Best for: WebSocket, SSE, long-polling

## Migration Path

### Phase 1: Add Unified Algorithm
- Implement unified `performScaling()` method
- Keep existing strategy enum for backward compatibility
- Map strategy names to configuration:
  - `static` → sets `minProcs === maxProcs` internally
  - `dynamic` → no changes
  - `ondemand` → sets `minProcs = 0` internally

### Phase 2: Deprecate Strategy Parameter
- Update documentation to show configuration-based patterns
- Mark `scaling` parameter as deprecated
- Emit warning if `scaling` is used

### Phase 3: Remove Strategy Code
- Remove `ScalingStrategy` enum
- Remove strategy-specific logic
- Remove `scaling` parameter from configuration
- Update all tests to use configuration patterns

## Benefits

1. **Simpler Code**: Single algorithm instead of three code paths
2. **Less Cognitive Load**: No need to understand strategy differences
3. **More Flexible**: Any combination of parameters works naturally
4. **Easier Testing**: Test one algorithm with different parameters
5. **Better Documentation**: Focus on use cases, not implementation details
6. **Self-Optimizing**: Timer automatically stops when at equilibrium
7. **Hot-Reload Safe**: Handles configuration changes gracefully

## Configuration Examples

### High-Performance Static Pool
```slid
api=[
    minProcs=8
    maxProcs=8
    minWorkers=4
    maxWorkers=8
    maxReqs=10000
]
```

### Elastic Application Pool
```slid
app=[
    minProcs=2
    maxProcs=50
    idleTimeout=300
    maxReqs=1000
]
```

### Serverless-Style Pool
```slid
functions=[
    minProcs=0
    maxProcs=100
    idleTimeout=30
    maxReqs=1
]
```

### Hybrid Pool (Baseline + Burst)
```slid
hybrid=[
    minProcs=5      /* Always-on baseline */
    maxProcs=100    /* Burst capacity */
    idleTimeout=120 /* 2-minute cleanup */
]
```

## Test Migration Strategy

The existing test suite in [`test/pool-manager.test.js`](../test/pool-manager.test.js) has 615 lines organized around the three scaling strategies. Migration approach:

### Phase 1: Parallel Implementation
- Keep existing tests passing during migration
- Add new unified tests alongside strategy-specific tests
- Verify unified algorithm produces same results as strategy-specific code

### Phase 2: Test Refactoring
1. **Configuration Validation Tests** (lines 50-137)
   - Remove: "should validate static scaling requires minProcs == maxProcs" (line 87-97)
   - Keep: All other validation tests (they're strategy-agnostic)

2. **Static Scaling Tests** (lines 139-184)
   - Rename: "Static Scaling" → "Fixed-Size Pool Pattern"
   - Update: Remove `scaling: 'static'` parameter
   - Keep: All test logic (validates `minProcs === maxProcs` behavior)

3. **Dynamic Scaling Tests** (lines 186-278)
   - Rename: "Dynamic Scaling" → "Baseline Pool Pattern"
   - Update: Remove `scaling: 'dynamic'` parameter
   - Keep: All test logic (validates scaling between min/max)

4. **OnDemand Scaling Tests** (lines 280-342)
   - Rename: "OnDemand Scaling" → "Zero-Baseline Pool Pattern"
   - Update: Remove `scaling: 'ondemand'` parameter, keep `minProcs: 0`
   - Keep: All test logic (validates spawn-on-demand behavior)

5. **Configuration Update Tests** (lines 489-539)
   - Update: Line 516-538 test currently validates strategy change
   - Replace: Test timer stop behavior when converging to `minProcs === maxProcs`
   - Add: Test timer continues when pool out of spec after config change

### Phase 3: New Tests
Add tests for unified algorithm edge cases:

```javascript
Deno.test('PoolManager - Unified Scaling', async (t) => {
    await t.step('should stop timer when min === max and at equilibrium', async () => {
        // Test that timer stops only when currentCount === minProcs === maxProcs
    });
    
    await t.step('should continue timer when out of spec after config change', async () => {
        // Start with 10 processes, change to minProcs=5 maxProcs=5
        // Verify timer continues until pool converges to 5
    });
    
    await t.step('should handle any minProcs/maxProcs combination', async () => {
        // Test various combinations: 0/10, 5/5, 2/20, etc.
    });
});
```

### Test Count Impact
- **Before**: 615 lines, ~40 test cases
- **After**: ~550 lines, ~42 test cases (remove 1 validation, add 3 unified tests)
- **Net change**: Fewer lines, slightly more comprehensive coverage

## Conclusion

The three scaling strategies are unnecessary complexity. A single unified algorithm controlled by configuration parameters provides:

- All the same behaviors
- Simpler code
- Less cognitive load
- More flexibility
- Better user experience
- Graceful configuration hot-reload

The "strategy" becomes documentation/UX guidance on how to configure the parameters for different use cases, not a code-level distinction.

The key insight for hot-reload: **Don't stop the scaling timer until the pool has converged to the new configuration** (i.e., `currentCount === minProcs === maxProcs`).

### Implementation Checklist

1. **Code Changes**:
   - [ ] Remove `ScalingStrategy` enum from `pool-manager.esm.js`
   - [ ] Remove `scaling` parameter from config validation
   - [ ] Simplify `initialize()` to always use `minProcs`
   - [ ] Simplify `canSpawnItem()` to remove strategy check
   - [ ] Update `performScaling()` with unified algorithm
   - [ ] Update timer stop condition to check equilibrium

2. **Test Changes**:
   - [ ] Remove static scaling validation test
   - [ ] Rename test suites to pattern-based names
   - [ ] Remove `scaling` parameter from all test configs
   - [ ] Update config change test to verify timer behavior
   - [ ] Add unified scaling edge case tests

3. **Documentation Changes**:
   - [ ] Update `pool-configuration-design.md` to remove strategy references
   - [ ] Add user documentation with pattern examples
   - [ ] Update configuration examples in `jsmaws-config-example.md`