# JSMAWS Refactoring Proposal: Adopt PolyTransport

**Status:** [APPROVED]  
**Date:** 2026-04-11  
**Updated:** 2026-04-13 (rev 5)  
**Scope:** Replace all custom IPC, bidi flow-control, and applet-communication code with the PolyTransport library

---

## 1. Executive Summary

JSMAWS currently implements three separate, hand-rolled communication layers:

| Layer | Current Implementation | Lines of Code |
|-------|----------------------|---------------|
| Operator ↔ Responder IPC | Custom SLID-over-pipe protocol in [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js) | ~774 |
| Responder ↔ Applet Worker | Raw `postMessage` with custom frame protocol | ~300 (in responder) |
| Operator ↔ Client (bidi/WebSocket) | Hand-rolled credit-based flow control in [`src/operator-request-state.esm.js`](../src/operator-request-state.esm.js) | ~384 |

PolyTransport (sibling repo at `resources/poly-transport`) provides a unified, well-tested library that covers all three of these layers with a single, consistent API. It supports:

- **`PipeTransport`** — byte-stream IPC over `stdin`/`stdout` (replaces the SLID-over-pipe protocol)
- **`PostMessageTransport`** — Web Worker `postMessage` communication (replaces the raw `postMessage` frame protocol)
- **`WebSocketTransport`** — WebSocket connections (replaces the hand-rolled bidi flow control)
- **`NestedTransport`** — PolyTransport-over-Channel (enables future extensibility)

Adopting PolyTransport eliminates ~1,500 lines of custom protocol code, replaces the hand-rolled credit-based flow control with a proven sliding-window implementation, and provides a uniform channel/message-type API across all communication boundaries.

Since there are no production deployments of JSMAWS, this refactoring can be done as a clean-slate replacement with no migration constraints.

---

## 2. Current Architecture: Communication Layers

### 2.1 Operator ↔ Responder IPC (Pipe)

The operator spawns responder processes via `Deno.Command` with `stdin: 'piped'` and `stdout: 'piped'`. Communication uses a custom binary protocol:

```
SOH + SLID-text + \n + [optional binary payload]
```

The [`IPCConnection`](../src/ipc-protocol.esm.js:372) class manages:
- Line-by-line reading with UTF-8 boundary handling
- Binary payload extraction (by `dataSize` field)
- Console output interception (SOH + `[(log level)]` prefix)
- Write serialization to prevent interleaving
- Request-specific handlers (`setRequestHandler`) and global message-type handlers (`onMessage`)
- Continuous monitoring loop (`startMonitoring`)

Message types: `RREQ`, `RRES`, `WREQ`, `WFRM`, `WERR`, `APLOUT`, `CFG`, `HALT`, `RIF`, `HCHK`

These verbs are replaced by PolyTransport channel message types as follows:

| Old Verb | New Message Type | Channel | Notes |
|----------|-----------------|---------|-------|
| `CFG` | `config-update` | `control` | Config payload changes from SLID to JSON |
| `HCHK` | `health-check` | `control` | Request side; reply is new `health-response` type |
| `HALT` | `shutdown` | `control` | Followed by `transport.stop()` for graceful drain |
| `RIF` | `scale-down` | `control` | Reduce in-flight requests |
| `RREQ` | `req` | `req-N` | Request metadata + body |
| `RRES` / `WFRM` | `res` + `res-frame` | `req-N` | Response metadata (`res`) and body chunks (`res-frame`) |
| `WERR` | `res-error` | `req-N` | Error response |
| `APLOUT` | `con-trace/debug/info/warn/error` | `req-N` | Applet console output; replaced by C2C on responder ↔ applet transport, then forwarded with `con-` prefix |
| *(capacity side-channel)* | `capacity-update` | `control` | Was piggybacked on frame messages; now a dedicated message type |

**Problems:**
- Custom binary framing is fragile (SOH prefix, SLID parsing, binary tail)
- Console output multiplexed on the same pipe as IPC messages (requires SOH prefix disambiguation)
- Write serialization is manual (`Serializer` class)
- No built-in flow control — backpressure is inferred from write timing
- Capacity reporting is piggybacked on frame messages as a side-channel

### 2.2 Responder ↔ Applet Worker (postMessage)

The responder spawns applet workers via `new Worker(bootstrapURL)` and communicates via raw `postMessage`. The protocol is an ad-hoc object format:

- **Responder → Applet:** `{ type: 'request', id, method, url, headers, ... }`
- **Applet → Responder:** `{ type: 'frame', id, mode, status, headers, data, final, keepAlive }`
- **Applet → Responder (console):** `{ type: 'console', level, content }`

**Problems:**
- No flow control between applet and responder
- No backpressure — a fast applet can flood the responder
- Console output is multiplexed with frame messages (requires `type` field disambiguation)
- Binary data (`data: Uint8Array`) is transferred by structured clone (no zero-copy)

### 2.3 Operator ↔ Client Bidi (WebSocket)

For bidirectional connections, the operator upgrades the HTTP connection to WebSocket and implements a custom credit-based flow control protocol:

- `initialCredits`, `maxChunkSize`, `maxBytesPerSecond`, `idleTimeout`, `maxBufferSize` are derived from configuration
- Credits are consumed on send and implicitly restored on receive
- Buffer overflow triggers connection termination

**Problems:**
- Flow control is duplicated between operator ([`operator-request-state.esm.js`](../src/operator-request-state.esm.js:76-148)) and responder ([`responder-process.esm.js`](../src/responder-process.esm.js:540-713))
- Credit accounting is manual and error-prone
- No standard protocol — clients must implement the same credit scheme
- WebSocket is the only supported bidi transport (no extensibility)

---

## 3. PolyTransport Overview

PolyTransport provides a unified API across all transport types:

```
Application
    │
    ▼
Channel (channel.esm.js)
    │  Message types, flow control, chunking, de-chunking
    ▼
Transport Base (transport/base.esm.js)
    │  Channel lifecycle, TCC protocol, handshake
    ▼
ByteTransport / PostMessageTransport
    │  Byte-stream encoding or postMessage dispatch
    ▼
PipeTransport / WebSocketTransport / NestedTransport
    │  Concrete I/O
    ▼
OS / Browser / Parent Channel
```

### Key Concepts

- **Transport:** A connection between two endpoints. Manages multiple channels. Lifecycle: `start()` → active → `stop()`.
- **Channel:** A logical bidirectional stream over a transport. Identified by name. Independent flow control per direction.
- **Message:** An application-defined unit. Large messages are split into **chunks** automatically. `eom: true` marks the last chunk.
- **Flow Control:** Per-channel sliding-window. A misbehaving channel can only block itself.
- **Message Types:** Named types registered via `channel.addMessageTypes([...])`. Enables structured, typed communication.
- **Console Content Channel (C2C):** A built-in channel for console output (`trace`, `debug`, `info`, `warn`, `error`). Eliminates the need to multiplex console output with IPC messages.

### Critical Constraint: Channel Name Persistence

**Channel names persist for the lifetime of a transport connection.** When a channel is closed, the transport retains a "nulled record" keyed by the channel's name (and first ID). This record is used to support channel reopening. The consequence is:

- **Per-request unique channel names would cause unbounded memory growth** — each request would add a nulled record that is never freed until the transport itself stops.
- **The correct pattern is a fixed pool of reusable channels** — a small set of channels with stable names (e.g., `req-0`, `req-1`, ..., `req-N`) that are checked out for a request and returned to the pool when the request completes.

This is analogous to a database connection pool: the pool size determines the maximum concurrency, and channels are reused rather than created per-request.

---

## 4. Dependency Management

PolyTransport is a sibling repository referenced via a `resources/poly-transport` symlink. This symlink is a **development-only convenience** and must not be referenced directly in import paths in production code.

The correct approach is to add PolyTransport's modules to JSMAWS's `deno.json` import map. PolyTransport itself uses an import map for its own dependencies (`@eventable`, `@task-queue`, `@updatable-event`). JSMAWS's `deno.json` should include both:

```json
{
    "imports": {
        "@eventable": "https://cdn.jsdelivr.net/gh/mesgjs/eventable@main/src/eventable.esm.js",
        "@task-queue": "https://cdn.jsdelivr.net/gh/mesgjs/task-queue@0.1.1/src/task-queue.esm.js",
        "@updatable-event": "https://cdn.jsdelivr.net/gh/mesgjs/updatable-event@main/src/updatable-event.esm.js",
        "@poly-transport/": "https://cdn.jsdelivr.net/gh/mesgjs/poly-transport@0.0.2/src/"
    }
}
```

Source files then import PolyTransport using the import map:

```javascript
import { PipeTransport } from '@poly-transport/transport/pipe.esm.js';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { WebSocketTransport } from '@poly-transport/transport/websocket.esm.js';
```

---

## 5. Proposed Mapping: JSMAWS → PolyTransport

### 5.1 Operator ↔ Responder: `PipeTransport` with Channel Pool

Replace [`IPCConnection`](../src/ipc-protocol.esm.js:372) with `PipeTransport`.

#### Channel Layout

Each operator ↔ responder transport has a **fixed set of channels** that persist for the transport's lifetime:

| Channel Name | Direction | Purpose |
|---|---|---|
| `control` | bidirectional | Config updates, health checks, shutdown, scale-down, capacity updates |
| `req-0` through `req-N` | bidirectional | Request/response pairs (pooled, reused per request) |

