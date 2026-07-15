# JSMAWS Mod-App Development Guide

A **mod-app** (modular application) is a JavaScript ES module that handles HTTP requests within JSMAWS. Mod-apps are the primary extension point for the server: they receive requests, process them, and send responses — all through a well-defined channel API.

This guide covers everything you need to write, test, and deploy mod-apps for JSMAWS.

## Table of Contents

1. [What Is a Mod-App?](#what-is-a-mod-app)
2. [The `setupData` Object](#the-setupdata-object)
3. [The `JSMAWS.server` Channel](#the-jsmawsserver-channel)
4. [Request Data Format](#request-data-format)
5. [Response Patterns](#response-patterns)
   - [Simple Response](#simple-response)
   - [Streaming Response (SSE)](#streaming-response-sse)
   - [Error Response](#error-response)
6. [WebSocket / Bidirectional Connections](#websocket--bidirectional-connections)
7. [The `JSMAWS.env` Secrets API](#the-jsmawsenv-secrets-api)
8. [Graceful Shutdown (`JSMAWS.shutdownDeadline`)](#graceful-shutdown-jsmawsshutdowndeadline)
9. [Logging from Mod-Apps](#logging-from-mod-apps)
10. [Error Handling Best Practices](#error-handling-best-practices)
11. [Routing Configuration](#routing-configuration)
12. [Persistent Mod-Apps & Standard Fetch Model](#persistent-mod-apps--standard-fetch-model)
13. [Example Mod-Apps](#example-mod-apps)

---

## What Is a Mod-App?

A mod-app is a standard JavaScript ES module that handles HTTP requests within JSMAWS. It runs in a sandboxed Web Worker with restricted Deno APIs.

JSMAWS supports two distinct programming models for mod-apps:

### 1. Low-Level Channel Model (Pull-based)
The default export is an `async function` that reads requests from and writes responses to `globalThis.JSMAWS.server` using the PolyTransport channel API:

```javascript
export default async function (setupData) {
    const server = globalThis.JSMAWS.server;
    // Read request, process, and write response...
}
```

### 2. Standard Fetch Model (Push-based)
The mod-app exports a standard `fetch(request, env)` handler (either as a default export object with a `fetch` method, or as a named `fetch` export). The JSMAWS bootstrap automatically maps incoming PolyTransport messages to standard `Request` and `Response` objects:

```javascript
export default {
    async fetch(request, env) {
        return new Response("Hello, World!");
    }
};
```

### Execution Modes
Depending on configuration, mod-apps can run in one of two execution modes:
- **One-Shot Mode (Default)**: A fresh Web Worker is spawned for each incoming request, executes the mod-app, and terminates immediately after the response is sent.
- **Persistent Mode**: Web Workers are kept alive and reused sequentially across multiple requests. This allows mod-apps to maintain persistent resources (such as database connection pools, in-memory caches, or active session stores) across requests.

**Key characteristics:**
- ES module format (`.esm.js` or `.js` extension)
- Supports both low-level channel and standard `fetch` APIs
- Runs in a sandboxed Web Worker with restricted Deno APIs
- Can be configured as one-shot or persistent via `jsmaws.slid`

---

## The `setupData` Object

The `setupData` argument passed to the default export contains server-provided metadata:

| Field | Type | Description |
|-------|------|-------------|
| `appPath` | string | Absolute path to this mod-app file |
| `mode` | string | Request mode: `'request'`, `'stream'`, or `'bidi'` |
| `maxChunkSize` | number | Maximum chunk size in bytes for this request |
| `appEnv` | object | Injected environment values (same as `JSMAWS.env`) |
| `keepDeno` | boolean | If `true`, the full Deno namespace is available (internal use) |
| `keepWorkers` | boolean | If `true`, Web Workers are not disabled (internal use) |

In practice, most mod-apps read request data from `JSMAWS.server` rather than using `setupData` directly. The `maxChunkSize` field is informational. Writes are chunked automatically.

---

## The `JSMAWS.server` Channel

`globalThis.JSMAWS.server` is a PolyTransport channel that connects the mod-app to the JSMAWS server. All request/response communication happens through this channel.

**Message types on `JSMAWS.server`:**

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `req` | server → mod-app | Incoming request metadata and body |
| `res` | mod-app → server | Response status, headers, and mode |
| `res-frame` | mod-app → server | Response body chunk (or `null` to end stream) |
| `res-error` | mod-app → server | Error response (server returns 500) |
| `bidi-frame` | bidirectional | WebSocket relay frames (bidi mode only) |

**Basic channel usage pattern:**

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;

    // 1. Read the incoming request (with UTF-8 decoding)
    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return; // Channel closed unexpectedly

    let requestData;
    await reqMsg.process(() => {
        requestData = JSON.parse(reqMsg.text);
    });

    // 2. Process the request...

    // 3. Send the response
    await server.write('res', JSON.stringify({ status: 200, headers: { ... } }));
    await server.write('res-frame', responseBody);
    await server.write('res-frame', null); // End of stream
}
```

> **Important:** Always call `await reqMsg.process(callback)` or `await reqMsg.done()` after reading a message. This releases the flow-control budget and allows additional messages to be delivered.

---

## Request Data Format

The `req` message contains a JSON object with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method (`'GET'`, `'POST'`, etc.) |
| `url` | string | Full request URL (e.g., `'https://example.com/api/users?page=2'`) |
| `headers` | object | Request headers (lowercase keys, per Fetch API spec) |
| `routeParams` | object | Named route parameters (e.g., `{ id: '123' }` for `/users/:id`) |
| `routeTail` | string | Tail wildcard match (for `:*` routes) |
| `body` | number[] | Request body as a byte array (may be empty) |
| `identity` | object \| null | Authenticated identity (from `authn` providers), or `null` |
| `maxChunkSize` | number | Maximum chunk size in bytes for this request |

**Accessing request data:**

```javascript
const { method, url, headers, routeParams, routeTail, body, identity } = requestData;

// Parse URL for query parameters
const urlObj = new URL(url);
const page = urlObj.searchParams.get('page') ?? '1';

// Access route parameters
const userId = routeParams?.id;

// Access authenticated identity
if (identity) {
    const { sub, roles } = identity;
    // sub: subject identifier (e.g., username or user ID)
    // roles: array of role strings (if provided by the auth provider)
}

// Decode request body
if (body && body.length > 0) {
    const bodyText = new TextDecoder().decode(new Uint8Array(body));
    const bodyData = JSON.parse(bodyText);
}
```

---

## Response Patterns

### Simple Response

A simple response sends a single body and ends:

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;

    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;

    let requestData;
    await reqMsg.process(() => {
        requestData = JSON.parse(reqMsg.text);
    });

    const responseBody = JSON.stringify({ message: 'Hello, World!' });

    // Send response metadata (status + headers)
    await server.write('res', JSON.stringify({
        status: 200,
        headers: {
            'content-type': 'application/json',
            'content-length': new TextEncoder().encode(responseBody).length.toString(),
        },
    }));

    // Send response body
    await server.write('res-frame', responseBody);

    // Signal end of stream (required)
    await server.write('res-frame', null);
}
```

**`res` message fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status code (e.g., `200`, `404`) |
| `headers` | object | Response headers (lowercase keys recommended) |
| `mode` | string | Response mode: omit for regular, `'stream'` for SSE, `'bidi'` for WebSocket |

### Streaming Response (SSE)

For Server-Sent Events or other streaming responses, set `mode: 'stream'` in the `res` message and send multiple `res-frame` messages:

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;

    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;

    await reqMsg.process(() => {}); // Release flow control

    // Send response metadata with stream mode
    await server.write('res', JSON.stringify({
        status: 200,
        mode: 'stream',
        headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
        },
    }));

    // Send SSE events
    for (let i = 1; i <= 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const event = `data: ${JSON.stringify({ count: i, time: new Date().toISOString() })}\n\n`;
        await server.write('res-frame', event);
    }

    // Signal end of stream
    await server.write('res-frame', null);
}
```

**Streaming notes:**
- Each `res-frame` write sends one chunk of the response body
- `res-frame` with `null` data signals end of stream
- The pool handling streaming requests should have `resType=[stream bidi]` and `maxReqs=1`

### Error Response

Use `res-error` to signal an unrecoverable error. JSMAWS will return a 500 Internal Server Error to the client:

```javascript
try {
    // ... process request ...
} catch (error) {
    await server.write('res-error', JSON.stringify({
        error: error.message,
        stack: error.stack,
    }));
}
```

For application-level errors (e.g., 404, 400), use a normal `res` message with the appropriate status code instead:

```javascript
await server.write('res', JSON.stringify({
    status: 404,
    headers: { 'content-type': 'text/plain' },
}));
await server.write('res-frame', 'Not Found');
await server.write('res-frame', null);
```

---

## WebSocket / Bidirectional Connections

WebSocket connections use `mode: 'bidi'` and the `bidi-frame` message type for relaying NestedTransport frames between the mod-app and the client.

```javascript
import { NestedTransport } from '@poly-transport/transport/nested.esm.js';
import { Channel } from '@poly-transport/channel.esm.js';

export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;

    // Read the incoming request
    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;

    let requestData;
    await reqMsg.process(() => {
        requestData = JSON.parse(reqMsg.text);
    });

    // Verify this is a WebSocket upgrade request
    if (requestData.headers?.upgrade?.toLowerCase() !== 'websocket') {
        await server.write('res-error', JSON.stringify({ error: 'Expected WebSocket upgrade' }));
        return;
    }

    // Accept the WebSocket upgrade (status 101)
    await server.write('res', JSON.stringify({
        status: 101,
        mode: 'bidi',
        headers: {
            upgrade: 'websocket',
            connection: 'upgrade',
        },
    }));

    // Create NestedTransport over the bidi relay channel
    // The server channel carries bidi-frame messages as the NestedTransport byte stream
    const nestedTransport = new NestedTransport({
        channel: server,
        messageType: 'bidi-frame',
    });

    nestedTransport.addEventListener('newChannel', (event) => {
        event.accept();
    });

    await nestedTransport.start();

    // Open the application channel (must match the client's channel name)
    const appChannel = await nestedTransport.requestChannel('myapp');
    await appChannel.addMessageTypes(['data']);

    // Echo loop
    while (true) {
        const msg = await appChannel.read({ only: 'data', decode: true });
        if (!msg) break; // Connection closed

        await msg.process(async () => {
            await appChannel.write('data', msg.text);
        });
    }

    await nestedTransport.stop();
}
```

**WebSocket notes:**
- The pool handling WebSocket connections must have `resType=[stream bidi]` and `maxReqs=1`
- The client must use `WebSocketTransport` + `NestedTransport` to communicate (see [`docs/client-bidi-integration.md`](client-bidi-integration.md))
- Channel names must match between the mod-app and the client

---

## The `JSMAWS.env` Secrets API

`globalThis.JSMAWS.env` is a frozen plain object containing key-value pairs injected by the server at startup. All values are strings.

```javascript
export default async function (_setupData) {
    // Access injected environment values
    const { databaseUrl, apiKey, featureFlag } = globalThis.JSMAWS.env;

    // Parse non-string values as needed
    const maxRetries = parseInt(globalThis.JSMAWS.env.maxRetries ?? '3', 10);
    const debugMode = globalThis.JSMAWS.env.debugMode === 'true';
}
```

Values are configured in `jsmaws.slid` using the `appEnv` key at the global, pool, or route level:

```slid
/* Global appEnv (all mod-apps) */
appEnv=[
    databaseUrl=:env:DATABASE_URL
    apiKey=:file:/run/secrets/api-key
]

/* Pool-level appEnv (overrides global for this pool) */
pools=[
    standard=[
        appEnv=[
            databaseUrl=:env:STAGING_DATABASE_URL
        ]
    ]
]

/* Route-level appEnv (highest priority) */
routes=[
    [path=/payments/:*  pool=standard  appEnv=[stripeKey=:env:STRIPE_KEY]]
]
```

`JSMAWS.env` is always a frozen object (never `null`). If a key is not configured, it will be `undefined`.

See [`docs/configuration.md` — Environment and Secrets Injection](configuration.md#environment-and-secrets-injection) for the full reference.

---

## Graceful Shutdown (`JSMAWS.shutdownDeadline`)

`globalThis.JSMAWS.shutdownDeadline` is a Promise that resolves to a timestamp (milliseconds since epoch) when the server begins graceful shutdown. Long-running mod-apps (streaming, WebSocket) should monitor this promise and close their connections before the deadline.

```javascript
export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;

    // ... accept WebSocket connection ...

    // Monitor shutdown deadline
    JSMAWS.shutdownDeadline.then((deadline) => {
        const remaining = deadline - Date.now();
        console.log(`Shutdown in ${remaining}ms — closing connection`);
        // Close the connection gracefully
        nestedTransport.stop();
    });

    // ... normal connection handling ...
}
```

For streaming responses, you can use `Promise.race` to stop sending when shutdown is requested:

```javascript
const shutdownPromise = JSMAWS.shutdownDeadline.then(() => null);

for (let i = 0; i < 100; i++) {
    const result = await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('tick'), 1000)),
        shutdownPromise,
    ]);

    if (result === null) break; // Shutdown requested

    await server.write('res-frame', `data: ${JSON.stringify({ tick: i })}\n\n`);
}

await server.write('res-frame', null);
```

---

## Logging from Mod-Apps

Use standard `console` methods for logging. JSMAWS intercepts console output and forwards it to the operator's log via the PolyTransport's internal "C2C" channel:

```javascript
console.log('Processing request');      // → INFO level
console.info('User authenticated');     // → INFO level
console.warn('Rate limit approaching'); // → WARN level
console.error('Database error:', err);  // → ERROR level
console.debug('Request headers:', hdrs); // → DEBUG level (only shown at debug log level)
```

**Notes:**
- `console.log` maps to INFO level (not DEBUG)
- Use `console.debug` for verbose diagnostic output
- Log messages appear in the operator's log with the sub-process ID prefix
- Avoid logging sensitive data (credentials, PII) — logs may be stored or forwarded

---

## Error Handling Best Practices

1. **Always handle channel close:** `server.read()` returns `null` when the channel closes. Check for `null` and return early:

   ```javascript
   const reqMsg = await server.read({ only: 'req', decode: true });
   if (!reqMsg) return; // Channel closed — exit cleanly
   ```

2. **Wrap processing in try/catch:** Send `res-error` on unexpected errors:

   ```javascript
   try {
       // ... process request ...
   } catch (error) {
       console.error('Unexpected error:', error.message);
       await server.write('res-error', JSON.stringify({ error: error.message }));
   }
   ```

3. **Check channel state before writing in streaming mode:** After a long delay, the channel may have closed:

   ```javascript
   import { Channel } from '@poly-transport/channel.esm.js';

   if (server.state === Channel.STATE_OPEN) {
       await server.write('res-frame', data);
   }
   ```

4. **Release flow control promptly:** Always call `await msg.process(callback)` or `await msg.done()` immediately after reading a message. Holding the flow-control budget blocks the pipeline.

5. **Return cleanly:** The mod-app function should return (or resolve) after sending the final `res-frame`. Do not leave the function hanging.

---

## Routing Configuration

Mod-apps are referenced in the JSMAWS configuration file. The `app` property of a route specifies the mod-app to load:

```slid
routes=[
    /* Absolute path */
    [path=/api/:*  pool=standard  app=/var/www/apps/api.esm.js]

    /* Relative path (resolved from appRoot) */
    [path=/api/:*  pool=standard  app=./api.esm.js]

    /* Built-in static file server */
    [path=/static/:*  pool=fast  app=@static  method=read]

    /* Filesystem routing: mod-app name from URL */
    [path=/@*/:?action  pool=standard]
]
```

**Route parameters** are available in `requestData.routeParams`:
- `:id` → `routeParams.id`
- `:?action` → `routeParams.action` (undefined if not present)
- `:*` → `routeTail` (the remaining path segments as a string)

See [`docs/configuration.md` — Routing](configuration.md#routing) for the full routing reference.

---

## Persistent Mod-Apps & Standard Fetch Model

JSMAWS supports **persistent, long-lived, multi-route, and multi-request mod-apps**. This allows mod-apps to maintain state (such as database connection pools, in-memory caches, or active session stores) across multiple requests, and introduces a standard `fetch` programming model.

### 1. Standard Fetch Model (Push-based)

The Standard Fetch Model provides a modern, standard-compliant developer experience. Instead of reading from and writing to PolyTransport channels directly, the mod-app exports a standard `fetch(request, env)` handler (similar to Cloudflare Workers or Deno Deploy).

The JSMAWS bootstrap module automatically handles the request loop and maps PolyTransport messages to standard `Request` and `Response` objects.

#### Example: Standard Fetch Mod-App

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

#### One-Shot vs. Persistent Compatibility
The Standard Fetch Model is **not restricted to persistent mod-apps**. Because the request/response mapping is handled entirely within the bootstrap module, the bootstrap supports it in both modes:
* **One-Shot Mode (Default)**: The bootstrap reads the single incoming `req` message, converts it to a standard `Request`, calls `fetch()`, streams the standard `Response` back, and terminates the worker.
* **Persistent Mode**: The bootstrap runs an infinite loop doing the exact same mapping for each incoming request, keeping the worker alive.

This allows developers to write standard `fetch`-based mod-apps and run them in either one-shot or persistent mode purely via configuration in `jsmaws.slid`.

#### Response Type Compatibility Boundaries
While the Standard Fetch Model provides a modern and standard-compliant developer experience, its compatibility varies depending on the response type:

| Response Type | Mode | Compatibility | Mapping Mechanism |
|---|---|---|---|
| **Standard HTTP** | `response` | **Fully Compatible** | Maps standard headers, status codes, and JSON/text/binary bodies directly to `res` and `res-frame` messages. |
| **Server-Sent Events (SSE) / Streaming** | `stream` | **Fully Compatible** | Maps standard `Response` objects whose `body` is a standard `ReadableStream`. The bootstrap module reads chunks from the stream and writes them as `res-frame` messages. |
| **Bidirectional WebSockets** | `bidi` | **Incompatible** | **Not compatible** with a simple `fetch(Request) -> Response` mapping. Bidirectional/WebSocket mod-apps must continue to use the **Low-Level Channel Model** to interact directly with the `bidi-frame` and nested transport relay channels. |

---

### 2. Low-Level Channel Model (Pull-based Loop)

If you prefer to use the PolyTransport channel API directly or need to support bidirectional WebSocket connections, you can write a persistent mod-app using the Low-Level Channel Model. The mod-app's default export is a function that runs an infinite loop reading requests from `globalThis.JSMAWS.server`.

#### Example: Low-Level Persistent Mod-App

```javascript
/**
 * Session Authentication Mod-App (Persistent Low-Level)
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

---

### 3. Performance Impact

Introducing persistent workers and the Standard Fetch Model has distinct performance trade-offs:

* **Persistent Workers vs. One-Shot Workers (Net Gain: Massive)**:
  * **One-Shot Overhead**: Spawning a new Deno Web Worker, running the bootstrap module, and initializing resources (like database connections or cryptographic keys) takes **5ms to 15ms+** per request.
  * **Persistent Reuse**: Reusing an existing warm worker reduces request startup latency to **sub-millisecond levels (< 0.2ms)**, representing a **25x to 75x speedup** for request initialization.
  * **Resource Efficiency**: Database connections and in-memory caches are kept warm, preventing connection exhaustion and cache-miss penalties.

* **Standard Fetch Model vs. Low-Level Channel Model (Net Loss: Negligible)**:
  * **Translation Overhead**: The Standard Fetch Model requires the bootstrap module to parse the incoming `req` JSON, construct standard `Request`/`Response` objects, and read the response body.
  * **Latency Impact**: Because this translation happens entirely in-memory within the same Web Worker thread, it introduces **negligible latency (< 0.1ms)**.
  * **Conclusion**: The massive performance gains of persistent worker reuse completely dwarf the sub-millisecond translation overhead of the Standard Fetch Model. For high-performance, standard-compliant services, the Standard Fetch Model is the recommended choice.

---

## Example Mod-Apps

The [`examples/apps/`](../examples/apps/) directory contains complete, working examples:

| File | Description |
|------|-------------|
| [`hello-world.esm.js`](../examples/apps/hello-world.esm.js) | Simple JSON response; reads query params and POST body |
| [`sse-clock.esm.js`](../examples/apps/sse-clock.esm.js) | Server-Sent Events; sends time updates every second |
| [`websocket-echo.esm.js`](../examples/apps/websocket-echo.esm.js) | WebSocket echo server using NestedTransport |
| [`auth-echo.esm.js`](../examples/apps/auth-echo.esm.js) | Returns the authenticated identity from the request |

### Minimal mod-app template

```javascript
/**
 * My Mod-App
 * Copyright 2026 Your Name
 */

export default async function (_setupData) {
    const server = globalThis.JSMAWS.server;

    // Read the incoming request
    const reqMsg = await server.read({ only: 'req', decode: true });
    if (!reqMsg) return;

    let requestData;
    await reqMsg.process(() => {
        requestData = JSON.parse(reqMsg.text);
    });

    const { method, url } = requestData;

    try {
        // Your application logic here
        const responseBody = JSON.stringify({ ok: true, method, url });

        await server.write('res', JSON.stringify({
            status: 200,
            headers: {
                'content-type': 'application/json',
                'content-length': new TextEncoder().encode(responseBody).length.toString(),
            },
        }));

        await server.write('res-frame', responseBody);
        await server.write('res-frame', null);

    } catch (error) {
        console.error('Error handling request:', error.message);
        await server.write('res-error', JSON.stringify({ error: error.message }));
    }
}
```

---

## See Also

- [`docs/configuration.md`](configuration.md) — Full configuration reference (routing, pools, auth, appEnv)
- [`docs/client-bidi-integration.md`](client-bidi-integration.md) — Client-side WebSocket/PolyTransport integration
- [`docs/deployment.md`](deployment.md) — Deploying JSMAWS in production
- [`examples/apps/`](../examples/apps/) — Complete example mod-apps
- [`examples/clients/`](../examples/clients/) — Example clients for testing mod-apps
