# JSMAWS Service API Design

**Status:** [DRAFT]  
**Date:** 2026-04-27  
**Updated:** 2026-05-04

---

## 1. Problem Statement

JSMAWS applets currently have no server-provided mechanism for calling server-side services. An applet that needs to query a database, read from a cache, call an external API, or invoke any other server-side capability must:

1. Establish its own connection (using `Deno.connect`, `fetch`, etc.)
2. Manage credentials directly (hardcoded or via environment variables it can't access \[note: this is covered under another proposal\])
3. Handle connection pooling itself (one-shot workers make this impossible)
4. Implement its own error handling and retry logic

This is impractical for most real-world applications. The goal is a **modular, pluggable** Service API that:

- Provides applets with access to configured server-side services
- Manages connection pooling at the service-process level (not per-worker or per-responder)
- Keeps credentials out of applet code (see [env-secrets-design.md](env-secrets-design.md))
- Supports multiple service types (SQL databases, NoSQL stores, KV stores, HTTP APIs, notification services, custom services, etc.)
- Is flexible enough to support custom service adapters

---

## 2. Design Principles

1. **Connection pooling in dedicated service processes**: Connections are managed by long-lived service process instances shared by all responders, not by individual responder processes or applet workers. Applets request a service call via the `service` channel; the responder forwards it to a service process instance via PolyTransport `SocketTransport` (wrapping a Deno socket opened by JSMAWS).
2. **Credentials are stored separately**: Service credentials are managed separately (see [env-secrets-design.md](env-secrets-design.md)), not in applet code.
3. **Pluggable adapters**: Each service type is implemented as an adapter module. Custom adapters can be provided by administrators.
4. **Applet-facing API via IPC**: Applets communicate with the service layer via a PolyTransport channel (`service`), not via direct service connections.
5. **Scoped access**: Routes/pools declare which services they can access. Applets cannot access services not declared for their route.
6. **Named service pools**: Services are assigned to named `servicePools` (workload profiles), not one pool per service. A single pool can serve multiple services; different pools can have different scaling strategies and process counts. This mirrors the responder pool model.
7. **Operator as process manager**: The operator manages service process pools using the same pool infrastructure as responder pools. Service processes report health and capacity via the `control` channel.
8. **Mesgjs-compatible**: The API should be expressible in Mesgjs message-passing style.

---

## 3. Architecture Overview

```
Applet Worker (sandboxed)
  │  PostMessageTransport 'service' channel
  │  Sends: { service: 'db', op: 'query', sql: '...', params: [...] }
  │  Receives: { rows: [...], rowCount: N }
  ▼
Responder Process (unprivileged, long-lived)
  │  Service relay: forwards svc-req to a service process instance,
  │    returns svc-res/svc-err
  │  Enforces access control (which services this route can use)
  │  Asks operator for socket address of an available service process instance
  │  SocketTransport over Deno socket (JSMAWS manages connect step)
  ▼
Operator (socket registry + pool manager)
  │  Maintains registry: service name → servicePool name → available socket addresses
  │  Load-balances responder connections across available instances in a pool
  │  Spawns, monitors, scales, and recycles service process instances
  ▼
Service Pool (named workload profile; one pool can serve multiple services)
  │  Contains 1..N service process instances
  │  Scaling strategy: static / dynamic / ondemand
  │  Each instance loads adapters for all services assigned to this pool
  ▼
Service Process Instance (unprivileged, long-lived)
  │  Service Manager
  │  - Holds connection pool for each service adapter it manages
  │  - Routes svc-req messages to the appropriate adapter
  │  - Reports health/capacity to operator via control channel
  │  - JSMAWS manages listen step; SocketTransport wraps accepted connections
  ▼
Service Adapter (loaded by service process instance)
  │  e.g., PostgreSQL adapter, Redis adapter, HTTP API adapter,
  │        notification adapter, custom service adapter
  ▼
External Service (database, cache, API, etc.)
```

The key insight is that **connection pools live in service process instances**, which are long-lived and shared by all responders. Applet workers are one-shot; responders are recycled after `maxReqs` requests; but service process instances persist independently, maintaining stable connections to external services.

The operator manages service process instances as **named pools** — the same pool infrastructure ([`src/pool-manager.esm.js`](../src/pool-manager.esm.js), [`src/process-manager.esm.js`](../src/process-manager.esm.js)) used for responder pools. Each named service pool (`servicePools`) is a workload profile: it declares scaling strategy, min/max process counts, and recycling policy. Multiple services can be assigned to the same pool (e.g., low-volume services sharing a small pool), or a single high-demand service can have its own dedicated pool.

This means:

- **No single point of failure**: multiple instances per pool; operator respawns crashed instances
- **Load balancing**: operator distributes responder connections across available instances in a pool
- **Graceful scaling**: operator can add/remove instances under load without disrupting in-flight requests
- **Independent recycling**: instances are recycled after `maxReqs` without affecting other instances
- **Workload grouping**: administrators can group low-volume services into a shared pool and give high-volume services their own dedicated pool

`SocketTransport` is socket-type-agnostic — it wraps any Deno socket that exposes `readable`/`writable` streams. JSMAWS is responsible for the `Deno.listen()`/`Deno.connect()` steps (using a Unix domain socket or TCP loopback as appropriate). Each service process instance calls `Deno.listen()` on its own socket and wraps each accepted connection in a `SocketTransport`; each responder calls `Deno.connect()` to the socket address provided by the operator and wraps the resulting connection in a `SocketTransport`.

---

## 4. Service Channel Protocol

A PolyTransport channel (`service`) is added to the applet communication protocol. This channel is exposed via `globalThis.JSMAWS.service` (alongside `.server`).

The service channel uses **message types as sub-channels** to enable true concurrent requests. PolyTransport supports 2^16 (65,536) message types, making message type exhaustion a non-issue for practical workloads.

### Channel Setup

The `service` channel is only opened when the route has services configured. The bootstrap reads the setup data and opens the channel if `setupData.services` is non-empty.

**No PolyTransport message type registration is used.** All communication uses numeric message types directly (via `channel.write(messageType, data)` and `channel.read({ only: messageType })`). This avoids the 256-value limit for registered string types and eliminates registration overhead.

```javascript
// In bootstrap.esm.js (addition):
if (setupData.services?.length > 0) {
    const serviceChannel = await transport.requestChannel('service');
    // No addMessageTypes() call - using numeric types only
    jsmawsNamespace.service = serviceChannel;
}
```

### Message Type Allocation

**Message Type 0**: Control sub-channel (by prior agreement between responder and applet)
- Used for: request initiation, response channel assignment, errors
- Distinguished by `type` field in JSON payload: `'svc-req'`, `'svc-res-assign'`, `'svc-err'`

**Message Types 1-65535**: Response data sub-channels (allocated dynamically by JSMAWS)
- Allocated by responder when forwarding a request to service process
- Returned to applet via `svc-res-assign` message on type 0
- Used for response data only (one message type per in-flight request)
- Deallocated after response completion

### Control Messages (Message Type 0)

#### Request (`type: 'svc-req'`)

```javascript
// Applet → Responder (on message type 0)
await service.write(0, JSON.stringify({
    type: 'svc-req',
    reqId: 'q1',            // Applet-supplied request ID (for applet's own tracking)
    service: 'db',          // Service name (must be in route's services list)
    op: 'query',            // Operation type (service-specific)
    sql: 'SELECT * FROM users WHERE id = $1',
    params: [userId],
    // ... operation-specific fields
}));
```

#### Response Channel Assignment (`type: 'svc-res-assign'`)

```javascript
// Responder → Applet (on message type 0, intra-process)
{
    type: 'svc-res-assign',
    reqId: 'q1',            // Matches applet's request
    responseChannel: 42,    // Numeric message type for response data
}
```

The `svc-res-assign` message is sent intra-process (responder → applet worker via `PostMessageTransport`), so latency is negligible.

#### Error (`type: 'svc-err'`)

```javascript
// Responder → Applet (on message type 0)
{
    type: 'svc-err',
    reqId: 'q1',            // Matches applet's request
    error: 'Connection refused',
    code: 'ECONNREFUSED',   // Optional error code
}
```

### Response Data Messages (Message Types 1-65535)

Response data is sent on the assigned numeric message type. The payload format is service-specific.

```javascript
// Responder → Applet (on assigned message type, e.g., 42)
await service.write(42, JSON.stringify({
    rows: [...],
    rowCount: N,
    fields: [...],
}));
```

For streaming responses (future enhancement), multiple frames can be sent on the same response message type without mixing data from different requests.

### Concurrency Model

Each in-flight request gets its own response sub-channel (message type). The applet can:

1. Send multiple `svc-req` messages on type 0 concurrently
2. Read `svc-res-assign` messages on type 0 to learn which message type each response will arrive on
3. Read response data on the assigned message types independently (via `channel.read({ only: responseChannel })`)

This enables true concurrent service calls without `reqId` matching complexity.

---

## 5. Responder Relay Architecture

The responder sits between the applet's `service` channel and the service process instances. This relay layer has three important responsibilities: **request ID isolation**, **response message type allocation**, and **fan-out to multiple service process connections**.

### 5.1 Request ID Isolation and Message Type Allocation

Applets supply a `reqId` in each `svc-req` message for their own tracking. However, applet-supplied `reqId` values **must not be forwarded directly** to the service process. If they were:

- Two applets running concurrently (e.g., in different workers on the same responder) could use the same `reqId` string, causing response misrouting.
- A malicious applet could craft `reqId` values that collide with another applet's in-flight requests.

**Solution: Responder-assigned relay IDs and response message types**

The responder maintains a per-connection relay table. When forwarding a `svc-req` to a service process, the responder:

1. Generates a unique relay ID (e.g., a monotonically incrementing integer scoped to the responder's connection to that service process).
2. Allocates a response message type (numeric, 1-65535) for this request.
3. Records the mapping: `relayId → { appletReqId, appletChannel, responseMessageType }`.
4. Sends `svc-res-assign` to the applet on message type 0 with the allocated `responseMessageType`.
5. Forwards the request to the service process with `reqId: relayId` (replacing the applet-supplied value).
6. When the service process returns a response with `reqId: relayId`, the responder looks up the `responseMessageType` and `appletChannel`, and writes the response data to the applet on the allocated message type.
7. Deallocates the response message type after the response is complete.

```
Applet Worker A                Responder                  Service Process
  svc-req { type: 'svc-req', reqId: 'q1', ... } (on msg type 0)
  ──────────────────────────►
                               relay table: { 'r-1' → { reqId: 'q1', ch: A, respMsgType: 42 } }
                               svc-res-assign { type: 'svc-res-assign', reqId: 'q1', responseChannel: 42 } (on msg type 0)
  ◄──────────────────────────
                               svc-req { reqId: 'r-1', ... } (forwarded to service process)
                               ──────────────────────────────────────────────►
                                                           svc-res { reqId: 'r-1', ... }
                               ◄──────────────────────────────────────────────
                               lookup 'r-1' → { reqId: 'q1', ch: A, respMsgType: 42 }
                               response data (on msg type 42)
  ◄──────────────────────────
```

This ensures that:
- Applets cannot interfere with each other's requests regardless of `reqId` choice.
- The service process sees only responder-scoped relay IDs, never applet-supplied values.
- Each in-flight request has its own response message type (sub-channel).
- The relay table is cleaned up when a response is received or the applet connection closes.

### 5.2 Fan-Out to Multiple Service Process Connections

A single applet `service` channel may reference multiple services (e.g., `db` and `cache`), which may be assigned to different `servicePools` and thus different service process instances. The responder must maintain **one `SocketTransport` connection per service process instance** it is currently using, and route each `svc-req` to the correct connection based on the `service` field.

```
Applet Worker
  │  service channel (single PostMessageTransport channel)
  │  svc-req { service: 'db', ... }
  │  svc-req { service: 'cache', ... }
  ▼
Responder
  │  Reads svc-req from applet service channel
  │  Inspects service field → looks up which servicePool/instance handles it
  │  Routes to appropriate SocketTransport connection:
  │
  ├── SocketTransport → svc-shared-1.sock  (handles 'db', 'cache')
  │     svc-req { reqId: 'r-1', service: 'db', ... }
  │     svc-req { reqId: 'r-2', service: 'cache', ... }
  │
  └── SocketTransport → svc-analytics-1.sock  (handles 'analyticsDb')
        svc-req { reqId: 'r-3', service: 'analyticsDb', ... }
```

**Key points:**

- The responder maintains a map of `servicePool name → SocketTransport connection` (one connection per pool, not per service, since a pool can serve multiple services).
- Connections to service process instances are established lazily (on first use) or eagerly (at responder startup), depending on configuration.
- If a service process instance becomes unavailable, the responder requests a new socket address from the operator and reconnects.
- Responses from different service process instances are all written back to the single applet `service` channel, with `reqId` rewritten to the original applet-supplied value.

---

## 6. Service Adapter Interface

A service adapter is a JavaScript module that manages connections to a specific service type:

```javascript
// service-adapter interface (conceptual)
export default {
    /**
     * Initialize the adapter (called once when the service process instance starts).
     * @param {object} config - Adapter configuration from jsmaws.slid
     */
    async init (config) { ... },

    /**
     * Execute a service operation.
     * @param {object} request - The svc-req payload (minus reqId and service)
     * @returns {object} - The svc-res payload (minus reqId)
     */
    async execute (request) { ... },

    /**
     * Shut down the adapter (called when the service process instance shuts down).
     */
    async shutdown () { ... },
};
```

---

## 7. Usage Patterns

### Pattern A: Single Request/Response (Simplest)

The applet sends a `svc-req` message, waits for the response channel assignment, then reads the response. This is the simplest model and covers the majority of use cases (queries, lookups, writes, service calls).

**Applet code:**

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;
    const service = globalThis.JSMAWS.service;

    // Read HTTP request
    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;
    let requestData;
    await reqMsg.process(() => { requestData = JSON.parse(reqMsg.text); });

    const { routeParams } = requestData;

    try {
        // Send service request on message type 0 (control sub-channel)
        await service.write(0, JSON.stringify({
            type: 'svc-req',
            reqId: 'q1',
            service: 'db',
            op: 'query',
            sql: 'SELECT * FROM users WHERE id = $1',
            params: [routeParams.userId],
        }));

        // Read response channel assignment on message type 0
        const assignMsg = await service.read({ only: 0, decode: true });
        if (!assignMsg) throw new Error('Service channel closed');

        let assignment;
        await assignMsg.process(() => { assignment = JSON.parse(assignMsg.text); });

        if (assignment.type === 'svc-err') {
            throw new Error(assignment.error);
        }

        const { responseChannel } = assignment;

        // Read response data on assigned message type
        const dataMsg = await service.read({ only: responseChannel, decode: true });
        if (!dataMsg) throw new Error('Service channel closed');

        let result;
        await dataMsg.process(() => { result = JSON.parse(dataMsg.text); });

        // Send HTTP response
        await server.write('res', JSON.stringify({
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        await server.write('res-frame', JSON.stringify(result.rows[0] ?? null));
        await server.write('res-frame', null);

    } catch (error) {
        await server.write('res-error', JSON.stringify({ error: error.message }));
    }
}
```

**Advantages:**
- Simple, familiar request/response pattern
- Easy to reason about
- Works well for most CRUD operations and service calls

**Disadvantages:**
- One request at a time per applet (no concurrent service calls)
- No streaming results (must buffer entire result set)

---

### Pattern B: Concurrent Requests with Independent Response Channels

The applet can send multiple `svc-req` messages concurrently and read responses independently on their assigned message types. This enables true parallel service calls.

**Applet code:**

```javascript
// Send two queries concurrently on message type 0
await service.write(0, JSON.stringify({
    type: 'svc-req',
    reqId: 'user',
    service: 'db',
    op: 'query',
    sql: 'SELECT * FROM users WHERE id = $1',
    params: [userId],
}));

await service.write(0, JSON.stringify({
    type: 'svc-req',
    reqId: 'prefs',
    service: 'db',
    op: 'query',
    sql: 'SELECT * FROM preferences WHERE user_id = $1',
    params: [userId],
}));

// Read response channel assignments on message type 0
const channels = {};
for (let i = 0; i < 2; i++) {
    const assignMsg = await service.read({ only: 0, decode: true });
    if (!assignMsg) break;
    await assignMsg.process(() => {
        const assignment = JSON.parse(assignMsg.text);
        if (assignment.type === 'svc-res-assign') {
            channels[assignment.reqId] = assignment.responseChannel;
        }
    });
}

// Read responses independently on their assigned message types
const userMsg = await service.read({ only: channels.user, decode: true });
const prefsMsg = await service.read({ only: channels.prefs, decode: true });

let user, prefs;
await userMsg.process(() => { user = JSON.parse(userMsg.text); });
await prefsMsg.process(() => { prefs = JSON.parse(prefsMsg.text); });

const userData = user.rows[0];
const prefsData = prefs.rows[0];
```

**Advantages:**
- True concurrent service calls (reduces latency for multi-service requests)
- No `reqId` matching complexity in response data
- Each request has its own response sub-channel
- Responses can be read in any order

**Disadvantages:**
- More complex applet code
- Requires tracking response channel assignments

---

### Option C: Streaming Results

For large result sets, the service process streams rows back to the applet as they arrive from the service. This avoids buffering the entire result set in memory.

**Protocol extension:**

```javascript
// Service Process → Responder → Applet: streaming response
{ reqId: 'svc-1', type: 'svc-res-start', columns: ['id', 'name', 'email'] }
{ reqId: 'svc-1', type: 'svc-res-row',   row: [1, 'Alice', 'alice@example.com'] }
{ reqId: 'svc-1', type: 'svc-res-row',   row: [2, 'Bob',   'bob@example.com'] }
{ reqId: 'svc-1', type: 'svc-res-end',   rowCount: 2 }
```

**Advantages:**
- Memory-efficient for large result sets
- Enables progressive rendering

**Disadvantages:**
- More complex protocol
- More complex applet code
- Requires careful flow control (PolyTransport handles this)

**Verdict:** Streaming is a useful extension but not required for the initial implementation. Propose as a future enhancement.

---

### Option D: Service via Named Service Pools (Approved Architecture)

Service process instances are managed by the operator in named pools (`servicePools`). Each pool is a workload profile that can serve one or more services. The operator maintains a socket registry mapping service names to available pool instances, and load-balances responder connections across instances.

**Architecture:**

```
Operator
  │  manages servicePools
  │  maintains socket registry: service name → pool → available socket addresses
  │
  ├── servicePool "shared" (minProcesses=1, maxProcesses=2, strategy=dynamic)
  │     Each instance loads: db adapter, cache adapter
  │     ├── Instance 1 (socket: /run/jsmaws/svc-shared-1.sock)
  │     └── Instance 2 (socket: /run/jsmaws/svc-shared-2.sock)
  │
  └── servicePool "analytics" (minProcesses=2, maxProcesses=8, strategy=static)
        Each instance loads: analytics-db adapter
        ├── Instance 1 (socket: /run/jsmaws/svc-analytics-1.sock)
        ├── Instance 2 (socket: /run/jsmaws/svc-analytics-2.sock)
        └── ...

Responder A ──SocketTransport──► svc-shared-1.sock
Responder B ──SocketTransport──► svc-shared-2.sock
Responder C ──SocketTransport──► svc-analytics-1.sock
```

When a responder needs to make a service call, it requests a socket address from the operator for the named service. The operator looks up which pool serves that service, selects an available instance (load balancing), and returns the socket address. The responder then connects directly to that instance for the duration of the request (or maintains a persistent connection for efficiency).

**Advantages:**
- Connection count capped at `maxConnections × poolSize` regardless of how many responders are running
- Service process instances survive responder restarts (connections not lost on responder recycling)
- Operator is not in the service data path (no bottleneck, no privileged process handling data)
- Single IPC hop: Responder → Service Process Instance
- Architecturally consistent with how production services (PostgreSQL, Redis) themselves work
- Credentials held in service process instances only (not in each responder)
- Service process instances can be updated/restarted independently of responders
- Workload grouping: low-volume services share a pool; high-volume services get dedicated pools
- Consistent with responder pool model (pools are workload profiles, not per-route containers)

**Disadvantages:**
- Requires `SocketTransport` support in PolyTransport
- Socket file lifecycle management (cleanup on crash, permissions)
- Transaction scope crosses process boundary — service process must detect responder death to roll back open transactions
- Higher implementation complexity than per-responder model

**Verdict:** This is the approved architecture.

---

## 8. Built-in Service Adapters

### 8.1 `@postgres` — PostgreSQL

```slid
services=[
  db=[
    adapter=@postgres
    pool=shared
    host=:env:DB_HOST
    port=5432
    database=:env:DB_NAME
    user=:env:DB_USER
    password=:env:DB_PASSWORD
    maxConnections=10
    idleTimeout=30
  ]
]
```

**Operations:**

```javascript
// Query (returns rows)
{ op: 'query', sql: 'SELECT ...', params: [...] }
// → { rows: [...], rowCount: N, fields: [...] }

// Execute (no rows returned)
{ op: 'execute', sql: 'INSERT ...', params: [...] }
// → { rowCount: N }

// Transaction
{ op: 'begin' }
// → { txId: 'tx-1' }
{ op: 'query', txId: 'tx-1', sql: '...', params: [...] }
// → { rows: [...] }
{ op: 'commit', txId: 'tx-1' }
// → { ok: true }
{ op: 'rollback', txId: 'tx-1' }
// → { ok: true }
```

### 8.2 `@mysql` — MySQL / MariaDB

Same interface as `@postgres` (SQL-compatible operations).

### 8.3 `@sqlite` — SQLite

```slid
services=[
  localDb=[
    adapter=@sqlite
    pool=shared
    path=/var/lib/myapp/data.db
    readOnly=false
  ]
]
```

Same SQL operations as `@postgres`.

### 8.4 `@redis` — Redis / Valkey

```slid
services=[
  cache=[
    adapter=@redis
    pool=shared
    host=:env:REDIS_HOST
    port=6379
    password=:env:REDIS_PASSWORD
    db=0
    maxConnections=5
  ]
]
```

**Operations:**

```javascript
// Get
{ op: 'get', key: 'user:123' }
// → { value: '...' }  (null if not found)

// Set
{ op: 'set', key: 'user:123', value: '...', ttl: 3600 }
// → { ok: true }

// Delete
{ op: 'del', key: 'user:123' }
// → { deleted: 1 }

// Increment
{ op: 'incr', key: 'counter:hits' }
// → { value: 42 }

// Hash operations
{ op: 'hget', key: 'user:123', field: 'email' }
{ op: 'hset', key: 'user:123', field: 'email', value: 'user@example.com' }
{ op: 'hgetall', key: 'user:123' }
// → { value: { email: '...', name: '...' } }

// List operations
{ op: 'lpush', key: 'queue', value: '...' }
{ op: 'rpop', key: 'queue' }
// → { value: '...' }

// Pub/Sub (future enhancement — requires streaming)
```

### 8.5 `@mongodb` — MongoDB

```slid
services=[
  docs=[
    adapter=@mongodb
    pool=shared
    uri=:env:MONGO_URI
    database=myapp
    maxConnections=10
  ]
]
```

**Operations:**

```javascript
// Find
{ op: 'find', collection: 'users', filter: { active: true }, limit: 10, skip: 0 }
// → { documents: [...], count: N }

// FindOne
{ op: 'findOne', collection: 'users', filter: { _id: '...' } }
// → { document: { ... } }  (null if not found)

// InsertOne
{ op: 'insertOne', collection: 'users', document: { name: '...', email: '...' } }
// → { insertedId: '...' }

// UpdateOne
{ op: 'updateOne', collection: 'users', filter: { _id: '...' }, update: { $set: { name: '...' } } }
// → { matchedCount: 1, modifiedCount: 1 }

// DeleteOne
{ op: 'deleteOne', collection: 'users', filter: { _id: '...' } }
// → { deletedCount: 1 }

// Aggregate
{ op: 'aggregate', collection: 'orders', pipeline: [...] }
// → { documents: [...] }
```

### 8.6 `@http` — HTTP API Client

```slid
services=[
  paymentApi=[
    adapter=@http
    pool=shared
    baseUrl=https://api.payment-provider.com/v1
    headers=[Authorization=:env:PAYMENT_API_KEY]
    timeout=10
    retries=3
  ]
]
```

**Operations:**

```javascript
// GET
{ op: 'get', path: '/charges/ch_123', query: { expand: 'customer' } }
// → { status: 200, headers: { ... }, body: { ... } }

// POST
{ op: 'post', path: '/charges', body: { amount: 1000, currency: 'usd' } }
// → { status: 201, headers: { ... }, body: { ... } }

// PUT, PATCH, DELETE (same pattern)
```

### 8.7 `@kv` — Key-Value Store (Deno KV)

```slid
services=[
  store=[
    adapter=@kv
    pool=shared
    path=/var/lib/myapp/kv.db
    /* or: remote=https://api.deno.com/databases/... */
  ]
]
```

**Operations:**

```javascript
// Get
{ op: 'get', key: ['users', '123'] }
// → { value: { ... }, versionstamp: '...' }

// Set
{ op: 'set', key: ['users', '123'], value: { name: '...' } }
// → { ok: true, versionstamp: '...' }

// Delete
{ op: 'delete', key: ['users', '123'] }
// → { ok: true }

// List
{ op: 'list', prefix: ['users'], limit: 100 }
// → { entries: [{ key: [...], value: { ... } }, ...] }

// Atomic (compare-and-swap)
{ op: 'atomic', checks: [...], mutations: [...] }
// → { ok: true }
```

---

## 9. Configuration Schema

```slid
[(
  /* Named service pool definitions (workload profiles) */
  servicePools=[
    shared=[
      /* Low-volume services share this pool */
      minProcesses=1
      maxProcesses=2
      strategy=dynamic
      maxReqs=5000          /* recycle instance after N requests */
      idleTimeout=300       /* seconds before idle instance is stopped (ondemand) */
    ]
    analytics=[
      /* High-volume analytics DB gets its own dedicated pool */
      minProcesses=2
      maxProcesses=8
      strategy=static
      maxReqs=10000
    ]
  ]

  /* Global service definitions */
  services=[
    db=[
      adapter=@postgres
      pool=shared           /* which servicePool manages this service */
      host=:env:DB_HOST
      port=5432
      database=:env:DB_NAME
      user=:env:DB_USER
      password=:env:DB_PASSWORD
      maxConnections=10
      idleTimeout=30
    ]
    cache=[
      adapter=@redis
      pool=shared
      host=:env:REDIS_HOST
      port=6379
      maxConnections=5
    ]
    paymentApi=[
      adapter=@http
      pool=shared
      baseUrl=https://api.stripe.com/v1
      headers=[Authorization=:env:STRIPE_SECRET_KEY]
      timeout=10
    ]
    analyticsDb=[
      adapter=@postgres
      pool=analytics        /* dedicated high-volume pool */
      host=:env:ANALYTICS_DB_HOST
      database=analytics
      user=:env:ANALYTICS_DB_USER
      password=:env:ANALYTICS_DB_PASSWORD
      maxConnections=20
    ]
  ]

  routes=[
    [
      path=/api/users/:*
      pool=standard
      /* Declare which services this route can access */
      services=[db cache]
    ]
    [
      path=/api/payments/:*
      pool=standard
      services=[db paymentApi]
    ]
    [
      path=/api/analytics/:*
      pool=standard
      services=[analyticsDb]
    ]
    [
      path=/public/:*
      pool=standard
      /* No services — JSMAWS.service is not available */
    ]
  ]
)]
```

**Note on connection count:** With a pool of `N` service process instances each holding `maxConnections` connections to an external service, the total connection count is `N × maxConnections`. Administrators should size pools and `maxConnections` accordingly.

---

## 10. Access Control

Service access is scoped to routes. An applet can only access services declared in its route's `services` list.

- If a route has no `services`, `globalThis.JSMAWS.service` is `undefined`.
- If an applet tries to access a service not in its route's list, the responder returns a `svc-err` with code `ACCESS_DENIED`.
- Service names are validated against the global `services` configuration.

This prevents applets from accessing services they shouldn't (e.g., a public-facing applet accessing the payment API).

---

## 11. Transaction Support

Transactions are supported for SQL adapters. A transaction is a sequence of operations that are executed atomically.

**Protocol:**

```javascript
// Begin transaction
await service.write('svc-req', JSON.stringify({ reqId: 'tx-begin', service: 'db', op: 'begin' }));
const beginRes = await readSvcResponse(service, 'tx-begin');
const { txId } = beginRes;

// Execute operations within transaction
await service.write('svc-req', JSON.stringify({
    reqId: 'tx-q1', service: 'db', op: 'query',
    txId,
    sql: 'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
    params: [100, fromAccountId],
}));
await readSvcResponse(service, 'tx-q1');

await service.write('svc-req', JSON.stringify({
    reqId: 'tx-q2', service: 'db', op: 'query',
    txId,
    sql: 'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
    params: [100, toAccountId],
}));
await readSvcResponse(service, 'tx-q2');

// Commit
await service.write('svc-req', JSON.stringify({ reqId: 'tx-commit', service: 'db', op: 'commit', txId }));
await readSvcResponse(service, 'tx-commit');
```

**Transaction lifecycle:**
- Transactions are tied to the responder's connection to the service process instance (not to the applet worker directly)
- If the responder connection closes without committing, the service process instance automatically rolls back open transactions
- Transaction IDs are scoped to the responder's connection (not shared across connections)

---

## 12. Connection Pool Management

Connection pools are managed by **service process instances**. The operator manages the pool of service process instances themselves.

### Per-instance connection pool

Each service process instance manages its own connection pool for each service adapter it hosts:

- Each service has its own connection pool within the instance
- Pool size is configured per service (`maxConnections`)
- Connections are borrowed for the duration of a service operation (or transaction)
- Idle connections are returned to the pool after `idleTimeout` seconds
- If the pool is exhausted, service requests wait (with a configurable timeout)

**Pool configuration:**

```slid
db=[
  adapter=@postgres
  pool=shared
  /* ... connection params ... */
  maxConnections=10      /* Maximum connection pool size per instance */
  minConnections=2       /* Minimum pool size (pre-warmed) */
  idleTimeout=30         /* Seconds before idle connection is closed */
  acquireTimeout=5       /* Seconds to wait for a connection before error */
]
```

### Service process instance pool (operator-managed)

The operator manages the pool of service process instances for each `servicePool`:

- Scaling strategies: `static` (fixed count), `dynamic` (scale between min/max), `ondemand` (spawn as needed)
- Instances report capacity via `capacity-update` on the `control` channel (see Section 15)
- Operator load-balances responder connections across available instances
- Instances are recycled after `maxReqs` to mitigate memory leaks
- Crashed instances are automatically respawned

---

## 13. Custom Adapters

Administrators can provide custom service adapters:

```slid
services=[
  myCustomService=[
    adapter=./adapters/my-custom-adapter.esm.js
    pool=shared
    /* ... custom config ... */
  ]
]
```

Custom adapters must implement the adapter interface (see Section 5). They are loaded by the service process instance and run with service process permissions.

---

## 14. Implementation Plan

### Phase 1: Core Infrastructure

1. **Service process** in `src/service-api-process.esm.js`
   - Extends `ServiceProcess` base class (like `ResponderProcess`, `RouterProcess`)
   - JSMAWS calls `Deno.listen()` (Unix domain socket or TCP loopback) and passes accepted connections to `SocketTransport`
   - Loads and initializes service adapters on startup (all adapters for its assigned pool)
   - Manages connection pools for each configured service
   - Routes `svc-req` messages to the appropriate adapter
   - Returns `svc-res` or `svc-err` responses
   - Reports health/capacity to operator via `control` channel `capacity-update` messages

2. **Service manager** in `src/service-manager.esm.js`
   - Loaded by the service process instance
   - Manages service adapter lifecycle (`init`, `execute`, `shutdown`)
   - Manages connection pools per service
   - Enforces access control (validates service name against allowed list)

3. **Service relay** in `src/responder-process.esm.js`
   - Open `service` channel when route has services (no message type registration - using numeric types only)
   - Request socket address from operator for each service pool used by this route
   - JSMAWS calls `Deno.connect()` to reach service process instance; wraps connection in `SocketTransport`
   - Maintain one `SocketTransport` connection per service pool (not per service name)
   - Maintain relay table: responder-assigned relay ID → `{ appletReqId, appletChannel, responseMessageType }` (see Section 5.1)
   - Maintain message type allocator (1-65535) for response sub-channels
   - On `svc-req` from applet (message type 0): assign relay ID, allocate response message type, record in relay table, send `svc-res-assign` to applet (message type 0), rewrite `reqId`, forward to correct `SocketTransport` based on `service` field
   - On response from service process: look up relay ID, write response data to applet on allocated message type, deallocate message type
   - On error: send `svc-err` to applet on message type 0 (control sub-channel)
   - Clean up relay table entries and deallocate message types on response receipt or applet connection close

4. **Bootstrap update** in `src/applets/bootstrap.esm.js`
   - Open `service` channel when `setupData.services` is non-empty
   - Expose as `globalThis.JSMAWS.service`

5. **Configuration update** in `src/configuration.esm.js`
   - Add `services` getter
   - Add `servicePools` getter
   - Add route-level `services` access control
   - Add socket address configuration for service process instances (Unix domain socket path or TCP port)

6. **Operator integration** in `src/operator-process.esm.js`
   - Spawn and manage service process instance pools using existing pool infrastructure
   - Maintain socket registry: service name → servicePool → available socket addresses
   - Handle responder requests for service socket addresses (load balancing)
   - Pass socket addresses to responders via setup data or on-demand via control channel

### Phase 2: Built-in Adapters

Implement built-in adapters in `src/services/`:
- `src/services/postgres.esm.js` — `@postgres`
- `src/services/mysql.esm.js` — `@mysql`
- `src/services/sqlite.esm.js` — `@sqlite`
- `src/services/redis.esm.js` — `@redis`
- `src/services/mongodb.esm.js` — `@mongodb`
- `src/services/http.esm.js` — `@http`
- `src/services/kv.esm.js` — `@kv`

### Phase 3: Transaction Support

- Add transaction management to SQL adapters
- Add transaction lifecycle tracking in service manager
- Auto-rollback on responder connection close

### Phase 4: Tests and Documentation

- Unit tests for each adapter
- Integration tests for service manager
- E2E tests for service-enabled routes
- Applet development guide: using `JSMAWS.service` in applets

---

## 15. Security Considerations

- **Credentials in environment variables**: Service credentials should never appear in config files. Use `:env:VAR_NAME` syntax.
- **Route-scoped access**: Applets can only access services declared for their route. This prevents privilege escalation.
- **SQL injection prevention**: SQL adapters should use parameterized queries. The adapter interface requires `params` to be separate from `sql`.
- **Connection pool isolation**: Connection pools live in service process instances, not in responders. Responders relay service calls but do not hold service connections directly.
- **Adapter trust**: Custom adapters run with service process permissions. Administrators should audit adapter code.
- **Error message sanitization**: Service errors returned to applets should not include internal connection details (e.g., database host, credentials).
- **Socket permissions**: Unix domain sockets for service process instances should be accessible only to the JSMAWS process user.

---

## 16. Service Process Pool Management

Service process instances are managed by the operator using the same pool infrastructure as responder pools. This section describes the lifecycle, health reporting, and socket registry.

### 16.1 Lifecycle

Service process instances follow the same lifecycle as responder processes:

1. **Spawn**: Operator spawns instance with `Deno.Command`, passing pool/service config via `config-update` on the `control` channel
2. **Listen**: Instance calls `Deno.listen()` on its assigned socket path and reports ready via `capacity-update`
3. **Serve**: Instance accepts responder connections via `SocketTransport`, processes `svc-req` messages
4. **Scale**: Operator adds/removes instances based on pool strategy and capacity reports
5. **Recycle**: After `maxReqs`, instance drains in-flight requests and exits; operator spawns replacement
6. **Crash recovery**: Operator detects exit, respawns instance, updates socket registry

### 16.2 Health and Capacity Reporting

Service process instances report health and capacity to the operator via the `control` channel, using the existing `capacity-update` message type (defined in [`src/service-process.esm.js`](../src/service-process.esm.js)):

```javascript
// Instance → Operator (via control channel)
// capacity-update: JSON text
{
    availableWorkers: N,   // Number of concurrent requests this instance can accept
    totalWorkers: M,       // Total capacity (maxConnections across all services)
}
```

The operator uses capacity reports to:
- Determine which instances are available for new responder connections
- Trigger scale-up when all instances are at capacity
- Trigger scale-down when instances are consistently underutilized
- Detect stalled instances (no capacity-update within health-check interval)

The operator sends `health-check` messages periodically; instances respond with `health-response`.

### 16.3 Socket Registry

The operator maintains a socket registry mapping service names to available instance socket addresses:

```
service name → servicePool name → [socket addresses of available instances]
```

When a responder needs to make a service call, it requests a socket address from the operator (via the `control` channel or at spawn time via setup data). The operator selects an available instance using load balancing (e.g., least-connections or round-robin) and returns the socket address.

**Open question:** Should socket addresses be handed out once at responder spawn time (static assignment, simpler but less flexible) or on-demand per service call (dynamic load balancing, more flexible but requires operator round-trip per call)? A hybrid approach — persistent connection per service per responder, with the operator brokering the initial connection — may be optimal.

### 16.4 Graceful Shutdown and Drain

When the operator needs to stop or recycle a service process instance:

1. Operator sends `scale-down` to the instance (stop accepting new connections)
2. Instance stops accepting new `SocketTransport` connections
3. Instance completes in-flight requests
4. Operator sends `shutdown` when drain is complete (or after timeout)
5. Instance rolls back any open transactions, closes connections, exits

---

## 17. Open Questions

1. **Should service adapters be allowed to run in a separate process?** (Option D)
   - **Resolved** Yes, service adapters run in separate service process instances managed by the operator in named pools.
10. **Relay ID strategy**: Should the responder use monotonically incrementing integers (scoped per `SocketTransport` connection) or UUIDs for relay IDs? Monotonic integers are simpler and more compact; UUIDs are globally unique but larger. Since relay IDs are scoped to a single responder↔service-process connection and are short-lived, monotonic integers are likely sufficient.
2. **Should there be a query builder API?** (e.g., `{ op: 'select', table: 'users', where: { id: 1 } }`)
   - **Resolved** No. SQL prepared-statement with variable-binding **must** be supported for security reasons, but a query builder would be an applet implementation concern, not a service protocol feature.
3. **How should large result sets be handled?**
   - **Resolved** Services return results as soon as they are available. Large results generate backpressure via PolyTransport. Applets need to plan for result pagination (e.g. SQL `limit`).
4. **Should there be a schema validation layer?** (e.g., validate query results against a schema)
   - **Resolved** This is an applet (or service-specific) concern, not a service API concern.
5. **How should connection pool exhaustion be handled?**
   - **Resolved** Return `svc-err` with code `POOL_EXHAUSTED` after `acquireTimeout`. Applet can retry or return a 503.
6. **Should services be hot-reloadable?** (e.g., update credentials without restarting) — Complex; propose as a future enhancement.
7. **Centralized service process via SocketTransport**
   - **Resolved**: Service adapters run in dedicated shared service process instances (Option D). JSMAWS manages the socket listen/connect steps (Unix domain socket or TCP loopback); `SocketTransport` wraps the resulting Deno socket connections. This caps connection count at `maxConnections × poolSize` regardless of responder count, and service connections survive responder recycling. The applet-facing `JSMAWS.service` API is identical regardless of pool size.
8. **Per-service pools vs. named service pools**
   - **Resolved**: Named `servicePools` (workload profiles). Multiple services can be assigned to the same pool; different pools can have different scaling strategies and process counts. This mirrors the responder pool model and avoids wasteful per-service singleton processes.
9. **Socket address assignment: static vs. dynamic**
   - **Open**: Should socket addresses be handed out once at responder spawn time, or on-demand per service call? See Section 15.3.

---

[supplemental keywords: service API, service channel, svc-req, svc-res, svc-err, JSMAWS.service, servicePools, service process pool, database, SQL, NoSQL, PostgreSQL, MySQL, SQLite, Redis, MongoDB, HTTP API, key-value store, Deno KV, connection pool, service adapter, pluggable, modular, responder, transaction, query, CRUD, service, credentials, environment variables, access control, route-scoped, data access, data source, services, RPC, remote procedure call, pool management, health reporting, capacity update, socket registry, load balancing, workload profile]