The C2C channel (built-in) handles console output from the responder process itself.

> **Applet console output uses req-channel message types, not C2C** — the C2C channel on the operator ↔ responder transport carries only responder process console output. Applet console output is forwarded from the applet's C2C channel (on the responder ↔ applet transport) to the operator via dedicated message types on the **corresponding `req-N` channel** (not the C2C channel). This allows the operator to associate console traffic with the specific request (and applet) that generated it, enabling proper logging attribution and traffic control: an applet flooding the console competes against its own request traffic, not the responder's console traffic.

#### Request Channel Pool

The channel pool starts with `minWorkers` channels (matching the pool's minimum process count) and grows lazily on demand up to `maxWorkers`. This amortizes channel creation cost across the first few requests rather than concentrating it at startup. Each channel creation requires a round-trip on the TCC; starting with `minWorkers` channels means only `minWorkers` round-trips at startup, with additional channels created as load increases.

When a request arrives, the operator checks out a channel from the pool:

```javascript
// Operator: check out a channel for a request
const channel = await requestChannelPool.acquire();
// acquire() either returns an available channel immediately,
// creates a new one (if below maxWorkers), or waits for one to be released

try {
    // Send request (text/JSON metadata)
    await channel.write('req', serializeRequest(req));

    // Loop 1: metadata and console output (dechunked — each read() returns one complete message)
    // 'res' carries HTTP response status + headers (sent once, before any res-frame chunks)
    // 'res-error' carries error response (sent instead of res + res-frame)
    // con-* carry forwarded applet console output
    const CON_TYPES = ['con-trace', 'con-debug', 'con-info', 'con-warn', 'con-error'];
    (async () => {
        while (true) {
            const msg = await channel.read({ only: ['res', 'res-error', ...CON_TYPES] });
            if (!msg) break;
            await msg.process(async () => {
                switch (msg.messageType) {
                case 'con-trace':
                case 'con-debug':
                case 'con-info':
                case 'con-warn':
                case 'con-error':
                    // Applet console output — log attributed to this request
                    // con-* messages may have no data (e.g. console.log() with no args)
                    const text = msg.data?.decode() ?? '';
                    const level = msg.messageType.slice(4); // strip 'con-' prefix
                    logger.log(level, `[req ${requestId}] ${text}`);
                    break;
                case 'res':
                    // 'res': HTTP response status + headers
                    handleResponseMetadata(msg.data.decode());
                    break;
                case 'res-error':
                    // res-error payload is text; decode via VirtualBuffer.decode()
                    handleError(msg.data.decode());
                    break;
                }
            });
        }
    })();

    // Loop 2: response body chunks (dechunk: false — relay verbatim without reassembly)
    // res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
    // Using dechunk:false avoids unnecessary buffering and reduces latency.
    // Note: bidi-frame relay traffic is handled in a separate loop below (also dechunk: false)
    while (true) {
        const msg = await channel.read({ only: 'res-frame', dechunk: false });
        if (!msg) break;
        let done = false;
        await msg.process(async () => {
            if (msg.data === undefined && msg.eom) {
                done = true; // zero-data + eom:true = end-of-stream signal
            } else {
                await handleResponseChunk(msg.data);
            }
        });
        if (done) break;
    }
} finally {
    // Return channel to pool (async: closes and reopens the channel between requests)
    await requestChannelPool.release(channel);
}

// For bidi requests: relay 'bidi-frame' from req-N → WS bidi channel.
// This loop runs concurrently with the response-frame loop above.
// dechunk: false is required — bidi-frame carries NestedTransport byte-stream
// chunks that must be forwarded verbatim without reassembly.
// eom: false on write — NestedTransport chunks are not application messages;
// each chunk is forwarded as a single-chunk "message" with no EOM semantics.
if (isBidiRequest) {
    (async () => {
        while (true) {
            const msg = await channel.read({ only: 'bidi-frame', dechunk: false });
            if (!msg) break;
            await msg.process(async () => {
                await context.bidiChannel.write('bidi-frame', msg.data, { eom: false });
            });
        }
    })();
}
```

The responder side accepts all `req-*` channels as they are requested:

```javascript
// Responder: accept all request channels
transport.addEventListener('newChannel', (event) => {
    const { channelName } = event.detail;
    if (channelName === 'control' || channelName.startsWith('req-')) {
        event.accept();
    } else {
        event.reject();
    }
});
```

#### Message Types per Channel

For the `control` channel:
```javascript
await controlChannel.addMessageTypes([
    'config-update',
    'health-check',
    'health-response',
    'shutdown',
    'scale-down',
    'capacity-update',
]);
```

For each `req-N` channel, the message types are defined as a shared constant (to avoid repetition across channel creation and reopening):
```javascript
// Defined once in src/request-channel-pool.esm.js (or a shared constants module)
const REQ_CHANNEL_MESSAGE_TYPES = [
    'req',          // operator → responder: HTTP request metadata + body (JSON text)
    'res',          // responder → operator: HTTP response status + headers (JSON text)
    'res-frame',    // responder → operator: response body chunk (binary relay, dechunk:false)
                    //   zero-data (undefined) + eom:true = end-of-stream signal
    'res-error',    // responder → operator: error response (JSON text)
    'bidi-frame',   // bidirectional relay: NestedTransport traffic between client and applet (bidi mode)
    // con-* message types for forwarded applet console output.
    // The 'con-' prefix is required to avoid collision with the C2C channel's native
    // bare names (trace/debug/info/warn/error) and with res-error on this same channel.
    'con-trace',    // responder → operator: applet console output (trace level)
    'con-debug',    // responder → operator: applet console output (debug level)
    'con-info',     // responder → operator: applet console output (info level)
    'con-warn',     // responder → operator: applet console output (warn level)
    'con-error',    // responder → operator: applet console output (error level)
];

await reqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);
```

> **`con-*` message types on `req-N` channels:** Applet console output forwarded from the responder to the operator uses `con-`-prefixed message types (`con-trace`, `con-debug`, `con-info`, `con-warn`, `con-error`). The `con-` prefix is required to avoid collision with the C2C channel's native bare names (`trace`, `debug`, `info`, `warn`, `error`) and with `res-error` on the same channel. The operator can use a filtered reader to process applet output separately from response frames:
> ```javascript
> // Read only applet console output from a req-N channel
> const CON_TYPES = ['con-trace', 'con-debug', 'con-info', 'con-warn', 'con-error'];
> const msg = await reqChannel.read({ only: CON_TYPES, decode: true });
> ```
>
> **`con-*` messages may have no data** — PolyTransport supports writing `null` or `undefined` as the data payload (dataSize = 0, text/data undefined). A `console.log()` call with no arguments, for example, produces a zero-data `con-info` message. Readers must handle this gracefully (e.g., `msg.data?.decode() ?? ''`).
>
> **`res-frame` end-of-stream convention:** A zero-data `res-frame` with `eom: true` signals end-of-stream. PolyTransport supports null/undefined data (dataSize = 0, `msg.data === undefined`). This is detectable in `dechunk: false` mode because `msg.eom === true` is meaningful there (it marks the last chunk of a message). In dechunked mode, `msg.eom` is always `true` and cannot be used as an EOS signal.

> **Decoding on `PipeTransport` and `WebSocketTransport` reads:** Both are byte-stream transports. String data sent across them is not automatically decoded. There are two approaches:
> - **`{ decode: true }` on `read()`** — use when all messages on the channel carry text. The decoded string is available as `msg.text`.
> - **`msg.data.decode()`** — use when a channel carries mixed message types (some text, some binary). Read without `{ decode: true }` and call `.decode()` only for the text messages. `msg.data` is a `VirtualBuffer` that supports `.decode()`.
>
> **Do not** use `{ decode: true }` on a read that may receive binary data — PolyTransport does not track the original content type and will attempt to decode binary data as text.

> **Dechunking and relay traffic:** By default, `read()` reassembles multi-chunk messages before returning (dechunking). This is correct for JSMAWS control messages, console output, and request/response metadata (`req`, `res`, `res-error`, `con-*`). However, `res-frame` and `bidi-frame` relay traffic must be forwarded verbatim without reassembly — reassembling `bidi-frame` would corrupt the nested protocol stream, and reassembling `res-frame` would add unnecessary buffering latency. Use `read({ dechunk: false })` for all `res-frame` and `bidi-frame` relay reads. Correspondingly, use `write('res-frame', data, { eom: ... })` and `write('bidi-frame', data, { eom: false })` when forwarding relay chunks. **Relay loops must always be separate from metadata loops** on the same channel, because `dechunk: false` applies to the entire read call and cannot be mixed with dechunked reads in a single loop.

#### Transport Setup

**Operator side (in [`src/process-manager.esm.js`](../src/process-manager.esm.js)):**

```javascript
import { PipeTransport } from '@poly-transport/transport/pipe.esm.js';

const child = command.spawn();
const c2cSymbol = Symbol('c2c');
const transport = new PipeTransport({
    readable: child.stdout,
    writable: child.stdin,
    c2cSymbol,  // Enable Console Content Channel
    logger: this.logger,
    maxChunkBytes: chunkingConfig.maxChunkSize,
});

transport.addEventListener('newChannel', (event) => {
    event.accept();  // Accept all channels (operator initiates)
});

await transport.start();

// Read C2C (console output from responder)
const c2c = transport.getChannel(c2cSymbol);
(async () => {
    while (true) {
        const msg = await c2c.read({ decode: true });
        if (!msg) break;
        await msg.process(() => {
            const level = c2cLevelMap[msg.messageType] ?? 'log';
            this.logger.asComponent(processId, () => this.logger.log(level, msg.text));
        });
    }
})();
```

**Responder side (in [`src/service-process.esm.js`](../src/service-process.esm.js)):**

```javascript
import { PipeTransport } from '@poly-transport/transport/pipe.esm.js';

const c2cSymbol = Symbol('c2c');
const transport = new PipeTransport({
    readable: Deno.stdin.readable,
    writable: Deno.stdout.writable,
    c2cSymbol,
});

transport.addEventListener('newChannel', (event) => {
    const { channelName } = event.detail;
    if (channelName === 'control' || channelName.startsWith('req-')) {
        event.accept();
    } else {
        event.reject();
    }
});

await transport.start();
```

The responder handles incoming messages on each `req-N` channel using **separate read loops** for metadata and relay traffic. Metadata messages (`req`, `res`, `res-error`, `con-*`) use default dechunking (full message reassembly). Relay messages (`res-frame`, `bidi-frame`) use `dechunk: false` to forward chunks verbatim without reassembly. Mixing them in a single loop would require the same dechunking mode for both, which is incorrect.

```javascript
// Responder: handle a req-N channel (called for each accepted channel)
// Three separate read loops are required:
//   Loop 1: 'req' (dechunked) — incoming request metadata
//   Loop 2: 'res-frame' (dechunk:false) — outgoing response body relay
//   Loop 3: 'bidi-frame' (dechunk:false) — bidi relay (bidi mode only)
async function handleReqChannel (reqChannel) {
    // Loop 1: 'req' messages (dechunked by default — full message reassembly)
    // 'req' payload is JSON text; decode via VirtualBuffer.decode()
    (async () => {
        while (true) {
            const msg = await reqChannel.read({ only: 'req' });
            if (!msg) break;
            await msg.process(async () => {
                await handleRequest(reqChannel, msg.data.decode());
            });
        }
    })();

    // Loop 2: 'res-frame' relay (dechunk: false — forward chunks verbatim)
    // res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
    // Chunks must not be reassembled before forwarding to the HTTP response stream.
    // (res and res-error are written by handleRequest above, not read here)
    // Note: this loop is only active after handleRequest() starts writing res-frame chunks.
    // In practice, the responder writes res-frame chunks from within handleRequest().

    // Loop 3: 'bidi-frame' relay (dechunk: false — forward chunks verbatim)
    // bidi-frame carries NestedTransport byte-stream traffic; chunks must not be
    // reassembled before forwarding to the applet's bidi channel.
    (async () => {
        while (true) {
            const msg = await reqChannel.read({ only: 'bidi-frame', dechunk: false });
            if (!msg) break;
            await msg.process(async () => {
                await handleBidiFrame(reqChannel, msg.data);
            });
        }
    })();
}
```

### 5.2 Responder ↔ Applet Worker: `PostMessageTransport` with Channel Layout

Replace the raw `postMessage` protocol in [`src/responder-process.esm.js`](../src/responder-process.esm.js) and [`src/applets/bootstrap.esm.js`](../src/applets/bootstrap.esm.js) with `PostMessageTransport`.

Each applet worker handles exactly one request (one-shot execution). The transport has the following channels:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `bootstrap` | bidirectional (responder → bootstrap primarily) | Private setup channel: applet path, mode, request data. Consumed by bootstrap; never exposed to applet. |
| `applet` | bidirectional | JSMAWS ↔ applet communication. Exposed as `globalThis.JSMAWS.server`. |
| `bidi` | bidirectional | NestedTransport relay (bidi requests only). Exposed as `globalThis.JSMAWS.bidi`. |
| C2C | applet → responder | Console output (automatic). |

The `bootstrap` channel carries setup instructions from the responder to the bootstrap module. The bootstrap reads from it, sets up the environment (including `globalThis.JSMAWS.bidi` for bidi requests), then dynamically imports and runs the applet. The `bootstrap` channel is not exposed to the applet. While PolyTransport channels are always bidirectional, there are currently no plans for the bootstrap to send anything back to the responder over this channel.

**Responder side (spawning the worker):**

```javascript
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';

const worker = new Worker(bootstrapURL.href, {
    type: 'module',
    deno: { permissions },
});

const c2cSymbol = Symbol('c2c');
const transport = new PostMessageTransport({
    gateway: worker,
    c2cSymbol,
    maxChunkBytes: this.chunkingConfig.chunkSize,
});

transport.addEventListener('newChannel', (event) => {
    event.accept();
});

await transport.start();

// Forward applet console output to operator via the corresponding req-N channel
// (not the C2C channel — this associates output with the request for logging and traffic control)
// C2C message types (trace/debug/info/warn/error) are forwarded with a 'con-' prefix
// to avoid collision with web-* types on the req-N channel.
// Console messages may have no data (e.g. console.log() with no args) — PolyTransport
// supports null/undefined data (dataSize = 0); forward as-is.
const appletC2c = transport.getChannel(c2cSymbol);
(async () => {
    while (true) {
        const msg = await appletC2c.read({ decode: true });
        if (!msg) break;
        await msg.process(() => {
            // Forward with 'con-' prefix: 'trace' → 'con-trace', etc.
            reqChannel.write(`con-${msg.messageType}`, msg.text ?? null);
        });
    }
})();

// Send setup instructions to bootstrap via the private 'bootstrap' channel
const bootstrapChannel = await transport.requestChannel('bootstrap');
await bootstrapChannel.addMessageTypes(['setup']);
await bootstrapChannel.write('setup', JSON.stringify({
    appletPath: requestData.appletPath,
    mode: requestData.mode,  // 'bidi' triggers globalThis.JSMAWS.bidi setup in bootstrap
    // ... other request metadata
}));

// For bidi requests: set up the bidi relay channel
let appletBidiChannel = null;
if (requestData.mode === 'bidi') {
    appletBidiChannel = await transport.requestChannel('bidi');
    await appletBidiChannel.addMessageTypes(['bidi-frame']);
    // Relay loops are started here (see Section 5.3 Responder side)
}

// Request the applet channel (for standard request/response and streaming)
const appletChannel = await transport.requestChannel('applet');
await appletChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

// Send request (for non-bidi mode)
if (requestData.mode !== 'bidi') {
    await appletChannel.write('req', serializeRequest(requestData));

    // Loop 1: response metadata (dechunked — each read() returns one complete message)
    // 'res' carries HTTP response status + headers (sent once, before any res-frame chunks)
    // 'res-error' carries error response (sent instead of res + res-frame)
    (async () => {
        while (true) {
            const msg = await appletChannel.read({ only: ['res', 'res-error'] });
            if (!msg) break;
            await msg.process(async () => {
                switch (msg.messageType) {
                case 'res':
                    // 'res': HTTP response status + headers
                    await handleAppletResponseMetadata(id, msg.data.decode());
                    break;
                case 'res-error':
                    await handleAppletError(id, msg.data);
                    break;
                }
            });
        }
    })();

    // Loop 2: response body chunks (dechunk: false — relay verbatim without reassembly)
    // res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
    // Using dechunk:false avoids unnecessary buffering and reduces latency.
    while (true) {
        const msg = await appletChannel.read({ only: 'res-frame', dechunk: false });
        if (!msg) break;
        let done = false;
        await msg.process(async () => {
            if (msg.data === undefined && msg.eom) {
                done = true; // zero-data + eom:true = end-of-stream signal
            } else {
                // Forward chunk to operator via req-N channel
                await reqChannel.write('res-frame', msg.data, { eom: msg.eom });
            }
        });
        if (done) {
            // Send end-of-stream signal to operator
            await reqChannel.write('res-frame', null);
            break;
        }
    }
}

// Stop transport (terminates worker)
await transport.stop({ discard: true });
worker.terminate();
```

**Applet side (bootstrap module):**

```javascript
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';

const c2cSymbol = Symbol('c2c');
const transport = new PostMessageTransport({
    gateway: self,
    c2cSymbol,
});

transport.addEventListener('newChannel', (event) => {
    event.accept();
});

await transport.start();

// Intercept console output → C2C channel
const c2c = transport.getChannel(c2cSymbol);
const originalConsole = {};
for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
        const text = args.map(String).join(' ');
        const c2cLevel = level === 'log' ? 'info' : level;
        c2c[c2cLevel]?.(text);
    };
}
Object.freeze(console);

// Read setup instructions from the private 'bootstrap' channel
const bootstrapChannel = await transport.requestChannel('bootstrap');
await bootstrapChannel.addMessageTypes(['setup']);
const setupMsg = await bootstrapChannel.read({ only: 'setup', decode: true });
let setupData;
await setupMsg.process(() => {
    setupData = JSON.parse(setupMsg.text);
});

// Set up JSMAWS communication channel
const appletChannel = await transport.requestChannel('applet');
await appletChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

// Build the JSMAWS namespace object (frozen before applet import)
const jsmawsNamespace = { server: appletChannel };

// For bidi requests: set up the NestedTransport relay channel
if (setupData.mode === 'bidi') {
    const bidiChannel = await transport.requestChannel('bidi');
    await bidiChannel.addMessageTypes(['bidi-frame']);
    jsmawsNamespace.bidi = bidiChannel;
}

// Expose frozen namespace to applet
globalThis.JSMAWS = Object.freeze(jsmawsNamespace);

// Dynamically import and run the applet
const { default: applet } = await import(setupData.appletPath);
await applet(setupData);

await transport.stop();
self.close();
```

**Console output routing:**

The C2C channel replaces the `{ type: 'console', level, content }` message hack entirely. The bootstrap module intercepts `console.*` calls and writes to the C2C channel on the `PostMessageTransport`.

Console output is then routed in two distinct paths:

- **Responder process console output** — written directly to the responder's own C2C channel on the `PipeTransport`. The operator reads from this C2C channel and logs via its logger (attributed to the responder process).
- **Applet console output** — the responder reads from the applet's C2C channel (which uses the bare C2C names `trace`, `debug`, `info`, `warn`, `error`) and forwards to the operator via the **corresponding `req-N` channel** using `con-`-prefixed message types (`con-trace`, `con-debug`, `con-info`, `con-warn`, `con-error`). The `con-` prefix is required to avoid collision with the C2C channel's native bare names and with `res-error` on the same channel. The operator reads these from the `req-N` channel and logs them attributed to the specific request/applet. This ensures applet console traffic competes against its own request traffic (not the responder's console traffic) and allows the operator to associate output with the correct request context.

This eliminates the `APLOUT` message type, the `encodeLogLevel`/`parseLogMessage` hacks, and the `handleAppletConsoleOutput` method entirely.

### 5.3 Operator ↔ Client Bidi: `WebSocketTransport` + `NestedTransport` (relay)

Replace the hand-rolled credit-based flow control in [`src/operator-request-state.esm.js`](../src/operator-request-state.esm.js) with `WebSocketTransport` for the client-facing connection. The operator and responder act as **transparent relays** for the nested transport's byte stream — they never instantiate `NestedTransport`. The `NestedTransport` endpoints live only in the **client** and the **applet**.

**Current approach:** The operator manually tracks `outboundCredits`, `inboundCredits`, `maxCredits`, `maxChunkSize`, etc. and implements credit consumption/restoration logic.

**Proposed approach:** The client establishes a `WebSocketTransport` to the operator and opens a single pre-designated channel (e.g., `bidi`). On that channel, the client uses the pre-designated `bidi-frame` message type to carry `NestedTransport` traffic. The operator forwards those messages verbatim to the responder via the `bidi-frame` message type on the `req-N` channel. The responder forwards them to the applet via the applet's `PostMessageTransport` `bidi` channel using the same `bidi-frame` message type. The `bidi-frame` message type name is used consistently across all three transport legs — it describes the same semantic content (a chunk of nested transport data) regardless of which transport leg it's on. The applet instantiates a `NestedTransport` over the received byte stream and communicates directly with the client. Whatever channels the client and applet negotiate on the `NestedTransport` are completely opaque to JSMAWS.

**Architecture:**
```
Client (WebSocketTransport + NestedTransport endpoint)
    ↓ WebSocket — 'bidi' channel, 'bidi-frame' message type
Operator (transparent relay: WS 'bidi'/'bidi-frame' ↔ req-N 'bidi-frame')
    ↓ PipeTransport req-N channel — 'bidi-frame' message type
Responder (transparent relay: req-N 'bidi-frame' ↔ applet 'bidi'/'bidi-frame')
    ↓ PostMessageTransport — 'bidi' channel, 'bidi-frame' message type
Applet (NestedTransport endpoint — negotiates channels with client)
```

**Operator side (in [`src/operator-request-state.esm.js`](../src/operator-request-state.esm.js)):**

```javascript
import { WebSocketTransport } from '@poly-transport/transport/websocket.esm.js';

// In handleFirstFrame() when mode === 'bidi' and status === 101:
const { socket, response } = Deno.upgradeWebSocket(originalRequest);

// Create WebSocketTransport for client connection
const wsTransport = new WebSocketTransport({
    ws: socket,
    maxChunkBytes: bidiParams.maxChunkSize,
    lowBufferBytes: bidiParams.maxChunkSize,
    c2cSymbol: null,  // No C2C needed for client-facing transport
});

// Only accept the single pre-designated 'bidi' channel
wsTransport.addEventListener('newChannel', (event) => {
    if (event.detail.channelName === 'bidi') {
        event.accept();
    } else {
        event.reject();
    }
});

await wsTransport.start();

// Get the pre-designated bidi channel and register the bidi-frame message type
const bidiChannel = await wsTransport.requestChannel('bidi');
await bidiChannel.addMessageTypes(['bidi-frame']);

// Relay: forward 'bidi-frame' from WS bidi channel → req-N 'bidi-frame'
// dechunk: false is required — bidi-frame carries NestedTransport byte-stream
// chunks that must be forwarded verbatim without reassembly.
// eom: false on write — NestedTransport chunks are not application messages;
// each chunk is forwarded as a single-chunk "message" with no EOM semantics.
(async () => {
    while (true) {
        const msg = await bidiChannel.read({ only: 'bidi-frame', dechunk: false });
        if (!msg) break;
        await msg.process(async () => {
            await context.reqChannel.write('bidi-frame', msg.data, { eom: false });
        });
    }
})();

// Relay: forward 'bidi-frame' from req-N → WS bidi channel
// (handled in the dedicated bidi-frame read loop on the req-N channel — see Section 5.1)

// Store transport in context
context.wsTransport = wsTransport;
context.bidiChannel = bidiChannel;

// Handle transport stop (WebSocket close)
wsTransport.addEventListener('stopped', async () => {
    context.state = RequestState.COMPLETED;
    await context.poolManager.decrementItemUsage(context.poolItemId);
    operator.cleanupRequestContext(requestId);
});
```

**Responder side (in [`src/responder-process.esm.js`](../src/responder-process.esm.js)):**

```javascript
// When receiving a bidi request, relay 'bidi-frame' messages from req-N
// to the applet's PostMessageTransport 'bidi' channel, and vice versa.
// No NestedTransport instantiation — the responder is a transparent relay.
//
// Both relay loops use dechunk: false — bidi-frame carries NestedTransport
// byte-stream chunks that must be forwarded verbatim without reassembly.
// eom: false on write — NestedTransport chunks are not application messages;
// each chunk is forwarded as a single-chunk "message" with no EOM semantics.
// These loops run concurrently with the 'req' loop in handleReqChannel()
// (see Section 5.1); they are separate because bidi-frame requires dechunk: false
// while 'req' uses the default dechunking (full message reassembly).

// Relay: forward 'bidi-frame' from req-N → applet 'bidi' channel
(async () => {
    while (true) {
        const msg = await reqChannel.read({ only: 'bidi-frame', dechunk: false });
        if (!msg) break;
        await msg.process(async () => {
            await appletBidiChannel.write('bidi-frame', msg.data, { eom: false });
        });
    }
})();

// Relay: forward 'bidi-frame' from applet 'bidi' channel → req-N
(async () => {
    while (true) {
        const msg = await appletBidiChannel.read({ only: 'bidi-frame', dechunk: false });
        if (!msg) break;
        await msg.process(async () => {
            await reqChannel.write('bidi-frame', msg.data, { eom: false });
        });
    }
})();
```

**Applet side (bootstrap module):**

```javascript
// Bootstrap exposes channels to the applet via globalThis.JSMAWS (frozen namespace object).
// JSMAWS.server is the main JSMAWS communication channel.
// JSMAWS.bidi (bidi requests only) is the NestedTransport relay channel.
// The applet instantiates NestedTransport over JSMAWS.bidi to communicate with the client.
// The applet and client negotiate their own channels on the NestedTransport — JSMAWS is opaque to this.

import { NestedTransport } from '@poly-transport/transport/nested.esm.js';

// Exposed by bootstrap (frozen before applet import):
// globalThis.JSMAWS.server = appletChannel    (the JSMAWS communication channel)
// globalThis.JSMAWS.bidi   = bidiChannel      (bidi requests only; PostMessageTransport channel with 'bidi-frame' message type)

// Applet code (example):
const nestedTransport = new NestedTransport({
    channel: globalThis.JSMAWS.bidi,
    messageType: 'bidi-frame',
});
await nestedTransport.start();

// Now negotiate channels with the client as desired — completely opaque to JSMAWS
const myChannel = await nestedTransport.requestChannel('app');
await myChannel.addMessageTypes(['data', 'ack']);
```

**Client requirements:**

Clients must use the PolyTransport library for bidirectional connections:

```javascript
import { WebSocketTransport } from '@poly-transport/transport/websocket.esm.js';
import { NestedTransport } from '@poly-transport/transport/nested.esm.js';

const ws = new WebSocket('wss://example.com/api/bidi');
const wsTransport = new WebSocketTransport({ ws });

wsTransport.addEventListener('newChannel', (event) => {
    event.accept();
});

await wsTransport.start();

// Open the pre-designated 'bidi' channel
const bidiChannel = await wsTransport.requestChannel('bidi');
await bidiChannel.addMessageTypes(['bidi-frame']);

// Establish NestedTransport over the bidi channel
const nestedTransport = new NestedTransport({
    channel: bidiChannel,
    messageType: 'bidi-frame',
});
await nestedTransport.start();

// Negotiate channels with the applet — completely opaque to JSMAWS
const myChannel = await nestedTransport.requestChannel('app');
await myChannel.addMessageTypes(['data', 'ack']);

// Communicate with the applet
await myChannel.write('data', JSON.stringify({ hello: 'world' }));
```

**Key benefits:**
- End-to-end flow control from client to applet (no manual credit tracking)
- Automatic backpressure propagation through all layers
- PolyTransport's sliding-window flow control prevents flooding at any layer
- Operator and responder are simple, stateless byte relays — no bidi protocol knowledge required
- Client and applet can negotiate any channels they desire on the `NestedTransport` — JSMAWS is completely opaque to this
- Aligns with JSMAWS security/isolation/fault-resistance requirements

---

## 6. Architecture After Refactoring

### 6.1 Communication Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    Operator Process (privileged)                │
│                                                                 │
│  HTTP/HTTPS Server ──► Router ──► RequestManager                │
│                                        │                        │
│                              ┌─────────▼──────────┐             │
│                              │   ServerRequest    │             │
│                              │  (owns lifecycle)  │             │
│                              └─────────┬──────────┘             │
│                                        │                        │
│                    PipeTransport (one per responder process)    │
│                    ┌───────────────────▼──────────────────┐     │
│                    │  'control' channel (bidirectional)   │     │
│                    │  'req-0' ... 'req-N' channels (pool) │     │
│                    │    req/res/res-frame/res-error +     │     │
│                    │    con-* (applet console output)     │     │
│                    │  C2C channel (responder console out) │     │
│                    └──────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                               │ stdin/stdout (piped)
┌──────────────────────────────▼──────────────────────────────────┐
│                    Responder Process (unprivileged)             │
│                                                                 │
│  PipeTransport (to operator)                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  'control' channel ◄── config-update/health-check/       │   │
│  │    shutdown/scale-down/capacity-update                   │   │
│  │  'req-0' ... 'req-N' channels ◄── req / ──► res/res-frame│   │
│  │    + con-* (applet console output forwarded via req-N)   │   │
│  │  C2C channel ──► responder process console output        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  PostMessageTransport (one per applet worker, one-shot)         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  'bootstrap' channel ──► setup (private, not in applet)  │   │
│  │  'applet' channel ──► req / ◄── res/res-frame/res-error  │   │
│  │  'bidi' channel ◄──► bidi-frame relay (bidi mode only)   │   │
│  │  C2C channel ◄── applet console output                   │   │
│  │    (forwarded by responder to req-N channel, not C2C)    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │ postMessage
┌──────────────────────────────▼──────────────────────────────────┐
│                    Applet Worker (sandboxed)                    │
│                                                                 │
│  PostMessageTransport (to responder)                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  'bootstrap' channel ◄── setup (consumed by bootstrap)   │   │
│  │  'applet' channel ◄── req / ──► res/res-frame/res-error  │   │
│  │    exposed as globalThis.JSMAWS.server                   │   │
│  │  'bidi' channel ◄──► bidi-frame relay (bidi mode only)   │   │
│  │    exposed as globalThis.JSMAWS.bidi                     │   │
│  │  C2C channel ──► console output (intercepted)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

For bidi (WebSocket) requests with NestedTransport:

┌─────────────────────────────────────────────────────────────────┐
│          Client (WebSocketTransport + NestedTransport)          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  WebSocketTransport ──► 'bidi' channel, 'bidi-frame'     │   │
│  │  NestedTransport endpoint (negotiates channels w/ applet)│   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │ WebSocket — 'bidi' channel, 'bidi-frame' msg type
┌──────────────────────────────▼──────────────────────────────────┐
│                    Operator Process (transparent relay)         │
│                                                                 │
│  WebSocketTransport (client-facing)                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Accepts only pre-designated 'bidi' channel              │   │
│  │  Forwards 'bidi-frame' ↔ req-N 'bidi-frame'              │   │
│  │  No NestedTransport instantiation                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │ PipeTransport req-N channel — 'bidi-frame' msg type
┌──────────────────────────────▼──────────────────────────────────┐
│                    Responder Process (transparent relay)        │
│                                                                 │
│  PipeTransport (to operator)                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Forwards req-N 'bidi-frame' ↔ applet 'bidi'/'bidi-frame'│   │
│  │  No NestedTransport instantiation                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                               │                                 │
│  PostMessageTransport (to applet)                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  'bidi' channel, 'bidi-frame' msg type                   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │ postMessage — 'bidi' channel, 'bidi-frame' msg type
┌──────────────────────────────▼──────────────────────────────────┐
│              Applet Worker (NestedTransport endpoint)           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  PostMessageTransport 'bidi' channel exposed via         │   │
│  │  globalThis.JSMAWS.bidi (in globalThis.JSMAWS namespace) │   │
│  │  NestedTransport endpoint (negotiates channels w/ client)│   │
│  │  Client/applet channel negotiation opaque to JSMAWS      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

Note: NestedTransport endpoints exist only in the client and the applet.
The operator and responder are transparent byte relays for 'bidi-frame'
messages. The client and applet negotiate their own channels on the
NestedTransport — this is completely opaque to JSMAWS.
```

### 6.2 Files Affected

| File | Change |
|------|--------|
| [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js) | **Delete** — replaced by PolyTransport channels and message types |
| [`src/serializer.esm.js`](../src/serializer.esm.js) | **Delete** — PolyTransport handles write serialization internally |
| [`src/console-intercept.esm.js`](../src/console-intercept.esm.js) | **Repurpose** — intercept console and write to C2C channel instead of encoding SOH prefixes |
| [`src/service-process.esm.js`](../src/service-process.esm.js) | **Rewrite** — replace `createIPCConnection()` with `PipeTransport` setup; replace `startMonitoring()` with channel read loops |
| [`src/process-manager.esm.js`](../src/process-manager.esm.js) | **Rewrite** — replace `IPCConnection` with `PipeTransport`; replace `sendConfigUpdate()` etc. with channel writes; manage request channel pool |
| [`src/responder-process.esm.js`](../src/responder-process.esm.js) | **Rewrite** — replace `postMessage` protocol with `PostMessageTransport`; remove bidi flow control (handled by PolyTransport) |
| [`src/applets/bootstrap.esm.js`](../src/applets/bootstrap.esm.js) | **Rewrite** — replace raw `postMessage` with `PostMessageTransport`; use C2C for console output |
| [`src/operator-request-state.esm.js`](../src/operator-request-state.esm.js) | **Rewrite** — replace hand-rolled bidi flow control with `WebSocketTransport` |
| [`src/operator-process.esm.js`](../src/operator-process.esm.js) | **Update** — update `forwardToServiceProcess()` and `handleClientBidiMessage()` to use PolyTransport channels |

### 6.3 Files Unchanged or Minimally Changed

| File | Change |
|------|--------|
| [`src/configuration.esm.js`](../src/configuration.esm.js) | No change — configuration logic is independent |
| [`src/router-worker.esm.js`](../src/router-worker.esm.js) | No change — routing logic is independent |
| [`src/pool-manager.esm.js`](../src/pool-manager.esm.js) | Minor — update process factory interface |
| [`src/ssl-manager.esm.js`](../src/ssl-manager.esm.js) | No change |
| [`src/config-monitor.esm.js`](../src/config-monitor.esm.js) | No change |
| [`src/logger.esm.js`](../src/logger.esm.js) | No change |
| [`src/applets/static-content.esm.js`](../src/applets/static-content.esm.js) | Update to use PolyTransport channel API instead of raw `postMessage` |

---

## 7. Detailed Design Decisions

### 7.1 Request Channel Pool: Lazy Growth Strategy

Pre-creating all `maxWorkers` channels at transport startup would require `maxWorkers` round-trips on the TCC before the responder can serve any requests. Even if pipelined with `Promise.all()`, this adds startup latency proportional to `maxWorkers`.

**Recommended approach: lazy growth, mirroring pool scaling**

The channel pool starts with `minWorkers` channels (matching the pool's minimum process count) and grows on demand up to `maxWorkers`. This amortizes the channel creation cost across the first few requests rather than concentrating it at startup.

```javascript
class RequestChannelPool {
    #available = [];
    #channelIndex = new Map(); // channel.name → numeric index (for attrition check)
    #inUse = new Set();
    #maxSize;
    #nextIndex = 0;
    #pendingCreations = 0;
    #transport;
    #waiters = [];

    constructor (transport, initialSize, maxSize) {
        this.#transport = transport;
        this.#maxSize = maxSize;
        // Pre-create initial channels (pipelined — all requests sent before awaiting)
        const initialPromises = Array.from({ length: initialSize }, () => this.#createChannel());
        Promise.all(initialPromises); // Fire and forget; channels added to pool as they resolve
    }

    async acquire () {
        if (this.#available.length > 0) {
            const channel = this.#available.pop();
            this.#inUse.add(channel);
            return channel;
        }
        // Grow the pool if below max (fire and forget; waiter will be woken when ready)
        if (this.totalSize < this.#maxSize) {
            this.#pendingCreations++;
            this.#createChannel().finally(() => this.#pendingCreations--);
        }
        // Wait for a channel to become available
        return new Promise((resolve) => {
            this.#waiters.push(resolve);
        });
    }

    async #createChannel () {
        const index = this.#nextIndex++;
        const name = `req-${index}`;
        const channel = await this.#transport.requestChannel(name);
        await channel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);
        this.#channelIndex.set(name, index);
        // Add to available pool and wake a waiter if any are waiting
        this.#available.push(channel);
        this.#wakeWaiter();
        return channel;
    }

    async release (channel) {
        this.#inUse.delete(channel);
        // Always close the channel between requests to eliminate state carry-over.
        await channel.close();
        const index = this.#channelIndex.get(channel.name);
        // Pool attrition on down-sizing: if this channel's index is beyond the
        // current pool size, remove its map entry and do not reopen it.
        if (index >= this.#maxSize) {
            this.#channelIndex.delete(channel.name);
            return;
        }
        // Reopen the channel immediately so it is ready for the next request.
        await this.#reopenChannel(index, channel.name);
    }

    async #reopenChannel (index, name) {
        const channel = await this.#transport.requestChannel(name);
        await channel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);
        // #channelIndex entry is retained (same name → same index); no update needed
        this.#available.push(channel);
        this.#wakeWaiter();
    }

    resize (newMaxSize) {
        this.#maxSize = newMaxSize;
        // Prune already-available channels that are now beyond the new pool range.
        // In-flight channels beyond the range will be discarded when released (see release()).
        this.#available = this.#available.filter((channel) => {
            const index = this.#channelIndex.get(channel.name);
            if (index >= this.#maxSize) {
                this.#channelIndex.delete(channel.name);
                channel.close(); // Discard — beyond new pool range
                return false;
            }
            return true;
        });
        // Wake any waiters that may now be satisfiable with the pruned pool.
        this.#wakeWaiter();
    }

    get totalSize () {
        return this.#inUse.size + this.#available.length + this.#pendingCreations;
    }

    #wakeWaiter () {
        if (this.#waiters.length > 0 && this.#available.length > 0) {
            const waiter = this.#waiters.shift();
            const channel = this.#available.pop();
            this.#inUse.add(channel);
            waiter(channel);
        }
    }
}
```

**Initial pool size:** `minWorkers` (from pool configuration). This matches the minimum number of concurrent requests the responder is expected to handle without scaling. The initial channels are created in parallel (pipelined TCC requests), so startup cost is one round-trip latency regardless of `minWorkers`.

**Maximum pool size:** `maxWorkers` (from pool configuration). The pool never exceeds this size.

**Growth trigger:** When `acquire()` is called and no channel is available, a new channel is created (if below max). The caller waits until the new channel is ready. This means the first request that exceeds the current pool size will experience one extra round-trip latency for channel creation.

**Pool reconfiguration:** When `maxWorkers` changes (via config update), call `pool.resize(newMaxSize)`. This immediately closes and discards any already-available channels beyond the new range. In-flight channels beyond the new range are discarded (not reopened) when they are released — this is the pool attrition path in `release()`. If the new `minWorkers` is larger, additional channels are pre-created in parallel via `#createChannel()`.

