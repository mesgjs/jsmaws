# Graceful Shutdown Architecture

**Status:** [DRAFT]
**Date:** 2026-05-24

---

## Overview

This document describes the design for graceful shutdown of the JSMAWS server. The goal is to ensure that in-flight requests complete cleanly before the server exits, while providing a bounded shutdown window and proper notification to all layers of the process hierarchy.

---

## Current Issues

- **Indeterminate transmission/processing lag**: Timeouts relative to reception result in progressively later deadlines. Each hop (operator → responder → mod-app) adds latency, so the effective deadline for the innermost layer is later than intended.
- **Server shutdown immediately triggers channel closures**: A closing channel cannot write any further messages (no chance for final/cleanup messages). By the time `beforeClosing` is emitted, it's too late for any additional writes.
- **Processes/threads progressively further from the operator should have an earlier deadline, not later**: The current design passes a relative `timeout` value, which means the mod-app layer has the latest deadline, when it should have the earliest deadline.
- **No SIGTERM handler**: The operator has no registered SIGTERM handler; the process exits immediately on SIGTERM without draining in-flight requests.

---

## Design Goals

1. **Absolute deadline propagation**: Convert the relative shutdown timeout to an absolute deadline at the operator level. Propagate the deadline (not a relative timeout) to all sub-processes and workers.
2. **Deadline spread**: Each successive layer in the hierarchy receives an earlier deadline. The goal is for inner layers to complete before outer layers must close and release their resources to meet their own deadlines.
3. **Mod-app shutdown notification**: The bootstrap exposes `JSMAWS.shutdownDeadline` — a promise that resolves to the deadline timestamp when a shutdown message is received. Mod-apps can use this to initiate clean closes.
4. **SIGTERM handler**: The operator registers a SIGTERM handler that calls `shutdown()` with the configured shutdown delay.
5. **Channel-close timing**: Channels are closed at the deadline, not at receipt of the shutdown message. This gives in-flight writes time to complete.

---

## Shutdown Deadline and Spread

### Deadline Calculation

When `operator.shutdown(stopTime)` is called:

```
absoluteDeadline = Date.now() + stopTime * 1000
```

This absolute deadline (milliseconds since epoch) is what gets propagated to sub-processes and workers — not the relative `stopTime`.

### Spread

The `spread` parameter controls how much earlier each successive layer's deadline is, relative to the layer above it. This ensures inner layers have time to clean up before outer layers close their channels.

- **`spread = 0`**: No spread — all layers share the same deadline.
- **`spread >= 1`**: Spread is in seconds. Each successive layer's deadline is `spread` seconds earlier.
- **`0 < spread < 1`**: Spread is a fraction of `stopTime`. Converted to seconds (minimum 1s) for transmission.

**Example**: `stopTime = 30s`, `spread = 0.1` (10%)
- Operator deadline: `now + 30s`
- Responder deadline: `now + 27s` (3s earlier = 10% of 30s)
- Mod-app deadline: `now + 24s` (3s earlier than responder)

**Example**: `stopTime = 30s`, `spread = 5` (5 seconds)
- Operator deadline: `now + 30s`
- Responder deadline: `now + 25s`
- Mod-app deadline: `now + 20s`

### Configuration

```
shutdownDelay   30      # Shutdown timeout in seconds (default: 30)
shutdownSpread  0.1     # Spread as fraction of shutdownDelay, or seconds if >= 1 (default: 0)
```

---

## Shutdown Message Protocol

### Shutdown Message

The shutdown notification is sent as a control channel message (not a new message type — it reuses the existing `shutdown` message type on the control channel). The payload is extended to include the absolute deadline and the spread for the next level:

**Current payload:**
```json
{ "timeout": 30 }
```

**New payload:**
```json
{ "deadline": 1748050000000, "spread": 3 }
```

