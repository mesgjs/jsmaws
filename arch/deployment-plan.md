# JSMAWS Deployment Readiness Plan


**Status:** [ACTIVE]
**Date:** 2026-05-21

---

## Overview

This document tracks the work items needed to bring JSMAWS to production-ready deployment status. Items are ordered by priority. The server core is functionally complete (627 tests passing as of 2026-05-19), but several gaps in testing, documentation, and operational tooling remain before a confident production deployment.

The Service API ([`arch/service-api-design.md`](service-api-design.md)) is intentionally **on hold** pending real-life operational experience. It is not part of this plan.

---

## Priority 1 — High: Gaps That Could Cause Production Failures

### 1.1 E2E Tests: Static File Serving

**Status:** [x] Complete — [`test-e2e/e2e-static-files.test.js`](../test-e2e/e2e-static-files.test.js) (15 tests)

**Coverage:**
- Basic file serving (text, binary, HTML)
- MIME type detection
- 404 for missing files
- Directory traversal prevention (path outside `root`)
- Range requests (`Range: bytes=N-M`) for resumable downloads
- Concurrent requests

---

### 1.2 E2E Tests: Configuration Reload

**Status:** [x] Complete — [`test-e2e/e2e-config-reload.test.js`](../test-e2e/e2e-config-reload.test.js) (5 tests: route addition, route removal, invalid config resilience, debounce, SIGHUP)

Live configuration reload (via [`src/file-monitor.esm.js`](../src/file-monitor.esm.js) and `OperatorProcess.loadConfigFile()`) is a critical operational feature.

**Coverage:**
- Route addition: new route becomes active after config file write
- Route removal: removed route returns 404 after reload
- Invalid config: server continues serving with old config; error logged
- Rapid successive writes: debounce works correctly
- SIGHUP: `Deno.kill(pid, 'SIGHUP')` triggers reload (added with 1.3)

---

### 1.3 SIGHUP Signal Handler for Graceful Config Reload

**Status:** [x] Complete

`OperatorProcess.registerSighupHandler()` registers a SIGHUP listener that calls `loadConfigFile(this.configPath)` — the same unified path used for file-watch reloads and initial boot. `operator.esm.js` calls `registerSighupHandler()` after logger initialization.

As part of this work, the config loading architecture was refactored ([`arch/config-loading-refactor.md`](config-loading-refactor.md)):
- `Configuration.fromFile()` static factory added
- `ConfigMonitor` renamed to `FileMonitor` (`src/file-monitor.esm.js`) — now a generic file-change monitor; callback receives file path only
- `OperatorProcess.loadConfigFile()` is the single unified config load path (boot, file-watch, SIGHUP)
- NANOS backward-compat branch removed from `resolveConfig()`

**Files changed:**
- [`src/configuration.esm.js`](../src/configuration.esm.js) — `fromFile()` static method
- [`src/file-monitor.esm.js`](../src/file-monitor.esm.js) — renamed from `config-monitor.esm.js`; generic file monitor
- [`src/operator-process.esm.js`](../src/operator-process.esm.js) — `loadConfigFile()`, `registerSighupHandler()`
- [`src/operator.esm.js`](../src/operator.esm.js) — uses `loadConfigFile()` for boot; calls `registerSighupHandler()`
- [`test/file-monitor.test.js`](../test/file-monitor.test.js) — renamed from `config-monitor.test.js`
- [`test/file-monitor-atomic.test.js`](../test/file-monitor-atomic.test.js) — renamed from `config-monitor-atomic.test.js`
- [`test/operator.test.js`](../test/operator.test.js) — `loadConfigFile` unit tests
- [`test-e2e/e2e-config-reload.test.js`](../test-e2e/e2e-config-reload.test.js) — SIGHUP E2E test added

---

### 1.4 E2E Tests: Graceful Shutdown

**Status:** [ ] Not started

No E2E test verifies that in-flight requests complete before the server exits. A broken shutdown path causes dropped connections in production, which is especially harmful for streaming and WebSocket connections.

**Coverage needed:**
- SIGTERM received while request is in flight → request completes, then server exits
- SIGTERM received while SSE stream is active → stream closes cleanly
- SIGTERM received while WebSocket is open → WebSocket closes with appropriate close frame
- Server exits with code 0 on clean shutdown