### 7.2 Configuration Updates

Config updates are sent from operator to all responders via the `control` channel:

```javascript
// Operator sends config update
const configJson = JSON.stringify(createConfigUpdate(config));
await controlChannel.write('config-update', configJson);
```

```javascript
// Responder receives config update
const msg = await controlChannel.read({ only: 'config-update', decode: true });
await msg.process(async () => {
    const config = JSON.parse(msg.text);
    await this.handleConfigUpdate(config);
});
```

### 7.3 Health Checks and Capacity Reporting

Health checks use the `control` channel with a request/response pattern. Capacity updates are sent proactively after each request completes:

```javascript
// Responder sends capacity update after each request
await controlChannel.write('capacity-update', JSON.stringify({
    availableWorkers: this.bpAvailWorkers(),
    totalWorkers: this.maxConcurrentRequests,
}));
```

The operator reads `capacity-update` and `health-response` messages from the `control` channel. Since the `control` channel carries only text messages (SLID/JSON), `{ decode: true }` is used on all reads:

```javascript
// Operator reads from control channel (all messages are text)
while (true) {
    const msg = await controlChannel.read({
        only: ['capacity-update', 'health-response'],
        decode: true,
    });
    if (!msg) break;
    await msg.process(() => {
        switch (msg.messageType) {
        case 'capacity-update':
        {
            const { availableWorkers, totalWorkers } = JSON.parse(msg.text);
            this.updateCapacity(availableWorkers, totalWorkers);
            break;
        }
        case 'health-response':
            this.resolveHealthCheck(msg.text);
            break;
        }
    });
}
```

