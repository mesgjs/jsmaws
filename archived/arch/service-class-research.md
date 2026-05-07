# Service Class Architecture Research

## Research Goal
Understand how mature servlet containers and application servers handle workload classification, process/thread pooling, and resource management to inform JSMAWS's service class design.

## Apache Tomcat Architecture

### Thread Pool Model (Connectors)
Tomcat uses **Connectors** with configurable thread pools:

```xml
<Connector port="8080" protocol="HTTP/1.1"
           maxThreads="200"
           minSpareThreads="10"
           maxConnections="10000"
           acceptCount="100"
           connectionTimeout="20000"/>
```

**Key Parameters**:
- `maxThreads`: Maximum worker threads (similar to our maxSize)
- `minSpareThreads`: Minimum idle threads (similar to our minSize)
- `maxConnections`: Maximum concurrent connections
- `acceptCount`: Queue size when all threads busy
- `connectionTimeout`: Idle connection timeout

**Key Insight**: Tomcat doesn't classify servlets into different pools by default. All servlets share the same connector thread pool. Classification happens at the **deployment** level (different web apps), not request type.

### Executor Service (Shared Thread Pools)
Tomcat 6+ introduced shared executors:

```xml
<Executor name="tomcatThreadPool" 
          namePrefix="catalina-exec-"
          maxThreads="150" 
          minSpareThreads="4"/>

<Connector executor="tomcatThreadPool" port="8080" protocol="HTTP/1.1"/>
```

**Key Insight**: Multiple connectors can share a thread pool, but there's still no built-in workload classification. The focus is on **resource sharing** and **isolation by deployment unit** (web app).

### Servlet Lifecycle
- Servlets are **long-lived** (initialized once, handle many requests)
- Thread-per-request model (thread from pool handles request, returns to pool)
- No built-in distinction between "fast" vs "slow" servlets

## Node.js Cluster Module

### Process-Based Concurrency
Node.js uses a master-worker process model:

```javascript
if (cluster.isMaster) {
  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
} else {
  // Worker processes handle requests
  http.createServer(app).listen(8000);
}
```

**Key Characteristics**:
- Master process distributes connections to workers
- All workers share the same server port
- No built-in workload classification
- Workers are **homogeneous** (all handle same types of requests)

**Key Insight**: Classification happens at the **application level** (different Node.js apps), not within a single app.

## Nginx + uWSGI/Gunicorn (Python)

### Process Pool Models

**uWSGI**:
```ini
[uwsgi]
processes = 4
threads = 2
cheaper = 2          # Minimum processes
cheaper-algo = spare # Scale down algorithm
```

**Gunicorn**:
```bash
gunicorn --workers 4 --worker-class sync --timeout 30 myapp:app
```

**Worker Classes**:
- `sync`: Synchronous workers (one request at a time)
- `eventlet`/`gevent`: Async workers (many concurrent requests)
- `gthread`: Threaded workers

**Key Insight**: Classification is by **worker type** (sync vs async), not by request characteristics. All requests of a given type go to the same pool.

## PHP-FPM (FastCGI Process Manager)

### Pool Configuration
PHP-FPM supports **multiple named pools**:

```ini
[www]
user = www-data
group = www-data
listen = 127.0.0.1:9000
pm = dynamic
pm.max_children = 50
pm.start_servers = 5
pm.min_spare_servers = 5
pm.max_spare_servers = 35

[api]
user = api-user
group = api-group
listen = 127.0.0.1:9001
pm = ondemand
pm.max_children = 20
```

**Pool Management Strategies**:
- `static`: Fixed number of processes
- `dynamic`: Scale between min/max based on load
- `ondemand`: Spawn on demand, kill when idle

**Key Insight**: PHP-FPM **does support multiple pools** with different configurations! Pools are typically used for:
1. **Security isolation** (different users/groups)
2. **Resource allocation** (different limits per application)
3. **Performance tuning** (different strategies per workload)

Nginx routes to pools via FastCGI configuration:
```nginx
location /api/ {
    fastcgi_pass 127.0.0.1:9001;  # api pool
}
location / {
    fastcgi_pass 127.0.0.1:9000;  # www pool
}
```

## HAProxy + Backend Pools

### Multiple Backend Pools
HAProxy supports routing to different backend pools:

```
frontend http-in
    bind *:80
    acl is_api path_beg /api/
    acl is_static path_beg /static/
    
    use_backend api_pool if is_api
    use_backend static_pool if is_static
    default_backend app_pool

backend api_pool
    balance roundrobin
    server api1 127.0.0.1:8001 maxconn 100
    server api2 127.0.0.1:8002 maxconn 100

backend static_pool
    balance leastconn
    server static1 127.0.0.1:8003 maxconn 500
    server static2 127.0.0.1:8004 maxconn 500
```

**Key Insight**: Load balancers **do classify** requests and route to different backend pools with different characteristics!

## Analysis: Patterns and Lessons

### Common Patterns

1. **Single Homogeneous Pool** (Tomcat, Node.js Cluster)
   - All requests handled by same pool
   - Simple, predictable behavior
   - Classification happens at deployment level (different apps)
   - **Lesson**: Works well when all requests have similar characteristics

2. **Multiple Named Pools** (PHP-FPM, HAProxy)
   - Different pools for different workloads
   - Routing based on request characteristics
   - Each pool has independent configuration
   - **Lesson**: Provides flexibility for heterogeneous workloads

3. **Worker Type Classification** (Gunicorn)
   - Classification by execution model (sync/async)
   - Not by request duration or frequency
   - **Lesson**: Focus on **how** requests are handled, not **what** they do