Where:
- `deadline`: Absolute deadline in milliseconds since epoch (for this process's layer)
- `spread`: Seconds to subtract from `deadline` when forwarding to the next layer (mod-app workers)

The `timeout` field is removed. Sub-processes compute their remaining time as `deadline - Date.now()` when needed (e.g. for the drain loop timeout).

### Shutdown Message Flow

```
Operator
  │  shutdown(stopTime=30, spread=0.1)
  │  deadline = now + 30000ms
  │  spreadSec = max(1, 0.1 * 30) = 3 seconds
  │
  ├─► HTTP/HTTPS server: server.shutdown()
  │     (stops accepting new connections; in-flight requests continue)
  │
  ├─► PoolManager.shutdown(deadline, spreadSec)
  │     │
  │     └─► ProcessManager.shutdownProcess(proc, deadline, spreadSec)
  │           │  controlChannel.write('shutdown', { deadline, spread: spreadSec })
  │           │
  │           └─► ResponderProcess.handleShutdown({ deadline, spread })
  │                 │  modAppDeadline = deadline - spread * 1000
  │                 │
  │                 ├─► Phase 0: for each active request:
  │                 │     bootstrapChannel.write('shutdown', { deadline: modAppDeadline })
  │                 │     (bootstrap resolves JSMAWS.shutdownDeadline; mod-app can clean up)
  │                 │
  │                 ├─► Phase 1: drain loop
  │                 │     wait until activeRequests.size === 0
  │                 │     OR Date.now() >= modAppDeadline
  │                 │
  │                 └─► Phase 2: at modAppDeadline, hard-terminate remaining workers
  │                       worker.terminate() + transport.stop({ disconnected: true })
  │
  └─► Operator waits until deadline
```

The layered spread replaces the previously hard-wired `(stopTime + 2) * 1000` grace period in the operator's shutdown timeout.

### Bootstrap Shutdown Handling

The responder sends a `shutdown` message on the private `bootstrap` channel (not the `app` channel) before the mod-app deadline. The bootstrap receives this message and resolves `JSMAWS.shutdownDeadline`, giving the mod-app time to clean up before the worker is terminated at the deadline.

The `bootstrap` channel is already open throughout the worker's lifetime (it was used for the initial `setup` message). Adding `shutdown` as a second message type on this channel requires no new channels or transports.

---

## Changes Required

### 1. `src/operator-process.esm.js` — SIGTERM Handler and Shutdown Deadline

**Add `registerSigtermHandler()`:**

```javascript
registerSigtermHandler () {
    Deno.addSignalListener('SIGTERM', async () => {
        this.logger.info('SIGTERM received; initiating graceful shutdown...');
        const stopTime = this.config.config.shutdownDelay ?? 30;
        await this.shutdown(stopTime);
        Deno.exit(0);
    });
}
```

Called from `src/operator.esm.js` after logger initialization (alongside `registerSighupHandler()`).

**Modify `shutdown(stopTime)`:**

- Compute `absoluteDeadline = Date.now() + stopTime * 1000`
- Get `spread` from `config.shutdownSpread` (already normalized to integer seconds by the getter)
- Pass `deadline: absoluteDeadline, spread` to `poolManager.shutdown()` and `processManager.shutdown()`
- Replace the `(stopTime + 2) * 1000` hard timeout with `Math.max(0, absoluteDeadline - Date.now())`

### 2. `src/pool-manager.esm.js` — Pass Deadline to Process Shutdown

**Modify `shutdown(deadline, spread)`:**

- Change signature from `shutdown(stopTime = 30)` to `shutdown(deadline, spread = 0)` where `spread` is in seconds
- Pass `deadline - spread * 1000` and `spread` through to `item.item.shutdown(deadline - spread * 1000, spread)`
- Update the timeout calculation: `Math.max(0, deadline - Date.now())` instead of `stopTime * 1000`

### 3. `src/process-manager.esm.js` — Send Deadline in Shutdown Message

**Modify `shutdownProcess(managedProc, deadline, spread = 0)`:**

- Change signature to accept `deadline` (ms) and `spread` (seconds)
- Change the shutdown message payload from `{ timeout }` to `{ deadline, spread }` where `spread` is in seconds
- Update the SIGKILL fallback timer: `Math.max(0, deadline - Date.now())` instead of `timeout * 1000`

**Modify `ManagedProcess.shutdown(deadline, spread)`:**

- Update signature to accept `deadline` (ms) and `spread` (seconds)

### 4. `src/sub-process.esm.js` — Update Control Message Handling

No changes needed to the base class. The `handleShutdown(msg)` method is implemented by subclasses. The base class `#processControlMessages()` already dispatches `shutdown` messages to `handleShutdown(msg)`.

### 5. `src/responder-process.esm.js` — Use Deadline in Drain Loop

**Modify `handleShutdown(msg)`:**

- Parse `{ deadline, spread }` from `msg.text` where `spread` is in seconds
- Compute `modAppDeadline = deadline - (spread ?? 0) * 1000`
- Send `shutdown` message on each active request's `bootstrapChannel` with `modAppDeadline` (Phase 0, see §6 below)
- Replace the drain loop condition: `Date.now() < modAppDeadline` instead of `(Date.now() - shutdownStart) < timeout * 1000`
- Hard-terminate workers at `modAppDeadline`, not at `shutdownStart + timeout * 1000`
- Store `bootstrapChannel` in `activeRequests` map entry (currently only `appChannel` is stored)

### 6. `src/apps/bootstrap.esm.js` — Expose `JSMAWS.shutdownDeadline`

The bootstrap needs to receive the shutdown deadline from the responder and expose it to the mod-app.

**Mechanism**: The responder sends a `shutdown` message on the private `bootstrap` channel (already open from the initial `setup` exchange). The bootstrap listens for this message in the background and resolves `JSMAWS.shutdownDeadline`. The worker is not terminated until `modAppDeadline` — giving the mod-app time to finish in-progress work.

**New message type on the `bootstrap` channel**: `shutdown`

Payload: `{ "deadline": 1748050000000 }`

**Bootstrap changes:**

1. Add `shutdown` to the `bootstrap` channel's message types (alongside `setup`).
2. Before importing the mod-app, set up a background reader on the `bootstrap` channel for `shutdown` messages.
3. Create `JSMAWS.shutdownDeadline` as a promise that resolves to the deadline timestamp.
4. Expose `JSMAWS.shutdownDeadline` in the frozen namespace.

```javascript
// In bootstrap(), after reading the setup message:
const shutdownResolvers = Promise.withResolvers();

// Background: listen for shutdown message on bootstrap channel
(async () => {
    const msg = await bootstrapChannel.read({ only: 'shutdown', decode: true });
    if (msg) {
        const { deadline } = JSON.parse(msg.text);
        await msg.done();
        shutdownResolvers.resolve(deadline);
    }
})();

const jsmawsNamespace = {
    server: appChannel,
    env: Object.freeze(setupData.appEnv ?? {}),
    shutdownDeadline: shutdownResolvers.promise,
};
```

**Responder changes** (in `handleShutdown`):

Phase 0 — before the drain loop, write a `shutdown` message on each active request's `bootstrapChannel`:

```javascript
// Phase 0: notify mod-apps of impending shutdown via bootstrap channel
for (const requestInfo of this.activeRequests.values()) {
    if (requestInfo.bootstrapChannel) {
        await requestInfo.bootstrapChannel.write('shutdown', JSON.stringify({ deadline: modAppDeadline }))
            .catch(() => {});
    }
}
// Phase 1: drain loop (existing, updated to use modAppDeadline)
// Phase 2: hard-terminate at modAppDeadline (existing)
```

This requires storing `bootstrapChannel` in the `activeRequests` entry (currently only `appChannel` is stored). The `bootstrapChannel` is already available in `#onWebRequest` via `#spawnAppWorker`'s return value — it just needs to be added to the `activeRequests` map entry.

### 7. `src/operator.esm.js` — Register SIGTERM Handler

Add `operator.registerSigtermHandler()` call after `operator.registerSighupHandler()`.

### 8. Configuration

Add `shutdownSpread` to the configuration schema in [`src/configuration.esm.js`](../src/configuration.esm.js) and document it in [`docs/configuration.md`](../docs/configuration.md).

---

## Message Type Changes

### `bootstrap` Channel (responder ↔ mod-app bootstrap)

Add new message type:

| Message Type | Direction | Payload | Description |
|---|---|---|---|
| `shutdown` | responder → bootstrap | `{ deadline: number }` | Shutdown notification with absolute deadline (ms since epoch) |

No changes to `REQ_CHANNEL_MESSAGE_TYPES` or the `app` channel message types are needed.

A new constant `BOOT_CHANNEL_MESSAGE_TYPES` should be exported from [`src/apps/bootstrap.esm.js`](../src/apps/bootstrap.esm.js) and imported by [`src/responder-process.esm.js`](../src/responder-process.esm.js) for the `addMessageTypes()` call on the `bootstrap` channel:

```javascript
// In src/apps/bootstrap.esm.js:
export const BOOT_CHANNEL_MESSAGE_TYPES = ['setup', 'shutdown'];
```

### Control Channel (operator ↔ sub-process)

Modify existing `shutdown` message payload:

| Field | Old | New | Notes |
|---|---|---|---|
| `timeout` | `number` (seconds) | removed | Replaced by `deadline` |
| `deadline` | — | `number` (ms epoch) | Absolute shutdown deadline for this process |
| `spread` | — | `number` (seconds) | Seconds to subtract for next layer's deadline |

---

## E2E Test Coverage

The existing [`test-e2e/e2e-graceful-shutdown.test.js`](../test-e2e/e2e-graceful-shutdown.test.js) has two tests. The following tests are needed:

### Test 1: Clean shutdown — no in-flight requests ✅ (exists)

Verify server stops accepting connections after `operator.shutdown()`.

### Test 2: Shutdown while request is in-flight (pre-response) ✅ (exists, partial)

Verify in-flight request completes before shutdown. Currently tests `resDelay` (delay before response headers). Needs to also verify exit code 0.

### Test 3: Shutdown while response body is in-flight (post-headers delay)

Use `sodDelay` (delay after headers, before body) and `eodDelay` (delay after body chunk, before EOS). Verify the full response body is received.

### Test 4: Shutdown while SSE stream is active

Start an SSE stream (using [`examples/apps/sse-clock.esm.js`](../examples/apps/sse-clock.esm.js) or a new fixture). Initiate shutdown. Verify the stream closes cleanly (no error, connection closed gracefully).

### Test 5: Shutdown while WebSocket is open

Open a WebSocket connection. Initiate shutdown. Verify the WebSocket receives a close frame (not an abrupt disconnect).

### Test 6: SIGTERM triggers graceful shutdown

Send `Deno.kill(pid, 'SIGTERM')` to the operator process. Verify in-flight requests complete and the process exits with code 0.

### Test 7: Shutdown deadline respected (timeout enforcement)

Configure a very short `shutdownDelay` (e.g. 1s). Start a request with `resDelay=5000` (5s). Initiate shutdown. Verify the server exits within ~3s (deadline + 2s hard timeout), even though the request did not complete.

### Test 8: `JSMAWS.shutdownDeadline` resolves during shutdown

Write a test mod-app that awaits `JSMAWS.shutdownDeadline` and writes a special header or log entry when it resolves. Verify the header/log appears during a graceful shutdown.

---

## Mod-App Developer API

After this change, mod-apps can opt into graceful shutdown handling:

```javascript
export default async function (setupData) {
    const server = globalThis.JSMAWS.server;

    // ... handle requests ...

    // Optional: clean up when server is shutting down
    const deadline = await globalThis.JSMAWS.shutdownDeadline;
    const remaining = deadline - Date.now();
    console.log(`Shutdown in ${remaining}ms — closing connections`);
    // ... close any open connections, flush buffers, etc. ...
}
```

The `shutdownDeadline` promise:
- Resolves to a `number` (milliseconds since epoch) when the shutdown message is received.
- Never rejects.
- If the mod-app completes before shutdown, the promise simply remains pending (no memory leak — the worker is terminated).

---

## Files to Create/Modify

| File | Change |
|---|---|
| [`src/operator-process.esm.js`](../src/operator-process.esm.js) | Add `registerSigtermHandler()`; modify `shutdown()` to compute absolute deadline and spread |
| [`src/operator.esm.js`](../src/operator.esm.js) | Call `registerSigtermHandler()` |
| [`src/pool-manager.esm.js`](../src/pool-manager.esm.js) | Change `shutdown()` signature to accept `deadline` and `spreadMs` |
| [`src/process-manager.esm.js`](../src/process-manager.esm.js) | Change `shutdownProcess()` to send `{ deadline, spread }` instead of `{ timeout }` |
| [`src/responder-process.esm.js`](../src/responder-process.esm.js) | Update `handleShutdown()` to use deadline; send `shutdown` on `bootstrapChannel` before drain loop; store `bootstrapChannel` in `activeRequests` |
| [`src/apps/bootstrap.esm.js`](../src/apps/bootstrap.esm.js) | Add `shutdown` to `bootstrap` channel message types; expose `JSMAWS.shutdownDeadline` |
| [`src/configuration.esm.js`](../src/configuration.esm.js) | Add `shutdownSpread` getter |
| [`docs/configuration.md`](../docs/configuration.md) | Document `shutdownDelay` and `shutdownSpread` |
| [`test-e2e/e2e-graceful-shutdown.test.js`](../test-e2e/e2e-graceful-shutdown.test.js) | Add tests 3–8 |
| [`test-e2e/apps/slow-response.esm.js`](../test-e2e/apps/slow-response.esm.js) | Already supports `resDelay`/`sodDelay`/`eodDelay`/`exitDelay` — no changes needed |

---

## Implementation Order

1. **Operator SIGTERM handler** — `registerSigtermHandler()` in `operator-process.esm.js` and `operator.esm.js`. Simplest change; unblocks E2E test 6.
2. **Deadline propagation** — Modify `shutdown()`, `PoolManager.shutdown()`, `ProcessManager.shutdownProcess()`, and `ResponderProcess.handleShutdown()` to use absolute deadlines. Fixes the slippage issue.
3. **`JSMAWS.shutdownDeadline`** — Add `shutdown` message type to `bootstrap` channel (`BOOT_CHANNEL_MESSAGE_TYPES`); update bootstrap and responder. Enables mod-app shutdown awareness.
4. **E2E tests** — Add tests 3–8 to `e2e-graceful-shutdown.test.js`.
5. **Configuration** — Add `shutdownSpread` to configuration and documentation.

---

## Implementation Notes

1. **`auth-process.esm.js`**: The auth sub-process also extends `SubProcess` and implements `handleShutdown()`. It should receive the same deadline-based shutdown message. Verify its `handleShutdown()` implementation handles the new payload format (and add `auth-process.esm.js` to the files-to-modify table if changes are needed).

2. **`router-process.esm.js`**: Same as above for the router sub-process.

3. **`JSMAWS.shutdownDeadline` race condition**: If the mod-app completes its request before the shutdown message arrives, the `shutdown` message reader in the bootstrap will be waiting on a channel that is already closed (because `transport.stop()` was called). This is safe — `channel.read()` returns `null` on close — but the `shutdownResolvers.promise` will never resolve. This is acceptable: the mod-app has already exited, so the promise is garbage-collected with the worker.

4. **Multiple requests per responder**: A single responder process handles multiple concurrent requests (up to `maxWorkers`). Each request has its own `bootstrapChannel`. The responder must send the `shutdown` message on *each* active request's `bootstrapChannel`, not just one. This is already addressed in the Phase 0 design above.

[supplemental keywords: graceful shutdown, SIGTERM, shutdown deadline, shutdown spread, shutdown signal, in-flight requests, drain, mod-app shutdown, JSMAWS.shutdownDeadline, absolute deadline, process hierarchy, shutdown timeout, shutdown propagation]
