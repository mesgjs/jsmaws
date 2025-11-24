# Process Configuration Architecture

## Problem Statement

Currently, configuration parameters are passed through method calls throughout the codebase. This creates several issues:

1. **Error-prone API**: Easy to forget parameters or pass wrong values
2. **Tight coupling**: Methods depend on external configuration state
3. **Poor maintainability**: Configuration changes require updating multiple call sites
4. **Inconsistent patterns**: Different parts of the system handle configuration differently

This is not just a router issue - it affects:
- **Router workers**: Need root, extensions, fsRouting, appRoot
- **Responder workers**: Need pool config, timeouts, chunking settings
- **Service processes**: Need IPC config, logging config, pool settings
- **Pool managers**: Need scaling config, timeout settings

## Solution: Process-Wide Configuration

Implement a configuration pattern that provides centralized, hierarchical configuration access throughout a process.

### Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                   Process (Operator/Router/Responder)      │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │           Configuration                            │    │
│  │  - Holds all process configuration                 │    │
│  │  - Provides scoped access                          │    │
│  │  - Manages configuration updates                   │    │
│  └────────────────┬───────────────────────────────────┘    │
│                   │                                        │
│                   │ provides configuration to              │
│                   ▼                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Components (Router, PoolManager, Workers, etc.)    │   │
│  │  - Hold reference to configuration                  │   │
│  │  - Access config                                    │   │
│  │  - Self-contained, clean APIs                       │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Configuration Class

A centralized configuration holder for a process:

```javascript
class Configuration {
  constructor (config) {
    this.config = config; // Full NANOS configuration
    this.processType = null; // 'operator', 'router', 'responder'
    this.processId = null;
    
    // Cached/computed values
    this._routing = null;
    this._pools = null;
    this._ipc = null;
  }
  
  // Lazy-loaded routing config
  get routing () {
    if (!this._routing) {
      this._routing = {
        root: this.config.at('root', ''),
        appRoot: this.config.at('appRoot', ''),
        extensions: Array.from(this.config.at('extensions', ['.esm.js', '.js'])),
        fsRouting: this.config.at('fsRouting', false)
      };
    }
    return this._routing;
  }
  
  // Lazy-loaded pool config
  get pools () {
    if (!this._pools) {
      this._pools = this.config.at('pools', new NANOS());
    }
    return this._pools;
  }
  
  // Get specific pool config
  getPoolConfig (poolName) {
    return this.pools.at(poolName);
  }
  
  // Update configuration (invalidates caches)
  updateConfig (newConfig) {
    this.config = newConfig;
    this._routing = null;
    this._pools = null;
    this._ipc = null;
  }
}
```

#### 2. Context-Aware Components

All major components hold a reference to the process context:

**Route Class:**
```javascript
class Route {
  constructor(spec, config = null) {
    this.spec = spec;
    this.config = config; // Configuration reference
    this.parseSpec();
  }
  
  setConfig (config) {
    this.config = config;
  }
  
  async match (pathname, method) {
    // Access routing config
    const pathMatch = this.matchPath(pathname, method);
    if (!pathMatch) return null;
    
    if (this.isFilesystem && this.config.routing.fsRouting) {
      return await this.verifyFilesystem(pathMatch);
    }
    
    return pathMatch;
  }
  
  async verifyFilesystem (matchResult) {
    // Access routing config
    const basePath = this.root || this.config.routing.root;
    const extensions = this.config.routing.extensions;
    // ... verification logic
  }
}
```

**Router Class:**
```javascript
class Router {
  constructor (config, fsRouting) {
    this.config = new Configuration(config);
    this.config.routing.fsRouting = fsRouting; // Override if needed
    this.parseConfig();
    
    // Set context on all routes
    for (const route of this.routes) {
      route.setConfig(this.config);
    }
  }
  
  async findRoute (pathname, method) {
    for (const route of this.routes) {
      const match = await route.match(pathname, method); // Clean API!
      if (match) {
        // Apply appRoot resolution using context
        if (route.isVirtual && match.app) {
          match.app = this.resolveAppPath(match.app);
        }
        return { route, match };
      }
    }
    return null;
  }
  
  resolveAppPath (app) {
    if (app === '@static' || app.startsWith('https://') || 
        app.startsWith('http://') || app.startsWith('/')) {
      return app;
    }
    return `${this.config.routing.appRoot}${app}`;
  }
  
  updateConfig (config, fsRouting) {
    this.config.updateConfig(config);
    this.config.routing.fsRouting = fsRouting;
    this.parseConfig();
  }
}
```

**PoolManager Class:**
```javascript
class PoolManager {
  constructor (poolName, poolConfig, itemFactory, context = null) {
    this.poolName = poolName;
    this.config = poolConfig;
    this.itemFactory = itemFactory;
    this.context = context; // Configuration reference
    // ...
  }
  
  setContext (context) {
    this.context = context;
  }
  
  async spawnItem (itemId) {
    // Access pool config via context if needed
    const globalPoolConfig = this.context?.getPoolConfig(this.poolName);
    // Merge with local config
    const effectiveConfig = { ...globalPoolConfig, ...this.config };
    // ...
  }
}
```