This decouples capacity reporting from response frames (eliminating the current side-channel piggybacking).

### 7.4 Shutdown Protocol

**Current approach:** The operator sends a `HALT` message; the responder drains active requests and calls `Deno.exit(0)`.

**Proposed approach:** The operator sends a `shutdown` message on the `control` channel, then calls `transport.stop()`. PolyTransport's graceful stop protocol:
1. Sends a stop signal to the remote
2. Waits for all in-flight channel data to be acknowledged
3. Closes all channels
4. Resolves when both sides have stopped

For forced shutdown: `transport.stop({ discard: true })` skips waiting for in-flight data.

### 7.5 Bidi Flow Control Parameters

**Current approach:** `getBidiParams()` derives flow control parameters from configuration. Both operator and responder independently derive the same parameters.

**Proposed approach:** PolyTransport's flow control parameters are set at channel creation time via `requestChannel(name, { maxBufferBytes, maxChunkBytes, lowBufferBytes })`. The operator sets these when creating the `WebSocketTransport` channel. The `getBidiParams()` method in [`src/configuration.esm.js`](../src/configuration.esm.js) is still used to derive the values, but they are passed to PolyTransport rather than manually tracked.

### 7.6 Applet Protocol Compatibility

Existing applets currently use raw `postMessage` with the current frame protocol.

