# Persistent, Long-Lived Modular Applications (Mod-Apps)

Created: 2026-07-13

## Status: [APPROVED]

---

## 1. Executive Summary

This proposal outlines the architectural changes required to support **persistent, long-lived, multi-route, and multi-request mod-apps** in JSMAWS. 

Currently, JSMAWS operates on a strict **one-request-per-worker** model: every incoming HTTP request spawns a fresh Deno Web Worker, executes the mod-app, returns the response, and terminates the worker. While this provides excellent security isolation and prevents state leakage, it introduces overhead for high-frequency requests and makes it impossible to maintain persistent resources—such as database connection pools, in-memory caches, or active session stores—across requests.

By introducing **persistent mod-apps** as a per-route or per-pool configurable option, JSMAWS can support high-performance, stateful services (like session authentication, real-time notifications, or database-backed APIs) while fully leveraging the existing **mod-app affinity model** to route requests to the correct warm processes.

---

## 2. Problem Statement

The current one-request-per-worker model has several limitations for enterprise-grade applications:

1. **Resource Initialization Overhead**: Spawning a worker and establishing database connections or loading large cryptographic keys on every single request is slow and resource-intensive.
2. **Lack of Shared State**: Mod-apps cannot maintain in-memory caches, session states, or connection pools across requests.
3. **Connection Limits**: If every request spawns a worker that opens a database connection, the database will quickly run out of available connections under load.
4. **Limited Programming Model**: Developers must write mod-apps that handle exactly one request and exit, preventing the use of standard web frameworks (like Hono) or standard `fetch`-based handlers.

---

## 3. Proposed Solution

We propose introducing **Persistent Mod-Apps**, which run in long-lived Web Workers managed by a persistent worker pool inside each [`src/responder-process.esm.js`](src/responder-process.esm.js).

### Key Features:
- **Configurable Persistence**: Configured per-route or per-pool in [`jsmaws.slid`](jsmaws.slid).
- **Sequential Worker Reuse**: Persistent workers are kept alive and reused for subsequent requests, eliminating startup and initialization overhead.
- **Affinity Integration**: Leverages the existing operator-level affinity model to route requests for a specific mod-app to the responder process that already has warm workers for it.
- **Dual Programming Models**:
  1. **Low-Level Channel Model (Pull-based)**: Mod-apps run a loop reading from `globalThis.JSMAWS.server`.
  2. **Standard Fetch Model (Push-based)**: Mod-apps export a standard `fetch(request, env)` handler, and the bootstrap automatically maps incoming requests and outgoing responses to standard `Request` and `Response` objects.

---

## 4. Configuration Schema

Persistence can be configured at both the **pool** and **route** levels in [`jsmaws.slid`](jsmaws.slid).

### 4.1 Pool-Level Configuration
A pool can specify `persistent=@t` (true) to make all mod-apps running in that pool persistent.

```slid
pools=[
	/* Dedicated pool for persistent, database-connected services */
	auth=[
		minProcs=1
		maxProcs=5
		persistent=@t
		maxWorkerReqs=10000  /* Recycle workers after 10k requests to mitigate leaks */
		workerIdleTimeout=300 /* Terminate idle workers after 5 minutes */
	]
]
```

### 4.2 Route-Level Configuration
Alternatively, individual routes can be marked as `persistent=@t` (true) to run as persistent workers within a standard pool.

```slid
routes=[
	/* Route session authentication to persistent workers */
	[
		path='/api/auth/*'
		pool=standard
		app=/apps/auth.esm.js
		persistent=@t
	]
]
```

---

## 5. Architecture & Lifecycle

The persistent worker architecture integrates seamlessly with the existing JSMAWS process and communication model.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Operator Process                              │
│                                                                         │
│  1. Incoming Request ───► Route Match ───► Get Process with Affinity ───┐
└─────────────────────────────────────────────────────────────────────────│
                                                                          │
┌─────────────────────────────────────────────────────────────────────────▼┐
│                        Responder Process (Sub-Process)                   │
│                                                                          │
│  2. Check Persistent Worker Pool for appPath ────────────────────────────┐
│     ├──► Found Idle Worker ──► Mark Busy ──► Reuse                       │
│     └──► None Found ─────────► Spawn New Worker (up to maxWorkers)       │
└──────────────────────────────────────────────────────────────────────────│
                                                                           │
┌──────────────────────────────────────────────────────────────────────────▼┐
│                        Persistent Worker (Mod-App)                        │
│                                                                           │
│  3. Read 'req' from appChannel ──► Process Request ──► Write 'res'/'res-frame'
│  4. Send End-of-Stream (null) ──► Worker remains alive, returns to idle pool
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Responder Process Changes ([`src/responder-process.esm.js`](src/responder-process.esm.js))

The responder process will maintain a registry of persistent workers:

```javascript
// Inside ResponderProcess constructor
this.persistentWorkers = new Map(); // appPath -> Array<WorkerInfo>
```

