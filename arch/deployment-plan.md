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

**Status:** [x] Complete — [`test-e2e/e2e-graceful-shutdown.test.js`](../test-e2e/e2e-graceful-shutdown.test.js) (8 tests)

All 8 E2E tests passing. `shutdownSpread` documented in `docs/configuration.md`. `JSMAWS.shutdownDeadline` promise implemented in bootstrap. Deadline propagation through operator → pool manager → process manager → responder → mod-app.

**Coverage:**
- SIGTERM received while request is in flight → request completes, then server exits
- SIGTERM received while SSE stream is active → stream closes cleanly
- SIGTERM received while WebSocket is open → WebSocket closes with appropriate close frame
- Server exits with code 0 on clean shutdown
- `JSMAWS.shutdownDeadline` promise resolves during shutdown (test 8)

**Files created/modified:**
- [`test-e2e/e2e-graceful-shutdown.test.js`](../test-e2e/e2e-graceful-shutdown.test.js) — E2E test suite (8 tests)
- [`test-e2e/apps/shutdown-deadline-check.esm.js`](../test-e2e/apps/shutdown-deadline-check.esm.js) — fixture mod-app for test 8
- [`src/operator-process.esm.js`](../src/operator-process.esm.js) — `registerSigtermHandler()`, `shutdown()`
- [`src/pool-manager.esm.js`](../src/pool-manager.esm.js) — `shutdown(deadline, spread)`
- [`src/process-manager.esm.js`](../src/process-manager.esm.js) — `shutdownProcess(proc, deadline, spread)`
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) — `handleShutdown(msg)`
- [`src/apps/bootstrap.esm.js`](../src/apps/bootstrap.esm.js) — `JSMAWS.shutdownDeadline` promise
- [`src/configuration.esm.js`](../src/configuration.esm.js) — `shutdownDelay`, `shutdownSpread` getters
- [`docs/configuration.md`](../docs/configuration.md) — `shutdownSpread` documented

---

### 1.5 SSL Certificate Validation Warnings

**Status:** [x] Complete — [`test/ssl-cert-expiry.test.js`](../test/ssl-cert-expiry.test.js) (13 tests)

Certificate expiry checking implemented in [`src/ssl-manager.esm.js`](../src/ssl-manager.esm.js) via `parseCertificateExpiry()`, `checkCertificateExpiry()`, and `SSLManager.checkExpiry()`. Checked on startup and on each certificate reload.

**Implementation:**
- `parseCertificateExpiry(certPem)` — pure ASN.1 DER parser; extracts `notAfter` from PEM certificate
- `checkCertificateExpiry(certPem, logger, certFile, now)` — logs ERROR if expired, WARN if within 30 days, INFO otherwise
- `SSLManager.checkExpiry()` — reads cert file and calls `checkCertificateExpiry()`; called on startup and on each reload
- `SSLManager.certRefTime` option — injectable reference time for testing

**Testing:**
- Unit test: `parseCertificateExpiry` returns null for invalid PEM
- Unit test: `parseCertificateExpiry` parses notAfter from reference cert
- Unit test: INFO logged for cert with >30 days remaining
- Unit test: WARN logged for cert expiring within 30 days
- Unit test: ERROR logged for expired cert
- Unit test: WARN logged for unparseable cert
- Unit test: works without certFile label
- Unit test: uses real time when `now` not provided
- Integration: `SSLManager.checkExpiry` returns null when no certFile configured
- Integration: logs WARN for near-expiry cert file
- Integration: logs ERROR for expired cert file
- Integration: logs INFO for valid cert file
- Integration: logs WARN for missing cert file

---

## Priority 2 — Medium: Documentation Gaps That Hurt Operators

### 2.1 Deployment Guide

**Status:** [x] Complete — [`docs/deployment.md`](../docs/deployment.md) (522 lines)

Comprehensive deployment guide covering:
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

---

### 2.2 Mod-App Development Guide

**Status:** [x] Complete — [`docs/mod-app-development.md`](../docs/mod-app-development.md) (574 lines)

