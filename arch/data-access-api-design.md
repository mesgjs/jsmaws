# JSMAWS Data Access API Design

**Status:** [DRAFT]
**Date:** 2026-04-27

---

## 1. Problem Statement

JSMAWS applets currently have no server-provided mechanism for accessing data stores. An applet that needs to query a database, read from a cache, or call an external API must:

1. Establish its own connection (using `Deno.connect`, `fetch`, etc.)
2. Manage credentials directly (hardcoded or via environment variables it can't access)
3. Handle connection pooling itself (one-shot workers make this impossible)
4. Implement its own error handling and retry logic

This is impractical for most real-world applications. The goal is a **modular, pluggable** data access API that:

- Provides applets with access to configured data sources
- Manages connection pooling at the responder-process level (not per-worker)
- Keeps credentials out of applet code
- Supports multiple data source types (SQL, NoSQL, KV, HTTP APIs, etc.)
- Is flexible enough to support custom data source adapters

---

## 2. Design Principles

1. **Connection pooling at the responder level**: Connections are managed by the responder process (long-lived), not by individual applet workers (one-shot). Applets request a connection from the pool, use it, and release it.
2. **Credentials in configuration, not applet code**: Data source credentials are configured in `jsmaws.slid` (or environment variables), not in applet code.
3. **Pluggable adapters**: Each data source type is implemented as an adapter module. Custom adapters can be provided by administrators.
4. **Applet-facing API via IPC**: Applets communicate with the data access layer via a new PolyTransport channel (`data`), not via direct database connections.
5. **Scoped access**: Routes/pools declare which data sources they can access. Applets cannot access data sources not declared for their route.
6. **Mesgjs-compatible**: The API should be expressible in Mesgjs message-passing style.

---

## 3. Architecture Overview

```
Applet Worker (sandboxed)
  │  PostMessageTransport 'data' channel
  │  Sends: { op: 'query', source: 'db', sql: '...', params: [...] }
  │  Receives: { rows: [...], rowCount: N }
  ▼
Responder Process (unprivileged, long-lived)
  │  Data Access Manager
  │  - Holds connection pools for each configured data source
  │  - Routes data requests to the appropriate adapter
  │  - Enforces access control (which sources this route can use)
  ▼
Data Source Adapter (loaded by responder)
  │  e.g., PostgreSQL adapter, Redis adapter, HTTP API adapter
  ▼
External Data Source (database, cache, API)
```

The key insight is that **connection pools live in the responder process**, which is long-lived. Applet workers are one-shot, but they can borrow a connection from the pool for the duration of their request.

---

## 4. Data Channel Protocol

A new PolyTransport channel (`data`) is added to the applet communication protocol. This channel is exposed via `globalThis.JSMAWS.data` (alongside `.server` and `.bidi`).

### Channel Setup

The `data` channel is only opened when the route has data sources configured. The bootstrap reads the setup data and opens the channel if `setupData.dataSources` is non-empty.

```javascript
// In bootstrap.esm.js (addition):
if (setupData.dataSources?.length > 0) {
    const dataChannel = await transport.requestChannel('data');
    await dataChannel.addMessageTypes(['data-req', 'data-res', 'data-error']);
    jsmawsNamespace.data = dataChannel;
}
```

### Request Message (`data-req`)

```javascript
// Applet → Responder
{
    reqId: 'dr-1',          // Unique request ID (for matching responses)
    source: 'db',           // Data source name (must be in route's dataSources list)
    op: 'query',            // Operation type (source-specific)
    // ... operation-specific fields
}
```

### Response Message (`data-res`)

```javascript
// Responder → Applet
{
    reqId: 'dr-1',          // Matches the request
    // ... operation-specific result fields
}
```

### Error Message (`data-error`)

```javascript
// Responder → Applet
{
    reqId: 'dr-1',          // Matches the request
    error: 'Connection refused',
    code: 'ECONNREFUSED',   // Optional error code
}
```

---

## 5. Data Source Adapter Interface

A data source adapter is a JavaScript module that manages connections to a specific data source type:

```javascript
// data-source-adapter interface (conceptual)
export default {
    /**
     * Initialize the adapter (called once when the responder starts).
     * @param {object} config - Adapter configuration from jsmaws.slid
     */
    async init (config) { ... },

    /**
     * Execute a data operation.
     * @param {object} request - The data-req payload (minus reqId and source)
     * @returns {object} - The data-res payload (minus reqId)
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

The applet sends a `data-req` message and awaits a `data-res` or `data-error` response. This is the simplest model and covers the majority of use cases (queries, lookups, writes).

**Applet code:**

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;
    const data = globalThis.JSMAWS.data;

    // Read request
    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;
    let requestData;
    await reqMsg.process(() => { requestData = JSON.parse(reqMsg.text); });

    const { routeParams } = requestData;

    try {
        // Query the database
        await data.write('data-req', JSON.stringify({
            reqId: 'dr-1',
            source: 'db',
            op: 'query',
            sql: 'SELECT * FROM users WHERE id = $1',
            params: [routeParams.userId],
        }));

        const resMsg = await data.read({ only: ['data-res', 'data-error'], decode: true });
        if (!resMsg) throw new Error('Data channel closed');

        let result;
        await resMsg.process(() => { result = JSON.parse(resMsg.text); });

        if (resMsg.messageType === 'data-error') {
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
- Works well for most CRUD operations

**Disadvantages:**
- One request at a time per applet (no concurrent data requests)
- No streaming results (must buffer entire result set)

---

### Option B: Concurrent Requests with reqId Matching

The applet can send multiple `data-req` messages concurrently and match responses by `reqId`. This enables parallel data fetching.

**Applet code:**

```javascript
// Send two queries concurrently
await data.write('data-req', JSON.stringify({
    reqId: 'dr-user',
    source: 'db',
    op: 'query',
    sql: 'SELECT * FROM users WHERE id = $1',
    params: [userId],
}));

await data.write('data-req', JSON.stringify({
    reqId: 'dr-prefs',
    source: 'db',
    op: 'query',
    sql: 'SELECT * FROM preferences WHERE user_id = $1',
    params: [userId],
}));

// Collect both responses (order may vary)
const responses = {};
for (let i = 0; i < 2; i++) {
    const resMsg = await data.read({ only: ['data-res', 'data-error'], decode: true });
    if (!resMsg) break;
    await resMsg.process(() => {
        const result = JSON.parse(resMsg.text);
        responses[result.reqId] = result;
    });
}

const user = responses['dr-user']?.rows[0];
const prefs = responses['dr-prefs']?.rows[0];
```

**Advantages:**
- Enables parallel data fetching (reduces latency for multi-source requests)
- Natural extension of Option A

**Disadvantages:**
- More complex applet code
- Requires reqId management

---

### Option C: Streaming Results

For large result sets, the responder streams rows back to the applet as they arrive from the database. This avoids buffering the entire result set in memory.

**Protocol extension:**

```javascript
// Responder → Applet: streaming response
{ reqId: 'dr-1', type: 'data-res-start', columns: ['id', 'name', 'email'] }
{ reqId: 'dr-1', type: 'data-res-row',   row: [1, 'Alice', 'alice@example.com'] }
{ reqId: 'dr-1', type: 'data-res-row',   row: [2, 'Bob',   'bob@example.com'] }
{ reqId: 'dr-1', type: 'data-res-end',   rowCount: 2 }
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

### Option D: Data Access via a Dedicated Data Service Process

A separate "data service" process manages all data source connections. The responder sends data requests to this service via IPC.

**Architecture:**

```
Responder → [data IPC] → Data Service Process → [data result] → Responder → Applet
```

**Advantages:**
- Data connections are fully isolated from responder processes
- Data service can be updated independently
- Multiple responder processes share a single connection pool

**Disadvantages:**
- Adds IPC round-trip latency to every data request
- Requires a new process type and IPC protocol
- Significant implementation complexity

**Verdict:** Viable for high-scale deployments where connection pool sharing across responders is important. Propose as a future enhancement. Initial implementation uses per-responder connection pools (Option A/B).

---

## 7. Built-in Data Source Adapters

### 7.1 `@postgres` — PostgreSQL

```slid
dataSources=[
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
dataSources=[
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
dataSources=[
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
dataSources=[
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
dataSources=[
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
dataSources=[
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
  /* Global data source definitions */
  dataSources=[
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
      /* Declare which data sources this route can access */
      dataSources=[db cache]
    ]
    [
      path=/api/payments/:*
      pool=standard
      dataSources=[db paymentApi]
    ]
    [
      path=/public/:*
      pool=standard
      /* No dataSources — JSMAWS.data is not available */
    ]
  ]
)]
```

---

## 9. Access Control

Data source access is scoped to routes. An applet can only access data sources declared in its route's `dataSources` list.

- If a route has no `dataSources`, `globalThis.JSMAWS.data` is `undefined`.
- If an applet tries to access a data source not in its route's list, the responder returns a `data-error` with code `ACCESS_DENIED`.
- Data source names are validated against the global `dataSources` configuration.

This prevents applets from accessing data sources they shouldn't (e.g., a public-facing applet accessing the payment API).

---

## 10. Transaction Support

Transactions are supported for SQL adapters. A transaction is a sequence of operations that are executed atomically.

**Protocol:**

```javascript
// Begin transaction
await data.write('data-req', JSON.stringify({ reqId: 'tx-begin', source: 'db', op: 'begin' }));
const beginRes = await readDataResponse(data, 'tx-begin');
const { txId } = beginRes;

// Execute operations within transaction
await data.write('data-req', JSON.stringify({
    reqId: 'tx-q1', source: 'db', op: 'query',
    txId,
    sql: 'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
    params: [100, fromAccountId],
}));
await readDataResponse(data, 'tx-q1');

await data.write('data-req', JSON.stringify({
    reqId: 'tx-q2', source: 'db', op: 'query',
    txId,
    sql: 'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
    params: [100, toAccountId],
}));
await readDataResponse(data, 'tx-q2');

// Commit
await data.write('data-req', JSON.stringify({ reqId: 'tx-commit', source: 'db', op: 'commit', txId }));
await readDataResponse(data, 'tx-commit');
```

**Transaction lifecycle:**
- Transactions are tied to the applet worker's lifetime
- If the applet worker terminates without committing, the responder automatically rolls back open transactions
- Transaction IDs are scoped to the applet worker (not shared across workers)

---

## 11. Connection Pool Management

Connection pools are managed by the responder process:

- Each data source has its own connection pool
- Pool size is configured per data source (`maxConnections`)
- Connections are borrowed for the duration of a data operation (or transaction)
- Idle connections are returned to the pool after `idleTimeout` seconds
- If the pool is exhausted, data requests wait (with a configurable timeout)

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

Administrators can provide custom data source adapters:

```slid
dataSources=[
  myCustomSource=[
    adapter=./adapters/my-custom-adapter.esm.js
    /* ... custom config ... */
  ]
]
```

Custom adapters must implement the adapter interface (see Section 5). They are loaded by the responder process and run with responder permissions.

---

## 13. Implementation Plan

### Phase 1: Core Infrastructure

1. **Data access manager** in `src/data-access-manager.esm.js`
   - Loads and initializes data source adapters
   - Manages connection pools
   - Routes data requests to the appropriate adapter
   - Enforces access control (route-scoped data sources)

2. **Data channel setup** in `src/responder-process.esm.js`
   - Open `data` channel when route has data sources
   - Start data request read loop
   - Forward requests to data access manager
   - Send responses back to applet

3. **Bootstrap update** in `src/applets/bootstrap.esm.js`
   - Open `data` channel when `setupData.dataSources` is non-empty
   - Expose as `globalThis.JSMAWS.data`

4. **Configuration update** in `src/configuration.esm.js`
   - Add `dataSources` getter
   - Add route-level `dataSources` access control

### Phase 2: Built-in Adapters

Implement built-in adapters in `src/data/`:
- `src/data/postgres.esm.js` — `@postgres`
- `src/data/mysql.esm.js` — `@mysql`
- `src/data/sqlite.esm.js` — `@sqlite`
- `src/data/redis.esm.js` — `@redis`
- `src/data/mongodb.esm.js` — `@mongodb`
- `src/data/http.esm.js` — `@http`
- `src/data/kv.esm.js` — `@kv`

### Phase 3: Transaction Support

- Add transaction management to SQL adapters
- Add transaction lifecycle tracking in data access manager
- Auto-rollback on applet worker termination

### Phase 4: Tests and Documentation

- Unit tests for each adapter
- Integration tests for data access manager
- E2E tests for data-enabled routes
- Applet development guide: using `JSMAWS.data` in applets

---

## 14. Security Considerations

- **Credentials in environment variables**: Data source credentials should never appear in config files. Use `:env:VAR_NAME` syntax.
- **Route-scoped access**: Applets can only access data sources declared for their route. This prevents privilege escalation.
- **SQL injection prevention**: SQL adapters should use parameterized queries. The adapter interface requires `params` to be separate from `sql`.
- **Connection pool isolation**: Each responder process has its own connection pool. Connections are not shared across processes.
- **Adapter trust**: Custom adapters run with responder permissions. Administrators should audit adapter code.
- **Error message sanitization**: Data errors returned to applets should not include internal connection details (e.g., database host, credentials).

---

## 15. Open Questions

1. **Should data source adapters be allowed to run in a separate process?** (Option D) — Propose as a future enhancement for high-scale deployments.
2. **Should there be a query builder API?** (e.g., `{ op: 'select', table: 'users', where: { id: 1 } }`) — Useful for simple queries, but adds complexity. Propose as an optional layer on top of raw SQL.
3. **How should large result sets be handled?** — Propose streaming as a future enhancement (Option C). Initial implementation buffers results.
4. **Should there be a schema validation layer?** (e.g., validate query results against a schema) — Useful for type safety, but adds complexity. Propose as an optional feature.
5. **How should connection pool exhaustion be handled?** — Return `data-error` with code `POOL_EXHAUSTED` after `acquireTimeout`. Applet can retry or return a 503.
6. **Should data sources be hot-reloadable?** (e.g., update credentials without restarting) — Complex; propose as a future enhancement.

---

[supplemental keywords: database, SQL, NoSQL, PostgreSQL, MySQL, SQLite, Redis, MongoDB, HTTP API, key-value store, Deno KV, connection pool, data access, adapter, pluggable, modular, responder, transaction, query, CRUD, data source, credentials, environment variables, access control, route-scoped]