Each `WorkerInfo` object tracks:
- `worker`: The Web Worker instance.
- `transport`: The `PostMessageTransport` instance.
- `appChannel`: The communication channel.
- `bootstrapChannel`: The bootstrap control channel.
- `c2cChannel`: The console forwarding channel.
- `status`: `'idle'` or `'busy'`.
- `reqCount`: Number of requests handled (for `maxWorkerReqs` recycling).
- `lastUsed`: Timestamp of last request completion (for `workerIdleTimeout` cleanup).

#### Request Dispatch Flow:
1. When a request arrives, check if the route or pool is configured for persistence.
2. If persistent, look for an `'idle'` worker in `this.persistentWorkers.get(appPath)`.
3. If found, mark it as `'busy'`, increment `reqCount`, and reuse its existing channels.
4. If not found, spawn a new worker using `#spawnAppWorker()`, add it to the registry as `'busy'`, and use it.
5. If the total worker count (active + persistent) exceeds the pool's `maxWorkers`, queue the request or return a `503 Service Unavailable`.

#### Response Completion Flow:
1. When the final `res-frame` (null data) is received, indicating the request is complete:
2. If the worker is persistent:
   - Do NOT stop the transport or close the worker.
   - Mark the worker's status as `'idle'` and update `lastUsed = Date.now()`.
   - If `maxWorkerReqs` is configured and `reqCount >= maxWorkerReqs`, gracefully recycle the worker (send a shutdown message, remove from registry, and let it exit).
   - Clean up the request entry from `this.activeRequests` so the responder's capacity is updated.

---

## 6. Programming Models

Persistent mod-apps can be written using two different programming models, depending on developer preference and complexity.

### 6.1 Low-Level Channel Model (Pull-based Loop)
This model is fully backward-compatible with the existing PolyTransport channel API. The mod-app's default export is a function that runs an infinite loop reading requests from `globalThis.JSMAWS.server`.

```javascript
/**
 * Session Authentication Mod-App (Persistent)
 * /apps/auth.esm.js
 */
import { connectDb } from './db.esm.js';

export default async function (setupData) {
	const server = globalThis.JSMAWS.server;
	
	// Initialize database connection ONCE at startup
	const db = await connectDb(globalThis.JSMAWS.env.DATABASE_URL);
	console.log('Database connection established');

	// Loop indefinitely to handle multiple requests
	while (true) {
		const reqMsg = await server.read({ only: 'req', decode: true });
		if (!reqMsg) break; // Exit loop if transport is stopped (shutdown)

		let requestData;
		await reqMsg.process(() => {
			requestData = JSON.parse(reqMsg.text);
		});

		const { method, url, body } = requestData;
		const urlObj = new URL(url);

		try {
			let responsePayload;
			if (urlObj.pathname === '/login') {
				responsePayload = await handleLogin(db, body);
			} else if (urlObj.pathname === '/logout') {
				responsePayload = await handleLogout(db, body);
			} else {
				responsePayload = { error: 'Not Found' };
			}

			// Send response
			await server.write('res', JSON.stringify({
				status: 200,
				headers: { 'content-type': 'application/json' },
			}));
			await server.write('res-frame', JSON.stringify(responsePayload));
			await server.write('res-frame', null); // End of stream

		} catch (error) {
			await server.write('res-error', JSON.stringify({
				error: error.message,
				stack: error.stack,
			}));
		}
	}
}
```

### 6.2 Standard Fetch Model (Push-based)
This model provides a modern, standard-compliant developer experience. The mod-app exports a standard `fetch` handler (similar to Cloudflare Workers or Deno Deploy). The bootstrap module automatically handles the request loop and maps PolyTransport messages to standard `Request` and `Response` objects.

**Note on One-Shot Compatibility**:
The Standard Fetch Model is **not restricted to persistent mod-apps**. Because the request/response mapping is handled entirely within the bootstrap module ([`src/apps/bootstrap.esm.js`](src/apps/bootstrap.esm.js)), the bootstrap can detect if a mod-app exports a `fetch` handler and support it in both modes:
*   **One-Shot Mode**: The bootstrap reads the single incoming `req` message, converts it to a standard `Request`, calls `fetch()`, streams the standard `Response` back, and terminates the worker.
*   **Persistent Mode**: The bootstrap runs an infinite loop doing the exact same mapping for each incoming request, keeping the worker alive.

This allows developers to write standard `fetch`-based mod-apps and run them in either one-shot or persistent mode purely via configuration in [`jsmaws.slid`](jsmaws.slid).

