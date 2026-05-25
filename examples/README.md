# JSMAWS Examples

This directory contains example mod-apps and test clients to demonstrate JSMAWS features.

## Example Mod-Apps

### [`apps/hello-world.esm.js`](apps/hello-world.esm.js)

Simple HTTP request/response mod-app that returns a JSON greeting.

**Features:**
- Single-frame response
- Query parameter handling
- JSON response

**Test:**
```bash
deno run --allow-net examples/clients/http-hello.esm.js
```

### [`apps/sse-clock.esm.js`](apps/sse-clock.esm.js)

Server-Sent Events (SSE) mod-app that streams time updates.

**Features:**
- Streaming mode
- Long-lived connection
- Multiple frames over time
- Graceful close

**Test:**
```bash
deno run --allow-net examples/clients/sse-clock.esm.js
```

### [`apps/websocket-echo.esm.js`](apps/websocket-echo.esm.js)

WebSocket echo server that demonstrates bidirectional communication.

**Features:**
- Bidirectional mode (WebSocket upgrade)
- Message echoing
- PolyTransport flow control

**Test:**
```bash
deno run --allow-net examples/clients/ws-echo.esm.js
```

### [`apps/auth-echo.esm.js`](apps/auth-echo.esm.js)

Echoes the authenticated identity back to the caller as JSON. Useful for testing authentication configuration.

## Test Clients

| Client | Description |
|--------|-------------|
| [`clients/http-hello.esm.js`](clients/http-hello.esm.js) | Tests the hello-world mod-app with various HTTP requests |
| [`clients/sse-clock.esm.js`](clients/sse-clock.esm.js) | Connects to the SSE clock mod-app and displays received events |
| [`clients/ws-echo.esm.js`](clients/ws-echo.esm.js) | Connects to the WebSocket echo mod-app and sends test messages |

## Running the Examples

1. **Start JSMAWS** with the example configuration:
   ```bash
   deno run --allow-all --unstable-worker-options \
       src/operator.esm.js --config examples/jsmaws-examples.slid
   ```

2. **Run a test client** in another terminal:
   ```bash
   deno run --allow-net examples/clients/http-hello.esm.js
   deno run --allow-net examples/clients/sse-clock.esm.js
   deno run --allow-net examples/clients/ws-echo.esm.js
   ```

## Configuration

The example configuration file [`jsmaws-examples.slid`](jsmaws-examples.slid) defines routes for the example mod-apps.

## Key Concepts

### Mod-App Structure

A mod-app is an ES module with a default export function. JSMAWS bootstraps it in a Web Worker and provides a frozen `globalThis.JSMAWS` namespace:

```javascript
export default async function handler () {
    const { server } = globalThis.JSMAWS;

    // Read the incoming request
    const req = await server.read({ only: 'req', decode: true });
    if (!req) return;

    const { method, url, headers } = JSON.parse(req.text);
    await req.done();

    // Send the response
    await server.write('res', JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
    }));
}
```

### Response Modes

| Mode | Description | Example |
|------|-------------|---------|
| `response` | Single request/response | REST API, static data |
| `stream` | Long-lived streaming (SSE, chunked) | Real-time updates, file downloads |
| `bidi` | Bidirectional (WebSocket) | Chat, live collaboration |

### JSMAWS Namespace

`globalThis.JSMAWS` is a frozen object set by the bootstrap before the mod-app is imported:

| Property | Description |
|----------|-------------|
| `server` | PolyTransport channel for request/response communication |
| `env` | Frozen plain object of injected environment values (from `appEnv` config) |
| `request` | Request metadata: `{ method, url, headers, identity }` |
| `shutdownDeadline` | Promise that resolves to a deadline timestamp (ms) when shutdown is initiated |

### Security

- Mod-apps run in isolated Web Workers with restricted permissions
- Built-in mod-apps (like `@static`) receive an additional `config` object
- User mod-apps receive only `maxChunkSize` from the server configuration
- The authenticated identity is passed via `JSMAWS.request.identity` — mod-apps never see raw credential headers unless explicitly allowed by `requestFilter`

## See Also

- [`docs/mod-app-development.md`](../docs/mod-app-development.md) — Complete mod-app development guide
- [`docs/configuration.md`](../docs/configuration.md) — Full configuration reference
- [`docs/client-bidi-integration.md`](../docs/client-bidi-integration.md) — Client-side WebSocket/bidi integration