### Key Lessons for JSMAWS

1. **PHP-FPM is the closest model**: Multiple configurable pools with routing based on request characteristics

2. **Pool parameters that matter**:
   - Min/max size (capacity)
   - Scaling strategy (static/dynamic/ondemand)
   - Process lifecycle (persistent vs one-shot)
   - Timeout values
   - Max requests per process (for memory leak mitigation)

3. **Classification criteria**:
   - **Security**: Different users/groups (PHP-FPM)
   - **Performance**: Different resource limits (HAProxy backends)
   - **Workload**: Different execution characteristics (our use case)

4. **Flexibility vs Simplicity**:
   - Most systems start simple (single pool)
   - Add complexity only when needed
   - User-configurable pools provide maximum flexibility

## Recommendations for JSMAWS

### 1. User-Configurable Service Classes

Define service classes as named pool configurations:

```slid
[(serviceClasses=[
  [
    name=fast
    description="Short-duration, high-frequency requests"
    minProcesses=2
    maxProcesses=10
    scaleStrategy=dynamic
    processLifecycle=persistent
    maxRequestsPerProcess=1000
    idleTimeout=300
    requestTimeout=5
  ]
  [
    name=standard
    description="General application requests"
    minProcesses=1
    maxProcesses=20
    scaleStrategy=dynamic
    processLifecycle=persistent
    maxRequestsPerProcess=100
    idleTimeout=600
    requestTimeout=60
  ]
  [
    name=stream
    description="Long-lived streaming connections"
    minProcesses=1
    maxProcesses=50
    scaleStrategy=ondemand
    processLifecycle=persistent
    maxRequestsPerProcess=1
    connectionTimeout=3600
    requestTimeout=0
  ]
  [
    name=batch
    description="Background batch processing"
    minProcesses=0
    maxProcesses=5
    scaleStrategy=ondemand
    processLifecycle=oneshot
    requestTimeout=300
  ]
])]
```

Let's take a slightly terser approach:
```
classes=[
	fast=[...]
	standard=[...]
	...
]
```
(And I think we've collectively decided that they're now "pools", no longer "classes" - the doc side just hasn't caught up yet)

### 2. Route-to-Class Mapping

Routes reference service classes by name:

```slid
[(routes=[
  [path=/static/* class=fast handler=static]
  [path=/api/health class=fast applet=@health]
  [path=/api/* class=standard applet=@*]
  [path=/ws/* class=stream type=websocket applet=@*]
  [path=/batch/* class=batch applet=@*]
])]
```

### 3. Provide Sensible Defaults

Ship with recommended configurations for common scenarios:
- `config/service-classes-minimal.slid` - Single pool for simple deployments
- `config/service-classes-standard.slid` - Fast/standard/stream for typical use
- `config/service-classes-advanced.slid` - Multiple specialized pools

### 4. Scale Strategy Options

Support multiple scaling strategies (like PHP-FPM):
- `static`: Fixed number of processes
- `dynamic`: Scale between min/max based on load
- `ondemand`: Spawn on demand, kill when idle

### 5. Process Lifecycle Options

- `persistent`: Process handles multiple requests (like PHP-FPM dynamic)
- `oneshot`: Process handles single request then exits (like CGI)

### 6. Key Configuration Parameters

Based on research, these parameters are essential:
- `minProcesses` / `maxProcesses`: Capacity bounds
- `scaleStrategy`: How pool grows/shrinks
- `processLifecycle`: Persistent vs oneshot
- `maxRequestsPerProcess`: Memory leak mitigation
- `idleTimeout`: When to kill idle processes
- `requestTimeout`: Per-request timeout
- `connectionTimeout`: For long-lived connections (WebSocket)

Let's shorten some of these:
- `minProcs`, `maxProcs`
- `scaling`
- `lifecycle` (Isn't this redundant? Isn't `maxReqs` sufficient?)
- `maxReqs`
- `reqTimeout`
- `conTimeout`

## Implementation Strategy

### Phase 4 Approach

1. **Phase 4.1-4.3**: Implement with hardcoded classes (fast/standard/stream)
   - Proves the multi-process architecture
   - Establishes IPC protocol
   - Tests pool management logic

2. **Phase 4.4-4.6**: Add configuration flexibility
   - Make pool parameters configurable
   - Keep class names hardcoded initially

3. **Phase 4.7 or Phase 5**: Full user-configurable classes
   - Allow custom class definitions
   - Validate class references in routes
   - Provide example configurations

### Benefits of This Approach

1. **Incremental complexity**: Start simple, add flexibility
2. **Early validation**: Test core architecture before adding configuration complexity
3. **Backward compatibility**: Can support both hardcoded and custom classes
4. **Learning opportunity**: Real-world usage will inform what parameters matter most

## Open Questions

1. **Should we support class inheritance?** (e.g., `stream` extends `standard`)
2. **How to handle class validation?** (undefined class in route)
3. **Can classes be hot-reloaded?** (or require server restart)
4. **Should we support per-route parameter overrides?** (e.g., custom timeout for specific route)
5. **How to expose pool metrics?** (for monitoring and auto-tuning)

## Conclusion

**Recommendation**: Implement user-configurable service classes similar to PHP-FPM's pool model, but start with hardcoded classes in Phase 4 to validate the architecture. This provides:

1. **Flexibility**: Administrators can tune for their workload
2. **Simplicity**: Sensible defaults for common cases
3. **Proven pattern**: PHP-FPM demonstrates this works well
4. **Future-proof**: Easy to add new parameters as needs emerge

The key insight from research: **Classification by workload characteristics (not just location) is valuable, and user-configurable pools provide the most flexibility.**