Comprehensive mod-app development guide covering:
- What is a mod-app (ES module with default export function)
- The `setupData` object: fields, types, meaning
- The `JSMAWS.server` channel: reading `req`, writing `res`/`res-frame`/`res-error`
- Request data format (method, url, headers, routeParams, identity)
- Response patterns: simple response, streaming (SSE), error response
- The `JSMAWS.env` secrets API (`:env:`, `:file:`, `:kv:` schemes)
- WebSocket / bidi connections (`bidi-frame` message type)
- Graceful shutdown (`JSMAWS.shutdownDeadline` promise)
- Logging from mod-apps (`console.log` → C2C channel → operator log)
- Error handling best practices
- Routing configuration
- Example: hello-world, SSE clock, WebSocket echo, auth-echo (cross-reference [`examples/apps/`](../examples/apps/))

---

### 2.3 Client-Side PolyTransport Integration Guide

**Status:** [x] Complete — [`docs/client-bidi-integration.md`](../docs/client-bidi-integration.md) (430 lines)

Comprehensive client-side PolyTransport integration guide covering:
- Overview of JSMAWS bidi protocol (WebSocket with `bidi-frame` messages only)
- PolyTransport architecture (WebSocketTransport + NestedTransport layers)
- Setting up `WebSocketTransport` on the client
- Using `NestedTransport` for multiplexed channels
- Sending and receiving messages with proper flow control
- Flow control considerations (automatic sliding-window)
- Error handling and graceful shutdown
- Complete Deno/Node.js example
- Browser integration example with HTML/JavaScript
- Installation options (local clone, CDN via jsdelivr.net)

---

### 2.4 Verify Auth Revisions Reflected in `docs/configuration.md`

**Status:** [x] Complete

All auth revisions from [`arch/auth-revisions-20260510.md`](auth-revisions-20260510.md) are documented in [`docs/configuration.md`](../docs/configuration.md):

**Verified items:**
- `hostRoutes` — multi-host SNI routing ✅ (lines 316-338)
- `routeGroups` — named, reusable routing groups ✅ (lines 270+)
- Route-group-level `authn` (scalar filter) and `role` ✅ (lines 299-313)
- Route-level `authn` and `role` (overrides group-level) ✅ (lines 634-636)
- `requestFilter` / `responseFilter` at top-level and route-group level ✅ (lines 665+)
- `response` route type with `responseText` and `headers` properties ✅ (lines 222-223)
- `@allow-known`, `@allow-all`, `@deny-all` routing built-ins ✅ (lines 597-603)
- `@test-identity` provider ✅ (lines 575-587)
- `cookie=name` parameter for `@jwt` provider ✅ (line 534)
- Top-level `authn` (site-level default, runs before routing) ✅ (documented throughout)

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
| 1.4 | E2E tests: graceful shutdown | High | [x] `test-e2e/e2e-graceful-shutdown.test.js` (8 tests); `JSMAWS.shutdownDeadline`; 671 tests passing |
| 1.5 | SSL certificate validation warnings | High | [x] `parseCertificateExpiry()` + `checkCertificateExpiry()` + `SSLManager.checkExpiry()`; 13 tests in `test/ssl-cert-expiry.test.js` |
| 2.1 | Deployment guide (`docs/deployment.md`) | Medium | [x] `docs/deployment.md` (522 lines) |
| 2.2 | Mod-app development guide | Medium | [x] `docs/mod-app-development.md` (574 lines) |
| 2.3 | Client-side PolyTransport integration guide | Medium | [x] `docs/client-bidi-integration.md` (430 lines) |
| 2.4 | Verify auth revisions in `docs/configuration.md` | Medium | [x] All auth revisions documented |
| 3.1 | Performance benchmarking | Lower | [ ] |
| 3.2 | `@session` and `@oauth-is` auth providers | Lower | [ ] |
| 3.3 | Archive/annotate superseded arch documents | Lower | [ ] |