These applets (e.g. `static-content.esm.js`) will be refactored to use PolyTransport directly.

---

## 8. Impact on Existing Tests

### 8.1 Unit Tests to Delete

| Test File | Reason |
|-----------|--------|
| [`test/ipc-protocol.test.js`](../test/ipc-protocol.test.js) | Tests `IPCConnection` which is deleted |
| [`test/ipc-unified-buffering.test.js`](../test/ipc-unified-buffering.test.js) | Tests IPC buffering which is replaced |
| [`test/event-driven-ipc.test.js`](../test/event-driven-ipc.test.js) | Tests IPC event handling which is replaced |
| [`test/frame-protocol.test.js`](../test/frame-protocol.test.js) | Tests frame encoding which is replaced |

### 8.2 Unit Tests to Rewrite

| Test File | Change |
|-----------|--------|
| [`test/service-process.test.js`](../test/service-process.test.js) | Update to use `PipeTransport` mock |
| [`test/responder-process.test.js`](../test/responder-process.test.js) | Update to use `PostMessageTransport` mock |
| [`test/request-state-machine.test.js`](../test/request-state-machine.test.js) | Update bidi tests to use `WebSocketTransport` |
| [`test/applet-bootstrap.test.js`](../test/applet-bootstrap.test.js) | Update to use `PostMessageTransport` |
| [`test/applet-console-output.test.js`](../test/applet-console-output.test.js) | Update to use C2C channel (applet → responder) and req-N channel message types (responder → operator) |