```javascript
/**
 * Session Authentication Mod-App (Standard Fetch)
 * /apps/auth.esm.js
 */
import { connectDb } from './db.esm.js';

let db = null;

export default {
	async fetch(request, env) {
		// Initialize database connection once on first request
		if (!db) {
			db = await connectDb(env.DATABASE_URL);
		}

		const url = new URL(request.url);

		if (url.pathname === '/login' && request.method === 'POST') {
			const credentials = await request.json();
			const session = await handleLogin(db, credentials);
			return Response.json(session);
		}

		if (url.pathname === '/logout' && request.method === 'POST') {
			await handleLogout(db, request.headers.get('Authorization'));
			return Response.json({ success: true });
		}

		return new Response('Not Found', { status: 404 });
	}
};
```

---

## 6.3 Response Type Compatibility Boundaries

While the **Standard Fetch Model** provides a modern and standard-compliant developer experience, its compatibility varies depending on the response type:

| Response Type | Mode | Compatibility | Mapping Mechanism |
|---|---|---|---|
| **Standard HTTP** | `response` | **Fully Compatible** | Maps standard headers, status codes, and JSON/text/binary bodies directly to `res` and `res-frame` messages. |
| **Server-Sent Events (SSE) / Streaming** | `stream` | **Fully Compatible** | Maps standard `Response` objects whose `body` is a standard `ReadableStream`. The bootstrap module reads chunks from the stream and writes them as `res-frame` messages. |
| **Bidirectional WebSockets** | `bidi` | **Incompatible** | **Not compatible** with a simple `fetch(Request) -> Response` mapping. Bidirectional/WebSocket mod-apps must continue to use the **Low-Level Channel Model** to interact directly with the `bidi-frame` and nested transport relay channels. |

---

## 6.4 Expected Performance Impact

Introducing persistent workers and the Standard Fetch Model has distinct performance trade-offs:

### 1. Persistent Workers vs. One-Shot Workers (Net Gain: Massive)
*   **One-Shot Overhead**: Spawning a new Deno Web Worker, running the bootstrap module, and initializing resources (like database connections or cryptographic keys) takes **5ms to 15ms+** per request.
*   **Persistent Reuse**: Reusing an existing warm worker reduces request startup latency to **sub-millisecond levels (< 0.2ms)**, representing a **25x to 75x speedup** for request initialization.
*   **Resource Efficiency**: Database connections and in-memory caches are kept warm, preventing connection exhaustion and cache-miss penalties.

### 2. Standard Fetch Model vs. Low-Level Channel Model (Net Loss: Negligible)
*   **Translation Overhead**: The Standard Fetch Model requires the bootstrap module to parse the incoming `req` JSON, construct standard `Request`/`Response` objects, and read the response body.
*   **Latency Impact**: Because this translation happens entirely in-memory within the same Web Worker thread, it introduces **negligible latency (< 0.1ms)**.
*   **Conclusion**: The massive performance gains of persistent worker reuse completely dwarf the sub-millisecond translation overhead of the Standard Fetch Model. For high-performance, standard-compliant services, the Standard Fetch Model is the recommended choice.

---

## 7. Implementation Plan

To implement this proposal, the following changes are required:

### Phase 1: Configuration & Schema Updates
1. Update [`src/configuration.esm.js`](src/configuration.esm.js) to parse and validate the new pool-level (`persistent`, `maxWorkerReqs`, `workerIdleTimeout`) and route-level (`persistent`) parameters.
2. Update [`arch/pool-configuration-design.md`](arch/pool-configuration-design.md) to document the new parameters.

### Phase 2: Bootstrap Module Enhancements
1. Update [`src/apps/bootstrap.esm.js`](src/apps/bootstrap.esm.js) to accept a `persistent` flag in the setup message.
2. If `persistent` is true, prevent the bootstrap from automatically stopping the transport and closing the worker when the default export function returns.
3. Implement the **Standard Fetch Model** wrapper in the bootstrap:
   - Detect if the imported module exports a `fetch` method or is an object with a `fetch` method.
   - If so, run an internal loop reading `req` messages, converting them to standard `Request` objects, invoking `fetch()`, and streaming the standard `Response` back as `res` and `res-frame` messages.

### Phase 3: Responder Process Pool Management
1. Update [`src/responder-process.esm.js`](src/responder-process.esm.js) to maintain the `this.persistentWorkers` registry.
2. Modify `#onWebRequest()` to check for persistence and reuse idle workers from the registry.
3. Modify `#processAppResponse()` and `#sendEndOfStream()` to return persistent workers to the idle pool instead of terminating them.
4. Implement a periodic cleanup timer in `ResponderProcess` to terminate persistent workers that have been idle longer than `workerIdleTimeout`.
5. Implement worker recycling when `maxWorkerReqs` is reached.

### Phase 4: Testing & Verification
1. Create a new test suite [`test/persistent-mod-apps.test.js`](test/persistent-mod-apps.test.js) to verify:
   - Persistent workers are reused across multiple requests.
   - Database connections or module-level states are preserved across requests.
   - Idle timeouts and request-count recycling work correctly.
   - Standard `fetch` handlers work seamlessly.