**ServiceProcess Base Class:**
```javascript
class ServiceProcess {
  constructor (processType, processId) {
    this.processType = processType;
    this.processId = processId;
    this.context = null; // Set during initialization
    this.config = new NANOS();
  }
  
  async handleConfigUpdate (fields) {
    // Update context with new configuration
    if (!this.context) {
      this.context = new Configuration(fields);
      this.context.processType = this.processType;
      this.context.processId = this.processId;
    } else {
      this.context.updateConfig(fields);
    }
    
    // Propagate to child components
    await this.onConfigUpdate();
  }
  
  // Override in subclasses
  async onConfigUpdate () {
    // Update pool managers, routers, etc.
  }
}
```

### Configuration Hierarchy

The context provides hierarchical access to configuration:

```
Configuration
├── routing
│   ├── root
│   ├── appRoot
│   ├── extensions
│   └── fsRouting
├── pools
│   ├── @router
│   ├── standard
│   ├── fast
│   └── stream
├── ipc
│   ├── timeout
│   └── bufferSize
├── logging
│   ├── level
│   └── destination
└── chunking
    ├── maxDirectWrite
    ├── autoChunkThresh
    └── chunkSize
```

## Benefits

### 1. Consistent Pattern Across System
All components use the same pattern for accessing configuration:
```javascript
// Router
const root = this.context.routing.root;

// PoolManager
const poolConfig = this.context.getPoolConfig('standard');

// Responder
const chunkSize = this.context.chunking.chunkSize;
```

### 2. Clean APIs
```javascript
// Before: Error-prone, many parameters
const match = await route.match(pathname, method, fsRouting, globalRoot, extensions);
const item = await poolManager.spawnItem(itemId, timeout, maxReqs, scaling);

// After: Simple, clear intent
const match = await route.match(pathname, method);
const item = await poolManager.spawnItem(itemId);
```

### 3. Automatic Configuration Propagation
When a process receives a config update via IPC, the context is updated once, and all components automatically see the new configuration.

### 4. Scoped Access
Components only access the configuration they need:
- Routes access `context.routing`
- PoolManagers access `context.pools`
- Responders access `context.chunking`

### 5. Testability
```javascript
// Easy to create test components with mock context
const mockContext = new Configuration(new NANOS({
  root: '/test',
  extensions: new NANOS(['.js']),
  fsRouting: true
}));

const route = new Route(spec, mockContext);
const match = await route.match('/test/path', 'GET');
```

### 6. Single Source of Truth
Configuration lives in Configuration, not scattered across:
- Method parameters
- Constructor arguments
- Global variables
- Instance properties

## Implementation Plan

### Phase 1: Create Configuration Class
1. Implement Configuration with lazy-loaded properties
2. Add configuration access methods
3. Add update mechanism
4. Write unit tests

### Phase 2: Update ServiceProcess Base Class
1. Add context property
2. Update handleConfigUpdate to create/update context
3. Add onConfigUpdate hook for subclasses

### Phase 3: Update Components (Incremental)
1. **Router/Route**: Add context support (backward compatible)
2. **PoolManager**: Add context support
3. **RouterProcess**: Use context in onConfigUpdate
4. **ResponderProcess**: Use context in onConfigUpdate

### Phase 4: Clean Up
1. Remove parameter-based APIs
2. Update all tests
3. Update documentation

## Migration Strategy

The refactoring can be done incrementally without breaking changes:

1. **Add context support** to components (keep old API as fallback)
2. **Update processes** to create and pass context
3. **Migrate call sites** one at a time
4. **Remove old APIs** once everything is migrated

This allows testing at each step and ensures no breaking changes until we're ready.

## Usage Examples

### Router Process
```javascript
class RouterProcess extends ServiceProcess {
  async onStarted () {
    // Context is already set by ServiceProcess base class
    
    // Create router with context
    this.router = new Router(this.context.config, this.context.routing.fsRouting);
    
    // Create pool manager with context
    const routerPoolConfig = this.context.getPoolConfig('@router');
    this.poolManager = new PoolManager('@router', routerPoolConfig, workerFactory);
    this.poolManager.setContext(this.context);
  }
  
  async onConfigUpdate () {
    // Context already updated by base class
    
    // Update router (it will use updated context)
    this.router.updateConfig(this.context.config, this.context.routing.fsRouting);
    
    // Update pool manager
    const routerPoolConfig = this.context.getPoolConfig('@router');
    await this.poolManager.updateConfig(routerPoolConfig);
  }
}
```

### Responder Process
```javascript
class ResponderProcess extends ServiceProcess {
  async handleRequest (id, fields) {
    // Access chunking config via context
    const bodySize = fields.at('bodySize', 0);
    const maxDirectWrite = this.context.chunking?.maxDirectWrite || 65536;
    
    if (bodySize < maxDirectWrite) {
      // Direct write
    } else {
      // Chunked write
      const chunkSize = this.context.chunking?.chunkSize || 65536;
      // ...
    }
  }
}
```

## Testing Strategy

### Unit Tests
- Test Configuration creation and access
- Test configuration updates
- Test lazy loading
- Test scoped access

### Integration Tests
- Test ServiceProcess with context
- Test configuration propagation
- Test component updates on config change

### End-to-End Tests
- Test full process lifecycle with context
- Test IPC config updates
- Test multiple components sharing context

## Conclusion

A process-wide configuration context eliminates parameter passing throughout the system, creates consistent patterns, and improves maintainability. This is not just a router issue - it's a system-wide architectural improvement that will benefit all components.

The implementation can be done incrementally, starting with the most problematic areas (Router/Route) and expanding to other components over time.

[supplemental keywords: configuration management, dependency injection, clean architecture, API design, refactoring, context pattern, process architecture, system-wide patterns]