### 8.3 Unit Tests Unchanged

| Test File | Reason |
|-----------|--------|
| [`test/router-worker.test.js`](../test/router-worker.test.js) | Router logic is independent |
| [`test/pool-manager.test.js`](../test/pool-manager.test.js) | Pool logic is independent |
| [`test/config-monitor.test.js`](../test/config-monitor.test.js) | Config monitoring is independent |
| [`test/timeout-config.test.js`](../test/timeout-config.test.js) | Timeout config is independent |
| [`test/bidi-params-config.test.js`](../test/bidi-params-config.test.js) | Bidi params config is independent |
| [`test/cli-args.test.js`](../test/cli-args.test.js) | CLI args are independent |
| [`test/logger.test.js`](../test/logger.test.js) | Logger is independent |
| [`test/ssl-manager.test.js`](../test/ssl-manager.test.js) | SSL manager is independent |

### 8.4 E2E Tests

The E2E tests in [`test-e2e/`](../test-e2e/) test the server from the outside (HTTP/WebSocket clients). They should continue to pass after the refactoring since the external HTTP/WebSocket API is unchanged. Minor updates may be needed if test utilities directly reference IPC internals.

---

## 9. Implementation Plan

This refactoring aligns with the clean-slate rewrite strategy approved in [`arch/refactoring-assessment-2025-12-10.md`](refactoring-assessment-2025-12-10.md). The PolyTransport adoption can be integrated into that plan as follows:

### Phase 1: PolyTransport Integration Infrastructure

1. **Update `deno.json`** — add PolyTransport and its dependencies to the import map (jsdelivr CDN)
2. **Create `src/request-channel-pool.esm.js`** — `RequestChannelPool` class for managing the pool of request channels with immediate reopening
3. **Unit tests** for channel pool infrastructure

### Phase 2: Responder ↔ Applet (PostMessageTransport)

1. **Rewrite `src/applets/bootstrap.esm.js`** — use `PostMessageTransport`; expose channels via `globalThis.JSMAWS` (frozen namespace: `.server` for the applet channel, `.bidi` for bidi requests); use C2C for console output
2. **Rewrite applet communication in `src/responder-process.esm.js`** — use `PostMessageTransport` channels instead of raw `postMessage`
3. **Update `src/applets/static-content.esm.js`** — use PolyTransport channel API (no backward compatibility)
4. **Update unit tests** for bootstrap and responder
5. **Update example applets** in `examples/applets/` to use PolyTransport protocol

### Phase 3: Operator ↔ Responder (PipeTransport)