**Files to create/modify:**
- `test-e2e/e2e-graceful-shutdown.test.js` — new E2E test suite

---

### 1.5 SSL Certificate Validation Warnings

**Status:** [ ] Not started

In production, expired or near-expiry certificates should produce log warnings. Without this, certificate expiry is silent until HTTPS breaks for clients.

**Implementation:**
- In [`src/ssl-manager.esm.js`](../src/ssl-manager.esm.js), after loading a certificate, parse the `notAfter` field
- Log `WARN` if certificate expires within 30 days
- Log `ERROR` if certificate is already expired (but still load it — don't break the server)
- Re-check on each certificate reload

**Testing:**
- Unit test: warning logged for near-expiry cert
- Unit test: error logged for expired cert
- Unit test: no warning for cert with >30 days remaining

---

## Priority 2 — Medium: Documentation Gaps That Hurt Operators

### 2.1 Deployment Guide

**Status:** [ ] Not started

[`docs/configuration.md`](../docs/configuration.md) covers configuration syntax well, but there is no guide for actually deploying the server. Operators need step-by-step instructions.

**Content needed (`docs/deployment.md`):**
- System requirements (Deno version, OS)
- Installation steps
- Privilege setup: creating a dedicated `www-data` user/group; numeric UID/GID in config
- Required Deno permissions flags (`--allow-read`, `--allow-net`, `--allow-run`, etc.)
- Recommended directory layout (`/etc/jsmaws/`, `/var/www/`, `/var/log/jsmaws/`)
- systemd unit file example
- certbot / Let's Encrypt integration (ACME HTTP-01 challenge path, post-renewal hook)
- Recommended pool sizing for common workloads (small site, medium site, high-traffic)
- Log rotation setup (logrotate config)
- Upgrading JSMAWS

**Files to create:**
- `docs/deployment.md`

---

### 2.2 Mod-App Development Guide

**Status:** [ ] Not started

No guide exists for writing mod-apps. The [`examples/apps/`](../examples/apps/) directory has good examples, but there is no narrative documentation explaining the protocol, available APIs, or patterns.

**Content needed (`docs/mod-app-development.md`):**
- What is a mod-app (ES module with default export function)
- The `setupData` object: fields, types, meaning
- The `JSMAWS.server` channel: reading `req`, writing `res`/`res-frame`/`res-error`
- Request data format (method, url, headers, routeParams, identity)
- Response patterns: simple response, streaming (SSE), error response
- The `JSMAWS.env` secrets API (`:env:`, `:file:`, `:kv:` schemes)
- WebSocket / bidi connections (`bidi-frame` message type)
- Logging from mod-apps (`console.log` → C2C channel → operator log)
- Error handling best practices
- Example: hello-world, SSE clock, WebSocket echo, auth-echo (cross-reference [`examples/apps/`](../examples/apps/))

**Files to create:**
- `docs/mod-app-development.md`

---

### 2.3 Client-Side PolyTransport Integration Guide

**Status:** [ ] Not started

Clients using WebSocket bidi connections need to know how to use `WebSocketTransport` + `NestedTransport` on the browser/client side. Without this, the bidi/WebSocket feature is effectively undocumented for external consumers.

**Content needed (`docs/client-bidi-integration.md`):**
- When to use bidi vs. plain WebSocket
- Setting up `WebSocketTransport` on the client
- Using `NestedTransport` for multiplexed channels
- Sending and receiving `bidi-frame` messages
- Flow control considerations
- Example: browser client for the `websocket-echo` example app (cross-reference [`examples/clients/ws-echo.esm.js`](../examples/clients/ws-echo.esm.js))

**Files to create:**
- `docs/client-bidi-integration.md`

---

### 2.4 Verify Auth Revisions Reflected in `docs/configuration.md`

**Status:** [ ] Not started

[`arch/auth-revisions-20260510.md`](auth-revisions-20260510.md) introduced several features that must be fully documented in the user-facing [`docs/configuration.md`](../docs/configuration.md):

**Items to verify/add:**
- `hostRoutes` — multi-host SNI routing
- `routeGroups` — named, reusable routing groups
- Route-group-level `authn` (scalar filter) and `role`
- Route-level `authn` and `role` (overrides group-level)
- `requestFilter` / `responseFilter` at top-level and route-group level
- `response` route type with `responseText` and `headers` properties
- `@allow-known`, `@allow-all`, `@deny-all` routing built-ins
- `@test-identity` provider
- `cookie=name` parameter for `@jwt` provider (added 2026-05-19)
- Top-level `authn` (site-level default, runs before routing)

**Files to modify:**
- [`docs/configuration.md`](../docs/configuration.md) — add/update sections as needed

---

## Priority 3 — Lower: Operational Polish

### 3.1 Performance Benchmarking

**Status:** [ ] Not started

No baseline benchmarks exist. Before production, it is valuable to know throughput and latency under load so regressions can be detected and pool sizing recommendations can be grounded in data.

**Suggested approach:**
- Use `wrk` or `autocannon` for HTTP benchmarking
- Benchmark scenarios: static file serving, simple mod-app response, SSE streaming, WebSocket echo
- Measure: requests/sec, p50/p95/p99 latency, memory usage under sustained load
- Document results in `docs/benchmarks.md` or a `bench/` directory
- Establish a repeatable benchmark script

---

### 3.2 `@session` and `@oauth-is` Auth Providers

**Status:** [ ] Not started

These external auth providers are referenced in the architecture (they trigger the auth sub-process path via [`src/auth-process.esm.js`](../src/auth-process.esm.js)) but are not implemented. Any deployment requiring session-based or OAuth authentication will need them.

**Files to create:**
- `src/auth/session.esm.js` — `@session` provider
- `src/auth/oauth-is.esm.js` — `@oauth-is` provider (OAuth introspection)

**Note:** These are feature additions, not bugs. Deployments using only `@jwt`, `@basic`, or `@api-key` are unaffected.

---

### 3.3 Archive / Annotate Superseded Arch Documents

**Status:** [ ] Not started

Several arch documents reference the old IPC protocol (pre-PolyTransport refactor) or other superseded designs. These should be archived or annotated to avoid confusion during future development.

**Documents to review:**
- [`arch/ipc-protocol.md`](ipc-protocol.md) — superseded by PolyTransport; move to `archived/arch/`
- [`arch/bidirectional-flow-control.md`](../archived/arch/bidirectional-flow-control.md) — already archived; verify annotation
- [`arch/ipc-update-plan.md`](../archived/arch/ipc-update-plan.md) — already archived; verify annotation
- [`arch/unified-protocol-assessment.md`](../archived/arch/unified-protocol-assessment.md) — already archived; verify annotation
- [`arch/development-and-test-plan.md`](development-and-test-plan.md) — Phases 1-9 are largely historical; consider adding a status header noting which phases are complete

**Action:** Move superseded documents to `archived/arch/` and add a `[SUPERSEDED by ...]` header to each.

---

## Progress Tracking

| # | Item | Priority | Status |
|---|------|----------|--------|
| 1.1 | E2E tests: static file serving | High | [x] `test-e2e/e2e-static-files.test.js` (15 tests) |
| 1.2 | E2E tests: config reload | High | [x] `test-e2e/e2e-config-reload.test.js` (4 tests) |
| 1.3 | SIGHUP signal handler | High | [x] `registerSighupHandler()` + `loadConfigFile()` + config loading refactor; 648 tests passing |
| 1.4 | E2E tests: graceful shutdown | High | [ ] |
| 1.5 | SSL certificate validation warnings | High | [ ] |
| 2.1 | Deployment guide (`docs/deployment.md`) | Medium | [ ] |
| 2.2 | Mod-app development guide | Medium | [ ] |
| 2.3 | Client-side PolyTransport integration guide | Medium | [ ] |
| 2.4 | Verify auth revisions in `docs/configuration.md` | Medium | [ ] |
| 3.1 | Performance benchmarking | Lower | [ ] |
| 3.2 | `@session` and `@oauth-is` auth providers | Lower | [ ] |
| 3.3 | Archive/annotate superseded arch documents | Lower | [ ] |
