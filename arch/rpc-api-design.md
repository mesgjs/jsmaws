# JSMAWS RPC API Design

**Status:** [DRAFT]  
**Date:** 2026-04-27  
**Updated:** 2026-05-02

---

## 1. Problem Statement

JSMAWS applets currently have no server-provided mechanism for calling server-side services. An applet that needs to query a database, read from a cache, call an external API, or invoke any other server-side capability must:

1. Establish its own connection (using `Deno.connect`, `fetch`, etc.)
2. Manage credentials directly (hardcoded or via environment variables it can't access \[note: this is covered under another proposal\])
3. Handle connection pooling itself (one-shot workers make this impossible)
4. Implement its own error handling and retry logic

This is impractical for most real-world applications. The goal is a **modular, pluggable** RPC API that:

- Provides applets with access to configured server-side services
- Manages connection pooling at the responder-process level (not per-worker)
- ~Keeps credentials out of applet code~~
  - \[This is confusing. **Hard-wired** credentials should be kept out of applets, but applets still need to be able to pass credentials to services. This falls under the scope of the separate env-secrets-design proposal.\]
- Supports multiple service types (SQL databases, NoSQL stores, KV stores, HTTP APIs, notification services, custom services, etc.)
- Is flexible enough to support custom service adapters

---

## 2. Design Principles

1. **Connection pooling in a dedicated service process**: Connections are managed by long-lived service processes shared by all responders, not by individual responder processes or applet workers. Applets request a service call via the `rpc` channel; the responder forwards it to a service process via PolyTransport `SocketTransport` (wrapping a Deno socket opened by JSMAWS).
2. **Credentials are stored separately**: Service credentials are managed separately (see [env-secrets-design.md](env-secrets-design.md)), not in applet code.
3. **Pluggable adapters**: Each service type is implemented as an adapter module. Custom adapters can be provided by administrators.
4. **Applet-facing API via IPC**: Applets communicate with the RPC layer via a PolyTransport channel (`rpc`), not via direct service connections.
5. **Scoped access**: Routes/pools declare which services they can access. Applets cannot access services not declared for their route.
6. **Mesgjs-compatible**: The API should be expressible in Mesgjs message-passing style.

---

## 3. Architecture Overview

```
Applet Worker (sandboxed)
  │  PostMessageTransport 'rpc' channel
  │  Sends: { service: 'db', op: 'query', sql: '...', params: [...] }
  │  Receives: { rows: [...], rowCount: N }
  ▼
Responder Process (unprivileged, long-lived)
  │  RPC relay: forwards rpc-req to service process, returns rpc-res/rpc-error
  │  Enforces access control (which services this route can use)
  │  SocketTransport over Deno socket (JSMAWS manages connect step)
  ▼
Service Process (unprivileged, long-lived, shared by all responders)
  │  RPC Manager
  │  - Holds connection pools for each configured service
  │  - Routes RPC requests to the appropriate adapter
  │  - JSMAWS manages listen step; SocketTransport wraps accepted connections
  ▼
Service Adapter (loaded by service process)
  │  e.g., PostgreSQL adapter, Redis adapter, HTTP API adapter,
  │        notification adapter, custom service adapter
  ▼
External Service (database, cache, API, etc.)
```

The key insight is that **connection pools live in the service process**, which is long-lived and shared by all responders. Applet workers are one-shot; responders are recycled after `maxReqs` requests; but the service process persists independently, maintaining stable connections to external services.

`SocketTransport` is socket-type-agnostic — it wraps any Deno socket that exposes `readable`/`writable` streams. JSMAWS is responsible for the `Deno.listen()`/`Deno.connect()` steps (using a Unix domain socket or TCP loopback as appropriate). The service process calls `Deno.listen()` and wraps each accepted connection in a `SocketTransport`; each responder calls `Deno.connect()` and wraps the resulting connection in a `SocketTransport`.

---

## 4. RPC Channel Protocol

A PolyTransport channel (`rpc`) is added to the applet communication protocol. This channel is exposed via `globalThis.JSMAWS.rpc` (alongside `.server`).

### Channel Setup

The `rpc` channel is only opened when the route has services configured. The bootstrap reads the setup data and opens the channel if `setupData.services` is non-empty.

```javascript
// In bootstrap.esm.js (addition):
if (setupData.services?.length > 0) {
    const rpcChannel = await transport.requestChannel('rpc');
    await rpcChannel.addMessageTypes(['rpc-req', 'rpc-res', 'rpc-error']);
    jsmawsNamespace.rpc = rpcChannel;
}
```

### Request Message (`rpc-req`)

```javascript
// Applet → Responder
{
    reqId: 'rpc-1',         // Unique request ID (for matching responses)
    service: 'db',          // Service name (must be in route's services list)
    op: 'query',            // Operation type (service-specific)
    // ... operation-specific fields
}
```

### Response Message (`rpc-res`)

```javascript
// Responder → Applet
{
    reqId: 'rpc-1',         // Matches the request
    // ... operation-specific result fields
}
```

### Error Message (`rpc-error`)

```javascript
// Responder → Applet
{
    reqId: 'rpc-1',         // Matches the request
    error: 'Connection refused',
    code: 'ECONNREFUSED',   // Optional error code
}
```

---

## 5. Service Adapter Interface

A service adapter is a JavaScript module that manages connections to a specific service type:

```javascript
// service-adapter interface (conceptual)
export default {
    /**
     * Initialize the adapter (called once when the responder starts).
     * @param {object} config - Adapter configuration from jsmaws.slid
     */
    async init (config) { ... },

    /**
     * Execute an RPC operation.
     * @param {object} request - The rpc-req payload (minus reqId and service)
     * @returns {object} - The rpc-res payload (minus reqId)
     */
    async execute (request) { ... },

    /**
     * Shut down the adapter (called when the responder shuts down).
     */
    async shutdown () { ... },
};
```

---

## 6. Option Proposals

### Option A: Synchronous Request/Response (Recommended for Most Use Cases)

The applet sends an `rpc-req` message and awaits an `rpc-res` or `rpc-error` response. This is the simplest model and covers the majority of use cases (queries, lookups, writes, service calls).

**Applet code:**

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;
    const rpc = globalThis.JSMAWS.rpc;

    // Read request
    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;
    let requestData;
    await reqMsg.process(() => { requestData = JSON.parse(reqMsg.text); });

    const { routeParams } = requestData;

    try {
        // Query the database via RPC
        await rpc.write('rpc-req', JSON.stringify({
            reqId: 'rpc-1',
            service: 'db',
            op: 'query',
            sql: 'SELECT * FROM users WHERE id = $1',
            params: [routeParams.userId],
        }));

        const resMsg = await rpc.read({ only: ['rpc-res', 'rpc-error'], decode: true });
        if (!resMsg) throw new Error('RPC channel closed');

        let result;
        await resMsg.process(() => { result = JSON.parse(resMsg.text); });

        if (resMsg.messageType === 'rpc-error') {
            throw new Error(result.error);
        }

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
- One request at a time per applet (no concurrent RPC calls)
- No streaming results (must buffer entire result set)

---

### Option B: Concurrent Requests with reqId Matching

The applet can send multiple `rpc-req` messages concurrently and match responses by `reqId`. This enables parallel service calls.

**Applet code:**

```javascript
// Send two queries concurrently
await rpc.write('rpc-req', JSON.stringify({
    reqId: 'rpc-user',
    service: 'db',
    op: 'query',
    sql: 'SELECT * FROM users WHERE id = $1',
    params: [userId],
}));

await rpc.write('rpc-req', JSON.stringify({
    reqId: 'rpc-prefs',
    service: 'db',
    op: 'query',
    sql: 'SELECT * FROM preferences WHERE user_id = $1',
    params: [userId],
}));

// Collect both responses (order may vary)
const responses = {};
for (let i = 0; i < 2; i++) {
    const resMsg = await rpc.read({ only: ['rpc-res', 'rpc-error'], decode: true });
    if (!resMsg) break;
    await resMsg.process(() => {
        const result = JSON.parse(resMsg.text);
        responses[result.reqId] = result;
    });
}

const user = responses['rpc-user']?.rows[0];
const prefs = responses['rpc-prefs']?.rows[0];
```

**Advantages:**
- Enables parallel service calls (reduces latency for multi-service requests)
- Natural extension of Option A

**Disadvantages:**
- More complex applet code
- Requires reqId management

---

### Option C: Streaming Results

For large result sets, the responder streams rows back to the applet as they arrive from the service. This avoids buffering the entire result set in memory.

**Protocol extension:**

```javascript
// Responder → Applet: streaming response
{ reqId: 'rpc-1', type: 'rpc-res-start', columns: ['id', 'name', 'email'] }
{ reqId: 'rpc-1', type: 'rpc-res-row',   row: [1, 'Alice', 'alice@example.com'] }
{ reqId: 'rpc-1', type: 'rpc-res-row',   row: [2, 'Bob',   'bob@example.com'] }
{ reqId: 'rpc-1', type: 'rpc-res-end',   rowCount: 2 }
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

### Option D: RPC via a Dedicated Service Process (Centralized)

A separate "RPC service" process manages all service connections. All responder processes connect to it directly via PolyTransport's `SocketTransport` over a Unix domain socket. The operator spawns and manages the service process lifecycle (as it does for responders), but is **not** in the data path for RPC calls.

**Architecture:**

```
Operator spawns and configures Service Process
  │
  ├── Responder A ──SocketTransport──┐
  ├── Responder B ──SocketTransport──┼──► Service Process ──► External DB/API
  └── Responder C ──SocketTransport──┘
```

The service process listens on a Unix domain socket (e.g., `/run/jsmaws/rpc-<name>.sock`). The socket path is passed to responders via configuration at spawn time. Each responder establishes its own `SocketTransport` connection to the service process and uses the same `rpc-req`/`rpc-res`/`rpc-error` message protocol as the per-responder model — the applet-facing API is unchanged.

**Advantages:**
- Connection count capped at `maxConnections` regardless of how many responders are running
- Service process survives responder restarts (connections not lost on responder recycling)
- Operator is not in the RPC data path (no bottleneck, no privileged process handling data)
- Single IPC hop: Responder → Service Process (same latency as per-responder model minus connection setup)
- Architecturally consistent with how production services (PostgreSQL, Redis) themselves work
- Credentials held in one place (service process only, not in each responder)
- Service process can be updated/restarted independently of responders

**Disadvantages:**
- Requires `SocketTransport` support in PolyTransport
- Socket file lifecycle management (cleanup on crash, permissions)
- Transaction scope crosses process boundary — service process must detect responder death to roll back open transactions
- Higher implementation complexity than per-responder model

**Verdict:** This is the approved architecture.

---

## 7. Built-in Service Adapters

### 7.1 `@postgres` — PostgreSQL

```slid
services=[
  db=[
    adapter=@postgres
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

### 7.2 `@mysql` — MySQL / MariaDB

Same interface as `@postgres` (SQL-compatible operations).

### 7.3 `@sqlite` — SQLite

```slid
services=[
  localDb=[
    adapter=@sqlite
    path=/var/lib/myapp/data.db
    readOnly=false
  ]
]
```

Same SQL operations as `@postgres`.

### 7.4 `@redis` — Redis / Valkey

```slid
services=[
  cache=[
    adapter=@redis
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

### 7.5 `@mongodb` — MongoDB

```slid
services=[
  docs=[
    adapter=@mongodb
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

### 7.6 `@http` — HTTP API Client

```slid
services=[
  paymentApi=[
    adapter=@http
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

### 7.7 `@kv` — Key-Value Store (Deno KV)

```slid
services=[
  store=[
    adapter=@kv
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

## 8. Configuration Schema

```slid
[(
  /* Global service definitions */
  services=[
    db=[
      adapter=@postgres
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
      host=:env:REDIS_HOST
      port=6379
      maxConnections=5
    ]
    paymentApi=[
      adapter=@http
      baseUrl=https://api.stripe.com/v1
      headers=[Authorization=:env:STRIPE_SECRET_KEY]
      timeout=10
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
      path=/public/:*
      pool=standard
      /* No services — JSMAWS.rpc is not available */
    ]
  ]
)]
```

---

## 9. Access Control

Service access is scoped to routes. An applet can only access services declared in its route's `services` list.

- If a route has no `services`, `globalThis.JSMAWS.rpc` is `undefined`.
- If an applet tries to access a service not in its route's list, the responder returns an `rpc-error` with code `ACCESS_DENIED`.
- Service names are validated against the global `services` configuration.

This prevents applets from accessing services they shouldn't (e.g., a public-facing applet accessing the payment API).

---

## 10. Transaction Support

Transactions are supported for SQL adapters. A transaction is a sequence of operations that are executed atomically.

**Protocol:**

```javascript
// Begin transaction
await rpc.write('rpc-req', JSON.stringify({ reqId: 'tx-begin', service: 'db', op: 'begin' }));
const beginRes = await readRpcResponse(rpc, 'tx-begin');
const { txId } = beginRes;

// Execute operations within transaction
await rpc.write('rpc-req', JSON.stringify({
    reqId: 'tx-q1', service: 'db', op: 'query',
    txId,
    sql: 'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
    params: [100, fromAccountId],
}));
await readRpcResponse(rpc, 'tx-q1');

await rpc.write('rpc-req', JSON.stringify({
    reqId: 'tx-q2', service: 'db', op: 'query',
    txId,
    sql: 'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
    params: [100, toAccountId],
}));
await readRpcResponse(rpc, 'tx-q2');

// Commit
await rpc.write('rpc-req', JSON.stringify({ reqId: 'tx-commit', service: 'db', op: 'commit', txId }));
await readRpcResponse(rpc, 'tx-commit');
```

**Transaction lifecycle:**
- Transactions are tied to the applet worker's lifetime
- If the applet worker terminates without committing, the responder automatically rolls back open transactions
- Transaction IDs are scoped to the applet worker (not shared across workers)

---

## 11. Connection Pool Management

Connection pools are managed by the responder process:

- Each service has its own connection pool
- Pool size is configured per service (`maxConnections`)
- Connections are borrowed for the duration of an RPC operation (or transaction)
- Idle connections are returned to the pool after `idleTimeout` seconds
- If the pool is exhausted, RPC requests wait (with a configurable timeout)

**Pool configuration:**

```slid
db=[
  adapter=@postgres
  /* ... connection params ... */
  maxConnections=10      /* Maximum pool size */
  minConnections=2       /* Minimum pool size (pre-warmed) */
  idleTimeout=30         /* Seconds before idle connection is closed */
  acquireTimeout=5       /* Seconds to wait for a connection before error */
]
```

---

## 12. Custom Adapters

Administrators can provide custom service adapters:

```slid
services=[
  myCustomService=[
    adapter=./adapters/my-custom-adapter.esm.js
    /* ... custom config ... */
  ]
]
```

Custom adapters must implement the adapter interface (see Section 5). They are loaded by the responder process and run with responder permissions.

---

## 13. Implementation Plan

### Phase 1: Core Infrastructure

1. **Service process** in `src/rpc-service-process.esm.js`
   - Extends `ServiceProcess` base class (like `ResponderProcess`, `RouterProcess`)
   - JSMAWS calls `Deno.listen()` (Unix domain socket or TCP loopback) and passes accepted connections to `SocketTransport`
   - Loads and initializes service adapters on startup
   - Manages connection pools for each configured service
   - Routes `rpc-req` messages to the appropriate adapter
   - Returns `rpc-res` or `rpc-error` responses

2. **RPC manager** in `src/rpc-manager.esm.js`
   - Loaded by the service process
   - Manages service adapter lifecycle (`init`, `execute`, `shutdown`)
   - Manages connection pools per service
   - Enforces access control (validates service name against allowed list)

3. **RPC relay** in `src/responder-process.esm.js`
   - Open `rpc` channel when route has services
   - JSMAWS calls `Deno.connect()` to reach service process; wraps connection in `SocketTransport`
   - Start RPC request read loop; forward `rpc-req` to service process via `SocketTransport`
   - Return `rpc-res`/`rpc-error` from service process back to applet

4. **Bootstrap update** in `src/applets/bootstrap.esm.js`
   - Open `rpc` channel when `setupData.services` is non-empty
   - Expose as `globalThis.JSMAWS.rpc`

5. **Configuration update** in `src/configuration.esm.js`
   - Add `services` getter
   - Add route-level `services` access control
   - Add socket address configuration for service process (Unix domain socket path or TCP port)

6. **Operator integration** in `src/operator-process.esm.js`
   - Spawn and manage service process lifecycle (like responder pool management)
   - Pass socket address to responders via setup data

### Phase 2: Built-in Adapters

Implement built-in adapters in `src/rpc/`:
- `src/rpc/postgres.esm.js` — `@postgres`
- `src/rpc/mysql.esm.js` — `@mysql`
- `src/rpc/sqlite.esm.js` — `@sqlite`
- `src/rpc/redis.esm.js` — `@redis`
- `src/rpc/mongodb.esm.js` — `@mongodb`
- `src/rpc/http.esm.js` — `@http`
- `src/rpc/kv.esm.js` — `@kv`

### Phase 3: Transaction Support

- Add transaction management to SQL adapters
- Add transaction lifecycle tracking in RPC manager
- Auto-rollback on applet worker termination

### Phase 4: Tests and Documentation

- Unit tests for each adapter
- Integration tests for RPC manager
- E2E tests for RPC-enabled routes
- Applet development guide: using `JSMAWS.rpc` in applets

---

## 14. Security Considerations

- **Credentials in environment variables**: Service credentials should never appear in config files. Use `:env:VAR_NAME` syntax.
- **Route-scoped access**: Applets can only access services declared for their route. This prevents privilege escalation.
- **SQL injection prevention**: SQL adapters should use parameterized queries. The adapter interface requires `params` to be separate from `sql`.
- **Connection pool isolation**: Connection pools live in the service process, not in responders. Responders relay RPC calls but do not hold service connections directly.
- **Adapter trust**: Custom adapters run with responder permissions. Administrators should audit adapter code.
- **Error message sanitization**: RPC errors returned to applets should not include internal connection details (e.g., database host, credentials).

---

## 15. Open Questions

1. **Should service adapters be allowed to run in a separate process?** (Option D)
   - **Resolved** Yes, service adapters run in separate processes.
2. **Should there be a query builder API?** (e.g., `{ op: 'select', table: 'users', where: { id: 1 } }`)
   - **Resolved** No. SQL prepared-statement with variable-binding **must** be supported for security reasons, but a query builder would be an applet implementation concern, not an RPC protocol feature.
3. **How should large result sets be handled?**
   - **Resolved** services return results as soon as they are available. Large results generate backpressure via PolyTransport. Applets need to plan for result pagination (e.g. SQL `limit`).
4. **Should there be a schema validation layer?** (e.g., validate query results against a schema)
   - **Resolved** this is an applet (or service-specific) concern, not an RPC API concern.
5. **How should connection pool exhaustion be handled?**
   - **Resolved** Return `rpc-error` with code `POOL_EXHAUSTED` after `acquireTimeout`. Applet can retry or return a 503.
6. **Should services be hot-reloadable?** (e.g., update credentials without restarting) — Complex; propose as a future enhancement.
7. **Centralized service process via SocketTransport**
   - **Resolved**: Service adapters run in dedicated shared service processes (Option D). JSMAWS manages the socket listen/connect steps (Unix domain socket or TCP loopback); `SocketTransport` wraps the resulting Deno socket connections. This caps connection count at `maxConnections` regardless of responder count, and service connections survive responder recycling. The applet-facing `JSMAWS.rpc` API is identical regardless of whether the per-responder or centralized model is used.

---

[supplemental keywords: RPC, remote procedure call, database, SQL, NoSQL, PostgreSQL, MySQL, SQLite, Redis, MongoDB, HTTP API, key-value store, Deno KV, connection pool, service adapter, pluggable, modular, responder, transaction, query, CRUD, service, credentials, environment variables, access control, route-scoped, data access, data source, services, rpc channel, JSMAWS.rpc]