1. **Rewrite `src/service-process.esm.js`** — use `PipeTransport` instead of `IPCConnection`
2. **Rewrite `src/process-manager.esm.js`** — use `PipeTransport` for process communication; manage request channel pool with immediate reopening
3. **Update `src/router-process.esm.js`** — use `PipeTransport` (same pattern as responder)
4. **Delete `src/ipc-protocol.esm.js`** and `src/serializer.esm.js`
5. **Delete `src/console-intercept.esm.js`** — replaced by C2C channel
6. **Update `src/operator-process.esm.js`** — update process communication calls
7. **Update unit tests** for service process and process manager

### Phase 4: Operator ↔ Client Bidi (WebSocketTransport + NestedTransport relay)

1. **Rewrite `src/operator-request-state.esm.js`** — use `WebSocketTransport`; accept only pre-designated `bidi` channel; relay `bidi-frame` messages between WS `bidi` channel and `req-N` channel
2. **Update `src/responder-process.esm.js`** — relay `bidi-frame` messages between `req-N` channel and applet `PostMessageTransport` `bidi` channel (no `NestedTransport` instantiation)
3. **Update `src/applets/bootstrap.esm.js`** — expose `bidi` channel via `globalThis.JSMAWS.bidi` (in the `JSMAWS` namespace alongside `.server`) for applets that use `NestedTransport`
4. **Remove manual credit tracking** from operator and responder (replaced by PolyTransport flow control)
5. **Create client-side PolyTransport integration guide** — document how clients use `WebSocketTransport` + `NestedTransport` for bidi connections
6. **Update unit tests** for request state machine and bidi flow control

### Phase 5: Integration and E2E Testing

1. **Update E2E tests** — modify WebSocket tests to use PolyTransport client library
2. **Run all E2E tests** — verify external behavior with NestedTransport
3. **Performance testing** — compare throughput and latency
4. **Resource leak testing** — verify no leaks under load (especially channel pool behavior with immediate reopening)
5. **Flow control testing** — verify end-to-end backpressure from applet to client

---

## 10. Benefits Summary

| Concern | Current | After Refactoring |
|---------|---------|-------------------|
| IPC protocol code | ~774 lines (custom SLID-over-pipe) | ~50 lines (PolyTransport setup) |
| Applet communication code | ~300 lines (raw postMessage) | ~50 lines (PolyTransport setup) |
| Bidi flow control code | ~400 lines (manual credit tracking) | ~20 lines (PolyTransport channels) |
| Console output multiplexing | SOH prefix hack + `parseLogMessage` | C2C channel for responder output; `con-*` message types on req-N channel for applet output (request-associated, collision-free) |
| Write serialization | Custom `Serializer` class | Built-in to PolyTransport |
| Backpressure | Inferred from write timing | Automatic sliding-window |
| Request isolation | Manual `requestHandlers` map | Per-request channel (from pool) |
| Transport extensibility | WebSocket only | WebSocket + Pipe + PostMessage + Nested |
| Test coverage | Custom protocol tests needed | PolyTransport has 761 tests |
| Resource management | Manual cleanup in 15+ locations | PolyTransport channel lifecycle |

---

## 11. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PolyTransport API changes (CDN version) | Low | High | Pin to specific version (`@0.0.2`); update on a schedule; use import map versioning |
| Performance regression from PolyTransport overhead | Medium | Medium | Benchmark before/after; PolyTransport uses zero-copy ring buffer |
| Channel pool exhaustion under high load | Medium | Medium | Pool size = `maxWorkers`; operator returns 503 when pool exhausted (same as current behavior) |
| Pool reconfiguration with immediate reopening | Medium | Medium | Implement careful resize logic with immediate reopening; test thoroughly |
| PolyTransport `stop()` semantics differ from current shutdown | Medium | Medium | Test shutdown behavior carefully; use `discard: true` for forced shutdown |
| NestedTransport complexity | Medium | High | PolyTransport provides NestedTransport implementation; follow documented patterns; test end-to-end flow control |
| Client-side PolyTransport requirement for bidi | High | Medium | Document client integration clearly; provide example client code; no backward compatibility needed (zero production deployments) |
| C2C channel not available in all transport types | Low | Low | C2C is supported in all PolyTransport transports |

---

## 12. Resolved Design Decisions

### 12.1 Import Map Strategy

**Decision:** Use jsdelivr CDN for PolyTransport and its dependencies.

**Import map configuration:**
```json
{
    "imports": {
        "@eventable": "https://cdn.jsdelivr.net/gh/mesgjs/eventable@main/src/eventable.esm.js",
        "@task-queue": "https://cdn.jsdelivr.net/gh/mesgjs/task-queue@0.1.1/src/task-queue.esm.js",
        "@updatable-event": "https://cdn.jsdelivr.net/gh/mesgjs/updatable-event@main/src/updatable-event.esm.js",
        "@poly-transport/": "https://cdn.jsdelivr.net/gh/mesgjs/poly-transport@0.0.2/src/"
    }
}
```

**Rationale:**
- jsdelivr provides reliable CDN hosting with version pinning
- Consistent with other Mesgjs dependencies already using jsdelivr
- No local development symlinks needed — all imports use CDN
- Version pinning (`@0.0.2`) ensures stability

### 12.2 Pool Reconfiguration Approach

**Decision:** Implement dynamic pool resizing with immediate channel reopening. All close/reopen and attrition logic is encapsulated in `RequestChannelPool`.

**Implementation:**
- `release(channel)` (async) always closes the channel after each request to eliminate state carry-over
- If the channel's index is within the current pool range, it is immediately reopened via `#reopenChannel()` and returned to the available pool
- If the channel's index is beyond the current pool range (pool attrition on down-sizing), its `#channelIndex` map entry is deleted and the channel is not reopened — this is the natural drain path for excess channels
- `resize(newMaxSize)` immediately closes and discards already-available channels beyond the new range; in-flight channels beyond the range drain away via the attrition path in `release()`
- `#channelIndex` (`Map<channel.name, index>`) tracks the numeric index for each channel name, enabling the attrition check without tagging the channel object itself

**Rationale:**
- Eliminates state carry-over between requests (channel always closed and freshly reopened)
- Immediate reopening maintains pool availability with minimal latency
- Attrition is lazy for in-flight channels (no disruption to active requests) and eager for idle channels (via `resize()`)
- `Map<name, index>` avoids external properties on channel objects, allowing closed channels to be GC'd
- PolyTransport's channel nulling/reuse mechanism handles channel lifecycle on the transport side

### 12.3 SLID vs JSON for Message Payloads

**Decision:** Use JSON for all internal IPC communications; reserve SLID for user-facing configuration only.

**Payload format by context:**
- **User-facing configuration files:** SLID (parsed by Configuration class)
- **Operator ↔ Responder IPC:** JSON (control messages, config updates, capacity reports)
- **Responder ↔ Applet:** JSON (request metadata, response frames)
- **Operator ↔ Client:** Binary/JSON (WebSocket frames, HTTP responses)

**Rationale:**
- SLID's primary benefit is user-facing syntax (compact, less rigid, better for hand-written config)
- JSON is standard for machine-to-machine communication (better tooling, debugging, ecosystem support)
- Performance difference is negligible (both are text-based; parsing overhead is minimal)
- JavaScript applets work natively with JSON; SLID conversion adds friction
- The Configuration class already parses SLID and can expose JSON-serializable objects for IPC

### 12.4 Applet Protocol Stabilization

**Decision:** Define a PolyTransport-based applet protocol with no backward compatibility.

**Protocol specification:**
- `bootstrap` channel (private): carries setup instructions from responder to bootstrap; consumed by bootstrap, never exposed to applet
- `applet` channel exposed via `globalThis.JSMAWS.server` (a PolyTransport Channel instance): JSMAWS ↔ applet communication
- `bidi` channel exposed via `globalThis.JSMAWS.bidi` (bidi requests only): NestedTransport relay between client and applet
- C2C channel for console output (automatic via bootstrap)
- `globalThis.JSMAWS` is a frozen namespace object built by bootstrap before applet import; contains `.server` always and `.bidi` for bidi requests
- All applets must use PolyTransport protocol

**Bootstrap module:**
```javascript
// Bootstrap reads setup from private 'bootstrap' channel, then exposes channels to applet
const transport = new PostMessageTransport({ gateway: self, c2cSymbol: Symbol('c2c') });
await transport.start();

// Private setup channel (not exposed to applet)
const bootstrapChannel = await transport.requestChannel('bootstrap');
await bootstrapChannel.addMessageTypes(['setup']);
const setupMsg = await bootstrapChannel.read({ only: 'setup', decode: true });
let setupData;
await setupMsg.process(() => { setupData = JSON.parse(setupMsg.text); });

// JSMAWS communication channel
const appletChannel = await transport.requestChannel('applet');
await appletChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

// Build JSMAWS namespace (frozen before applet import)
const jsmawsNamespace = { server: appletChannel };

// Bidi relay channel (bidi requests only)
if (setupData.mode === 'bidi') {
    const bidiChannel = await transport.requestChannel('bidi');
    await bidiChannel.addMessageTypes(['bidi-frame']);
    jsmawsNamespace.bidi = bidiChannel;
}

// Expose frozen namespace to applet
globalThis.JSMAWS = Object.freeze(jsmawsNamespace);
```

**Rationale:**
- Zero production deployments — no backward compatibility needed
- Clean break enables optimal design
- PolyTransport provides flow control, chunking, and extensibility
- `bootstrap` channel provides a clean, typed setup mechanism (replaces the one-time `postMessage` hack)
- `globalThis.JSMAWS` is a frozen namespace object; `.server` is the JSMAWS communication channel; `.bidi` (bidi requests only) is the NestedTransport relay — grouping them under `JSMAWS` avoids global namespace pollution while keeping them clearly associated with the server framework
- Aligns with Mesgjs message-passing paradigm
- Eliminates complexity of supporting multiple protocol versions

### 12.5 Router Process Update

**Decision:** Update `src/router-process.esm.js` to use `PipeTransport` in Phase 3 (same pattern as responder).

**Implementation:**
- Router process uses the same IPC protocol as the responder
- Update in Phase 3 alongside responder process refactoring
- No special handling required

**Rationale:**
- Router process is a service process with identical IPC requirements
- Consistent implementation across all service processes

### 12.6 Bidi Relay Architecture

**Decision:** Use `WebSocketTransport` for the client-facing connection. The operator and responder are **transparent byte relays** for `bidi-frame` messages. `NestedTransport` endpoints exist only in the **client** and the **applet**.

**Implementation:**
- Client establishes WebSocket connection to operator
- Operator upgrades to `WebSocketTransport`; accepts only the single pre-designated `bidi` channel
- Client opens the `bidi` channel and uses the `bidi-frame` message type to carry `NestedTransport` traffic
- Operator forwards `bidi-frame` messages verbatim between the WS `bidi` channel and the `req-N` channel on the `PipeTransport` — no `NestedTransport` instantiation
- Responder forwards `bidi-frame` messages verbatim between the `req-N` channel and the applet's `PostMessageTransport` `bidi` channel — no `NestedTransport` instantiation
- Applet instantiates `NestedTransport` over `globalThis.JSMAWS.bidi` (the `PostMessageTransport` `bidi` channel, exposed in the `JSMAWS` namespace alongside `.server`) and communicates directly with the client
- Client and applet negotiate their own channels on the `NestedTransport` — completely opaque to JSMAWS

**Architecture:**
```
Client (WebSocketTransport + NestedTransport endpoint)
    ↓ WebSocket — 'bidi' channel, 'bidi-frame' message type
Operator (transparent relay: WS 'bidi'/'bidi-frame' ↔ req-N 'bidi-frame')
    ↓ PipeTransport req-N channel — 'bidi-frame' message type
Responder (transparent relay: req-N 'bidi-frame' ↔ applet 'bidi'/'bidi-frame')
    ↓ PostMessageTransport — 'bidi' channel, 'bidi-frame' message type
Applet (NestedTransport endpoint — negotiates channels with client)
```

**Client requirements:**
- Clients must use PolyTransport library for bidirectional connections
- Standard WebSocket clients are not supported for bidi mode
- Unidirectional (request/response) mode still supports standard HTTP clients

**Rationale:**
- End-to-end flow control is non-negotiable for JSMAWS architecture
- `NestedTransport` requires an existing channel **and** a pre-designated message type on that channel to identify its traffic — `bidi-frame` serves this role consistently across all transport legs
- Operator and responder need no knowledge of the `NestedTransport` protocol — they are simple, stateless byte relays
- Client and applet can negotiate any channels they desire on the `NestedTransport` — JSMAWS is completely opaque to this
- `WebSocketTransport` accepts only the single pre-designated `bidi` channel, preventing unauthorized channel creation
- Aligns with JSMAWS security/isolation/fault-resistance requirements
- Zero production deployments — no compatibility constraints

### 12.7 Applet Console Output Routing

**Decision:** Forward applet console output from the responder to the operator via the **corresponding `req-N` channel** using `con-`-prefixed message types, not via the C2C channel on the operator ↔ responder transport.

**Implementation:**
- The responder reads from the applet's C2C channel (on the `PostMessageTransport`), which uses the bare C2C names (`trace`, `debug`, `info`, `warn`, `error`)
- Each message is forwarded to the operator by writing to the active `req-N` channel using `con-`-prefixed message types (`con-trace`, `con-debug`, `con-info`, `con-warn`, `con-error`)
- The `REQ_CHANNEL_MESSAGE_TYPES` constant includes these five `con-*` types alongside the request/response types
- The operator reads them from the `req-N` channel (interleaved with response frames) and logs them attributed to the specific request

**Rationale:**
- **Request association:** The operator can attribute console output to the specific request (and applet) that generated it, enabling accurate logging
- **Traffic control:** Applet console flooding competes against its own request traffic (per-channel flow control), not the responder's console traffic or other requests' traffic
- **Collision avoidance:** The `con-` prefix is required to avoid collision with the C2C channel's native bare names (`trace`, `debug`, `info`, `warn`, `error`) and with `res-error` on the same `req-N` channel. Message type names should describe the data type, not the source — `con-` describes "console output" as a data type, which is unambiguous on any channel.
- **Null data support:** PolyTransport supports null/undefined data (dataSize = 0). Console calls with no arguments produce zero-data `con-*` messages. Readers handle this gracefully with `msg.data?.decode() ?? ''`.

### 12.8 Message Type Naming Convention

**Decision:** Use semantic prefixes that describe the data type, not the source. The `con-` prefix is the only required prefix; all other message types use natural semantic names shared across transport legs.

**Naming scheme:**

| Name | `applet` channel | `req-N` channel | Meaning |
|---|---|---|---|
| `req` | ✓ | ✓ | HTTP request metadata + body (JSON text) |
| `res` | ✓ | ✓ | HTTP response status + headers (JSON text) |
| `res-frame` | ✓ | ✓ | Response body chunk (binary relay, `dechunk:false`) |
| `res-error` | ✓ | ✓ | Error response (JSON text) |
| `bidi-frame` | — | ✓ | NestedTransport relay chunk (bidi mode) |
| `con-trace` | — | ✓ | Forwarded applet console output (trace level) |
| `con-debug` | — | ✓ | Forwarded applet console output (debug level) |
| `con-info` | — | ✓ | Forwarded applet console output (info level) |
| `con-warn` | — | ✓ | Forwarded applet console output (warn level) |
| `con-error` | — | ✓ | Forwarded applet console output (error level) |

**Rationale:**
- Same names on both transport legs — the transport context disambiguates when debugging
- `con-` prefix is required to avoid collision with C2C channel's native bare names and with `res-error`
- `res-error` and `con-error` are clearly distinct: one is a failed HTTP response, the other is a console log at error level
- Prefixes describe data type (`con-` = console, `res-` = response), not source

### 12.9 Streaming Response Body Relay

**Decision:** Use `dechunk: false` for `res-frame` relay on both the `applet` channel and the `req-N` channel. End-of-stream is signaled by a zero-data `res-frame` with `eom: true`.

**Implementation:**
- The applet writes `res` (metadata) once, then writes `res-frame` chunks for the body
- Each `res-frame` chunk is relayed verbatim without reassembly (`dechunk: false`)
- End-of-stream: the applet writes a zero-data `res-frame` with `eom: true` (PolyTransport supports null/undefined data, dataSize = 0)
- The responder detects end-of-stream by checking `msg.data === undefined && msg.eom`
- The responder forwards the zero-data terminal frame to the operator via the `req-N` channel
- The operator detects end-of-stream the same way and closes the HTTP response

**Rationale:**
- Avoids unnecessary buffering and reassembly latency — chunks are forwarded as they arrive
- Consistent with the bidi relay pattern (`bidi-frame` also uses `dechunk: false`)
- Response data is opaque to JSMAWS — it's a contract between the applet and the client
- Zero-data terminal frame is detectable in `dechunk: false` mode because `msg.eom === true` is meaningful there (marks the last chunk of a message); in dechunked mode, `msg.eom` is always `true` and cannot be used as an EOS signal
- PolyTransport's null/undefined data support (dataSize = 0) makes the terminal frame structurally distinct from data-carrying frames without requiring a separate message type

---

## 13. Relationship to Existing Architectural Plans

This proposal is **additive** to the clean-slate rewrite approved in [`arch/refactoring-assessment-2025-12-10.md`](refactoring-assessment-2025-12-10.md). The class hierarchy proposed there (`ServerRequest`, `ServerConnection`, `BidiConnection`, `WsConnection`, `FlowControlState`) remains valid. The key changes are:

- **`FlowControlState`** is no longer needed — PolyTransport's per-channel flow control replaces it
- **`WsConnection`** wraps a `WebSocketTransport` channel instead of a raw `WebSocket`
- **`IPCConnection`** is replaced by `PipeTransport` channels
- The `ServerRequest` → `ServerConnection` hierarchy is unchanged
- A new **`RequestChannelPool`** class manages the pool of reusable request channels

The PolyTransport adoption simplifies the implementation of the proposed architecture by eliminating the need to implement `FlowControlState` from scratch and providing a proven, tested foundation for all communication layers.

---

[supplemental keywords: transport, IPC, inter-process communication, pipe, postMessage, WebSocket, flow control, backpressure, channel, multiplexing, sliding window, refactoring, PolyTransport, PipeTransport, PostMessageTransport, WebSocketTransport, NestedTransport, C2C, console content channel, TCC, transport control channel, channel pool, resource management, import map, deno.json, message type naming, req res res-frame res-error con-trace con-debug con-info con-warn con-error bidi-frame, streaming relay, end-of-stream, zero-data frame, dechunk]
