# JSMAWS Authentication and Authorization API Design

**Status:** [APPROVED]  
**Date:** 2026-04-27  
**Updated:** 2026-04-28

---

## 1. Problem Statement

JSMAWS currently routes requests to mod-apps and provides them with raw HTTP headers, URL parameters, and body data. There is no server-level mechanism for:

- **Authentication**: Verifying the identity of the caller (who are you?)
- **Authorization**: Deciding whether the caller may access a resource (are you allowed?)
- **Header/cookie filtering**: Controlling which headers and cookies flow into and out of mod-apps (security hygiene)

Without these, every mod-app must implement its own auth logic, leading to duplication, inconsistency, and security gaps. The goal is a **modular, pluggable** system that can be composed at the route or pool level, while remaining transparent to mod-apps that don't need it.

---

## 2. Design Principles

1. **Modular / pluggable**: Auth providers are independent modules, loaded by configuration.
2. **Composable**: Multiple providers can be chained (e.g., JWT check → role check → rate limit).
3. **Transparent to mod-apps**: Mod-apps receive a clean, normalized identity object; they don't need to parse tokens or cookies themselves.
4. **Operator-side enforcement**: Auth decisions happen in the operator or responder *before* the mod-app is spawned, so a rejected request never reaches untrusted code.
5. **Header/cookie filtering**: Inbound request and outbound response header/cookie filtering is a first-class concern, not an afterthought.
6. **Mesgjs-compatible**: The API should be expressible in Mesgjs message-passing style as well as plain JavaScript.

---

## 3. Where Auth Fits in the Request Pipeline

```
Client
  │  HTTP request (headers, cookies, body)
  ▼
Operator Process (privileged)
  │  [OPTION D] Stateless auth runs here inline (JWT, API key, Basic)
  │  Advantages: zero IPC overhead; operator cache; enables role-based routing
  │  Disadvantages: auth code runs in privileged process
  │
  │  [OPTION C] Auth service process (unprivileged, external) with operator caching
  │  Advantages: unprivileged auth code; operator cache; enables role-based routing
  │  Supports: network-dependent auth (OAuth, LDAP, session stores)
  │  Disadvantages: IPC round-trip on cache miss; requires auth service process
  │
  │  Both options above run BEFORE routing — identity is available for pool selection
  ▼
Routing Decision (pool selection, possibly role-based)
  ▼
Responder Process (unprivileged)
  │  [OPTION A] Auth middleware runs here — before spawning mod-app worker
  │  Advantages: auth logic runs unprivileged; can use network
  │  Disadvantages: routing already decided; cannot influence pool selection;
  │                 N independent caches cleared on each responder restart
  ▼
Mod-App Worker (sandboxed)
  │  [OPTION B] Auth logic runs in mod-app — current state
  │  Disadvantages: every mod-app must implement auth; no server-level enforcement
```

**Original recommendation: Option A (responder-side auth middleware)**

The original design recommended responder-side auth as the primary approach. However, the analysis in Section 3a identifies significant performance and capability limitations of this approach. See Section 3a for a revised assessment.

**Revised recommendation: Option C (auth service process + operator cache) for full-featured deployments; Option D (operator-embedded) for stateless-only auth.**

- Both Options C and D run *before* routing, enabling role-based pool selection
- Option C keeps auth code unprivileged while achieving operator-level cache efficiency
- Option A (responder-side) remains viable for simple deployments where role-based routing is not needed

---

## 3a. Performance and Efficiency: Operator vs. Responder Auth

This section analyzes the performance and capability implications of where auth runs, given the actual process lifecycle of JSMAWS.

### Process Lifetime Asymmetry

| | Operator | Responder |
|---|---|---|
| **Lifetime** | Server lifetime (runs until server stops) | Recycled after `maxReqs` requests |
| **Instance count** | 1 | N (one per pool worker, potentially many) |
| **Module cache** | Persistent for server lifetime | Cleared on each responder restart |
| **In-memory state** | Persistent for server lifetime | Cleared on each responder restart |

This asymmetry has significant implications for auth efficiency.

### Cache Efficiency

Auth providers frequently benefit from caching:

- **JWT verification**: The signing key (JWKS endpoint fetch, or symmetric secret) is loaded once and reused for all token verifications.
- **OAuth introspection**: Introspection results are cached by token for their TTL to avoid repeated network calls to the authorization server.
- **API key lookup**: The set of valid keys is loaded from config/environment and cached in memory.
- **Session store**: Session data may be cached in memory to reduce backend lookups.

**With responder-side auth (original recommendation):**

- Each of the N responder processes maintains its own independent cache.
- When a responder is recycled (after `maxReqs` requests), its entire cache is discarded. The replacement responder starts cold.
- For OAuth introspection: the same token may be re-introspected up to N × (restart frequency) times — once per responder process, once per restart cycle — even if the token's TTL has not expired.
- For JWKS key fetching: the same public key set is fetched N × (restart frequency) times.
- Cache hit rates are lower because each cache covers only 1/N of the traffic and is periodically wiped.

**With operator-side auth:**

- A single cache covers 100% of traffic.
- The cache persists for the server lifetime — no cold-start penalty after recycling.
- OAuth introspection results are cached once and reused across all responders and all restart cycles (within the token's TTL).
- JWKS keys are fetched once and refreshed only when they actually expire or rotate.

**Quantified example:** With 4 responder processes each recycling every 1,000 requests, a token with a 1-hour TTL and a 10-second average request rate would be introspected:
- Responder-side: up to 4 × (3,600 / 1,000 × 10) = ~144 times per hour per token (worst case, if the token is used continuously and each responder sees it once per cycle)
- Operator-side: once per hour per token (cached for the full TTL)

### Module Loading Cost

Auth provider modules must be loaded (and their initialization code run) before they can process requests:

- **Responder-side**: Each responder process loads all configured auth provider modules on first use. After a restart, the new responder process must reload them. With N responders each restarting periodically, module loading happens N × (restart frequency) times.
- **Operator-side**: Auth provider modules are loaded once at server startup and never reloaded (unless the server itself restarts).

For providers that perform expensive initialization (e.g., loading a large API key database, establishing a connection to a session store), this difference is significant.

### Role-Based Routing: A Capability Gap

**This is the most architecturally significant implication of the operator vs. responder choice.**

In JSMAWS, routing happens in the operator (or router worker) *before* the request is dispatched to a responder pool. The routing decision determines which pool handles the request. If auth runs only in the responder, the routing decision is already made — auth results cannot influence it.

**What operator-side auth enables that responder-side auth cannot:**

1. **Role-based pool selection**: Route `admin` role users to a dedicated high-priority pool; route `premium` users to a faster pool; route unauthenticated users to a public pool.

   ```slid
   routes=[
     [path=/api/:*  pool=admin-fast   auth=[@jwt]  requireRoles=[admin]]
     [path=/api/:*  pool=premium      auth=[@jwt]  requireRoles=[premium]]
     [path=/api/:*  pool=standard     auth=[@jwt]]
   ]
   ```

   With responder-side auth, all three routes would dispatch to their respective pools *before* knowing the user's role — the role check happens after pool selection, making role-based pool routing impossible.

2. **Tenant-based routing**: Route requests to tenant-specific pools or mod-apps based on the authenticated tenant identity.

3. **Unauthenticated fast-path rejection at the routing layer**: Reject unauthenticated requests before they consume a pool slot, rather than after.

4. **Auth-conditional route matching**: Match routes based on identity attributes (e.g., a route that only exists for internal service accounts).

None of these are possible when auth runs exclusively in the responder, because the routing decision is irrevocably made before the responder sees the request.

### Operator-Embedded Auth: Broader Than "Pre-flight"

The original document framed operator-level auth as limited to "simple, stateless checks" such as checking for the presence of a header. This framing is too narrow.

Many auth methods are inherently stateless and computationally inexpensive at the operator level:

- **JWT verification** (HS256/RS256): Cryptographic signature verification is CPU-bound but fast, requires no network calls, and the signing key can be cached for the server lifetime. This is fully viable in the operator.
- **API key lookup**: A hash set lookup against a cached key table — trivially fast and stateless.
- **IP allowlist/denylist**: Already identified as a pre-flight check; trivially fast.
- **`require-header` checks**: Already identified as a pre-flight check.

The only auth methods that genuinely require the responder (due to network calls or mutable state) are:
- **OAuth introspection**: Requires an outbound HTTP call to the authorization server (though results can be cached).
- **Session cookie verification**: Requires a lookup against a session store (which may be a network call).
- **LDAP/directory lookups**: Require network calls.

**Proposed revised framing**: Operator-side auth should be the *default* for stateless auth methods (JWT, API key, Basic), with responder-side auth reserved for methods that genuinely require network calls or mutable state. The operator's single-instance, server-lifetime cache makes it significantly more efficient for stateless auth.

### Auth Service Process with Operator Caching: A Third Path

The JSMAWS architecture already uses external processes for routing (the `router-process` when `fsRouting` is enabled) and for request handling (responders). This pattern suggests a third option that combines the best properties of operator-side and responder-side auth:

**An auth service process (unprivileged, external) with operator-side result caching.**

```
Client
  │  HTTP request
  ▼
Operator Process (privileged)
  │  1. Check operator auth cache (hit → use cached identity, proceed to routing)
  │  2. Cache miss → IPC to auth service process
  │                    ↓
  │              Auth Service Process (unprivileged)
  │              - Runs auth provider modules
  │              - Can make network calls (OAuth, LDAP)
  │              - Returns AuthResult to operator
  │                    ↓
  │  3. Operator caches result, proceeds to routing with identity
  │  4. Route based on identity/roles (role-based pool selection)
  ▼
Responder Pool (selected based on identity)
  ▼
Mod-App Worker
```

**Why this is architecturally consistent:**

- The `router-process` is already an external process that the operator communicates with via IPC for filesystem-based routing. An auth service process follows the same pattern.
- Responders are already external processes managed by the operator. An auth service process is just another managed process type.
- The operator already manages process pools; an auth service pool is a natural extension.

**Properties of this approach:**

| Property | Value |
|---|---|
| Auth code privilege | Unprivileged (external process) |
| Cache location | Operator (server lifetime, single instance) |
| Cache efficiency | Maximum: same as operator-embedded auth |
| Network calls | Fully supported (in auth service process) |
| Role-based routing | **Possible** (operator has identity before routing) |
| Module loading | Once per auth service process lifetime |
| Complexity | Higher than embedded auth, lower than full IPC redesign |

**Cache invalidation:** The operator caches `AuthResult` objects keyed by token/credential, with TTL derived from the auth result (e.g., JWT `exp` claim, OAuth introspection `exp`). Cache misses trigger an IPC call to the auth service. The auth service process can be long-lived (like a router process) or pooled.

**Comparison with operator-embedded auth:**

- *Security*: Auth code runs unprivileged (better than operator-embedded)
- *Efficiency*: Identical cache efficiency (operator holds the cache)
- *Capability*: Supports network calls (better than operator-embedded for OAuth/LDAP)
- *Complexity*: Requires auth service process management (more complex than operator-embedded)

This approach resolves the tension between "auth code should be unprivileged" and "auth results should be cached at the operator level for routing and efficiency." It is the recommended architecture for deployments that need both role-based routing and network-dependent auth (OAuth, LDAP, session stores).

### Summary Table

| Concern | Operator Auth | Auth Service + Operator Cache | Responder Auth |
|---|---|---|---|
| Cache efficiency | High: single cache, server lifetime | High: single cache, server lifetime | Low: N caches, cleared on restart |
| Module load cost | Once per server start | Once per auth service start | N × restart frequency |
| Network call deduplication | Optimal: one call per TTL | Optimal: one call per TTL | Suboptimal: up to N × restarts per TTL |
| Role-based routing | **Possible** | **Possible** | **Not possible** |
| Tenant-based routing | **Possible** | **Possible** | **Not possible** |
| Privilege exposure | Higher: auth code in privileged process | Lower: auth code in unprivileged process | Lower: auth code in unprivileged process |
| Network calls from auth | Not recommended | Fully supported | Fully supported |
| Mutable session state | Not recommended | Fully supported | Fully supported |
| Architectural complexity | Low | Medium | Low |

**Conclusion**: Three viable approaches exist, each with different tradeoffs:

1. **Operator-embedded auth** (stateless only): Best for simple deployments with JWT/API key auth. Low complexity, maximum efficiency, enables role-based routing. Not suitable for OAuth introspection or session stores.

2. **Auth service process + operator cache** (recommended for full-featured deployments): Combines operator-level cache efficiency and role-based routing capability with unprivileged auth code and full network access. Architecturally consistent with the existing router-process pattern. Higher implementation complexity.

3. **Responder-side auth** (current design): Simplest to implement. Suitable when role-based routing is not needed and cache efficiency is not a concern. Degrades with more responder processes and more frequent recycling.

A hybrid is also possible: operator-embedded auth for stateless methods (JWT, API key) with an auth service for stateful/network methods (OAuth, sessions), with the operator caching results from both paths.

---

## 4. Auth Provider Interface

An auth provider is a JavaScript module with a well-defined interface:

```javascript
// auth-provider interface (conceptual)
export default {
    /**
     * Authenticate and/or authorize a request.
     * Called before the mod-app worker is spawned.
     *
     * @param {AuthContext} ctx - Request context (headers, cookies, route, pool)
     * @returns {AuthResult} - { identity, allow, denyStatus, denyMessage, addHeaders }
     */
    async authCheck (ctx) { ... },

    /**
     * Optional: filter request headers/cookies before forwarding to mod-app.
     * Called after a successful authCheck().
     *
     * @param {object} headers - Raw request headers
     * @param {AuthResult} result - Result from authCheck()
     * @returns {object} - Filtered headers to forward to mod-app
     */
    filterRequest (headers, result) { ... },

    /**
     * Optional: filter outbound response headers/cookies before sending to client.
     * Called after the mod-app produces a response.
     *
     * @param {object} headers - Mod-app-produced response headers
     * @param {AuthResult} result - Result from authCheck()
     * @returns {object} - Filtered headers to send to client
     */
    filterResponse (headers, result) { ... },
};
```

### AuthContext

```javascript
{
    method: 'GET',                    // HTTP method
    url: 'https://example.com/api/x', // Full URL
    headers: { ... },                 // Raw request headers (plain object)
    cookies: { name: value, ... },    // Parsed cookies (plain object)
    routeSpec: { ... },               // Matched route specification
    poolName: 'standard',             // Pool name
    config: { ... },                  // Auth provider configuration (from route/pool config)
}
```

### AuthResult

```javascript
{
    allow: true,                      // true = proceed; false = deny
    identity: {                       // Populated on success; null on deny
        sub: 'user-123',              // Subject (user ID, service account, etc.)
        roles: ['admin', 'user'],     // Roles/permissions
        claims: { ... },              // Provider-specific claims
        provider: 'jwt',              // Which provider authenticated this
    },
    denyStatus: 401,                  // HTTP status for denial (default: 401)
    denyMessage: 'Unauthorized',      // Human-readable denial message
    addHeaders: {                     // Headers to add to the forwarded request
        'x-user-id': 'user-123',      // (e.g., inject identity for mod-app)
    },
}
```

---

## 5. Option Proposals

### Option A: Responder-Side Auth Middleware

Auth providers are configured per-route or per-pool in `jsmaws.slid`. The responder loads and runs the configured providers before spawning the mod-app. This is the simplest option and the recommended starting point, but see Section 3a for its performance and capability limitations compared to Options C and D.

**Configuration example:**

```slid
[(
  routes=[
    [
      path=/api/:*
      pool=standard
      auth=[
        [provider=./auth/jwt-provider.esm.js  secret=:env:JWT_SECRET  roles=[user admin]]
        [provider=./auth/rate-limit.esm.js    limit=100  window=60]
      ]
      requestFilter=[allowHeaders=[authorization x-request-id content-type]]
      responseFilter=[denyHeaders=[set-cookie x-internal-token]]
    ]
    [
      path=/public/:*
      pool=standard
      /* No auth — public route */
    ]
  ]
)]
```

**How it works:**

1. Operator routes request to responder (unchanged)
2. Responder reads `routeSpec.auth` from the request metadata
3. Responder loads each auth provider module (cached after first load)
4. Responder calls `provider.authCheck(ctx)` in order; first denial short-circuits
5. On success: responder applies `filterRequest()` to headers, then spawns mod-app with filtered headers + identity
6. On denial: responder returns the configured `denyStatus` response without spawning mod-app
7. After mod-app responds: responder applies `filterResponse()` to response headers

**Mod-app receives:**

```javascript
// In requestData (via JSMAWS.server 'req' message):
{
    method, url, headers,   // Filtered request headers
    routeParams, routeTail,
    body,
    identity: {             // NEW: populated by auth provider
        sub: 'user-123',
        roles: ['admin'],
        claims: { ... },
        provider: 'jwt',
    },
    // ... other fields
}
```

**Advantages:**
- Declarative configuration; no mod-app code changes needed
- Auth logic is centralized and reusable across routes
- Mod-apps receive a clean identity object; no token parsing needed
- Header filtering is co-located with auth configuration

**Disadvantages:**
- Auth provider modules must be trusted (they run in the responder process)
- Configuration can become verbose for complex auth chains

---

### Option B: Auth as a Built-in Mod-App Wrapper

Auth is implemented as a special "wrapper mod-app" that runs before the real mod-app. The wrapper handles auth, then either rejects the request or forwards it to the real mod-app.

**Configuration example:**

```slid
[(
  routes=[
    [
      path=/api/:*
      pool=standard
      app=./auth/jwt-wrapper.esm.js
      wrappedApp=./apps/api.esm.js
    ]
  ]
)]
```

**How it works:**

1. Responder spawns the wrapper mod-app (not the real mod-app)
2. Wrapper mod-app performs auth, then either:
   - Rejects: sends `res-error` or a 401/403 response
   - Accepts: somehow invokes the real mod-app (but mod-apps can't spawn workers — this is a problem)

**Problems:**
- Mod-apps cannot spawn sub-workers (workers are disabled in the bootstrap)
- The wrapper would need to re-implement the full request/response relay
- This approach fights the architecture rather than working with it

**Verdict: Not recommended.** The responder-side middleware approach (Option A) is cleaner.

---

### Option C: Auth Service Process with Operator Caching (Pre-routing)

A separate auth service process (unprivileged, external) handles auth decisions. The operator caches results and uses them for routing decisions — before dispatching to a responder pool. This is architecturally consistent with the existing `router-process` pattern.

**Architecture:**

```
Operator → [IPC] → Auth Service Process → [AuthResult] → Operator cache → routing → Responder → Mod-app
```

**How it works:**

1. Operator matches route and checks its auth result cache (keyed by token/credential)
2. Cache hit: operator uses cached identity for routing and forwards to responder with identity attached
3. Cache miss: operator sends auth request to auth service process via IPC
4. Auth service runs configured providers (can make network calls: OAuth, LDAP, session store)
5. Auth service returns `AuthResult` to operator
6. Operator caches result (TTL from auth result), uses identity for routing, forwards to responder

**Advantages:**
- Auth code runs unprivileged (auth service process, not operator)
- Operator cache provides server-lifetime efficiency (single cache, no cold-start on responder restart)
- Supports network-dependent auth (OAuth introspection, LDAP, session stores)
- Enables role-based routing (operator has identity before pool dispatch)
- Architecturally consistent with existing `router-process` pattern
- Auth service can maintain long-lived state (session cache, token blacklist)

**Disadvantages:**
- IPC round-trip latency on cache miss (mitigated by operator cache hit rate)
- Requires auth service process management (new process type)
- Higher implementation complexity than responder-side auth

**Verdict: Recommended for full-featured deployments** that need both role-based routing and network-dependent auth. The operator cache makes this significantly more efficient than the original Option C framing (responder → auth service), which added IPC latency to every request. See Section 3a for detailed analysis.

---

### Option D: Operator-Embedded Auth (Stateless Methods Only)

Auth logic runs directly in the operator process for stateless auth methods (JWT, API key, Basic). This is the simplest approach for deployments that don't need network-dependent auth.

**Use cases:**
- JWT verification (stateless, CPU-bound, no network calls)
- API key lookup (hash set lookup against cached key table)
- IP allowlist/denylist
- `require-header` checks
- HTTP Basic authentication

**Configuration example:**

```slid
[(
  routes=[
    [
      path=/api/:*
      pool=standard
      auth=[
        [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
        [provider=@api-key  header=x-api-key  keys=:env:API_KEYS]
      ]
    ]
    [
      path=/admin/:*
      pool=admin-fast
      auth=[
        [provider=@jwt  secret=:env:JWT_SECRET  requireRoles=[admin]]
      ]
    ]
  ]
)]
```

**How it works:**

1. Operator matches route and runs configured auth providers inline
2. Auth providers are loaded once at server startup and cached for server lifetime
3. On failure: operator returns 401/403 immediately (never reaches responder)
4. On success: operator uses identity for routing (role-based pool selection), forwards to responder with identity attached

**Advantages:**
- Simplest implementation (no external process)
- Maximum cache efficiency (operator-lifetime, single instance)
- Enables role-based routing
- Zero IPC overhead (auth runs inline in operator)
- Auth provider modules loaded once at server startup

**Disadvantages:**
- Auth code runs in privileged process (larger attack surface)
- Not suitable for network-dependent auth (OAuth introspection, LDAP, session stores)
- Operator process must be trusted to run auth provider code

---

## 6. Header and Cookie Filtering

Header/cookie filtering is a first-class concern, independent of auth. It should be configurable at the route level.

The filter configuration is organized by direction (`requestFilter` / `responseFilter`), with header and cookie rules grouped together within each direction block.

Header filtering is case-*insensitive*. Cookie filtering is case-*sensitive*.

### Inbound Request Filtering (Client → Mod-App)

Controls which headers/cookies the mod-app can see:

```slid
requestFilter=[
  /* Allowlist: only these headers reach the mod-app */
  allowHeaders=[authorization content-type content-length accept x-request-id]
  /* OR denylist: all headers except these reach the mod-app */
  /* denyHeaders=[x-internal-*] */

  /* Cookie allowlist: only these cookies reach the mod-app */
  allowCookies=[session_id csrf_token]
  /* OR cookie denylist */
  /* denyCookies=[internal_*] */
]
```

### Outbound Response Filtering (Mod-App → Client)

Controls which headers/cookies the mod-app can set in the response:

```slid
responseFilter=[
  /* Deny: mod-apps cannot set these headers */
  denyHeaders=[set-cookie x-internal-* server x-powered-by]
  /* Operator adds its own server header after filtering */

  /* Deny: mod-apps cannot set these cookies */
  denyCookies=[internal_*]
]
```

### Filter Modes

| Field | Behavior |
|-------|----------|
| `allowHeaders=[...]` | Allowlist: only listed headers pass through |
| `denyHeaders=[...]` | Denylist: all headers except listed ones pass through |
| `allowCookies=[...]` | Allowlist: only listed cookies pass through |
| `denyCookies=[...]` | Denylist: all cookies except listed ones pass through |
| `allow*` + `deny*` | Allowlist takes precedence; deny further restricts |
| (none) | Pass all headers/cookies (default, backward compatible) |

Patterns support simple wildcards: `x-internal-*` matches `x-internal-foo`, `x-internal-bar`, etc.

---

## 7. Identity Propagation to Mod-Apps

After successful auth, the identity is injected into the request payload sent to the mod-app:

```javascript
// requestData received by mod-app via JSMAWS.server 'req' message
{
    method: 'GET',
    url: 'https://example.com/api/users',
    headers: { /* filtered inbound request headers */ },
    routeParams: { ... },
    routeTail: '',
    body: null,
    identity: {
        sub: 'user-123',
        roles: ['admin', 'user'],
        claims: {
            email: 'user@example.com',
            exp: 1714234567,
        },
        provider: 'jwt',
    },
    // identity is null if no auth is configured for this route
}
```

Mod-apps that don't need auth simply ignore the `identity` field. Mod-apps that do need it can use it directly without parsing tokens.

---

## 8. Built-in Auth Providers

The following built-in providers are proposed for the initial implementation:

### 8.1 `@jwt` — JSON Web Token Verification

```slid
auth=[[provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256  roles=[user]]]
```

- Verifies JWT in `Authorization: Bearer <token>` header
- Extracts claims and maps to identity
- Optional role check: denies if identity lacks required roles
- Secret can be loaded from environment variable (`:env:VAR_NAME`) or literal string

### 8.2 `@api-key` — API Key Verification

```slid
auth=[[provider=@api-key  header=x-api-key  keys=:env:API_KEYS]]
```

- Verifies API key in a configurable header
- Keys loaded from environment variable (comma-separated) or config file
- Maps key to identity (key → subject mapping)

### 8.3 `@basic` — HTTP Basic Authentication

```slid
auth=[[provider=@basic  realm=MyApp  users=:env:BASIC_AUTH_USERS]]
```

- Verifies `Authorization: Basic <base64>` header
- Users loaded from environment variable or config file
- Maps username to identity

### 8.4 `@session` — Session Cookie Verification

```slid
auth=[[provider=@session  cookie=session_id  store=./auth/session-store.esm.js]]
```

- Verifies session cookie against a pluggable session store
- Session store is a user-provided module (e.g., Redis, in-memory, file-based)
- Maps session to identity

### 8.5 `@oauth-introspect` — OAuth 2.0 Token Introspection

```slid
auth=[[provider=@oauth-introspect  endpoint=https://auth.example.com/introspect  clientId=:env:CLIENT_ID  clientSecret=:env:CLIENT_SECRET]]
```

- Calls OAuth 2.0 token introspection endpoint
- Verifies token is active and extracts claims
- Caches introspection results (configurable TTL)

### 8.6 `@allow-all` / `@deny-all` — Testing/Development

```slid
auth=[[provider=@allow-all  identity=[sub=dev-user  roles=[admin]]]]
auth=[[provider=@deny-all   status=503  message=Maintenance]]
```

- `@allow-all`: Always allows, injects a configurable identity (useful for development)
- `@deny-all`: Always denies with a configurable status (useful for maintenance mode)

---

## 9. Implementation Plan

The implementation plan reflects the revised architecture. Option A (responder-side) is implemented first as it is the simplest and provides immediate value. Options D and C follow, adding operator-level efficiency and role-based routing capability.

### Phase 1: Option A — Responder-Side Auth (Core Infrastructure)

1. **Auth provider loader** in `src/auth-provider-loader.esm.js`
   - Loads and caches auth provider modules
   - Validates provider interface
   - Handles built-in provider aliases (`@jwt`, `@api-key`, etc.)

2. **Auth middleware runner** in `src/auth-middleware.esm.js`
   - Runs auth provider chain for a request
   - Returns `AuthResult` (allow/deny + identity)
   - Handles errors from providers (treat as 500)

3. **Header/cookie filter** in `src/header-filter.esm.js`
    - Applies `requestFilter` / `responseFilter` rules
    - Supports `allowHeaders`, `denyHeaders`, `allowCookies`, `denyCookies` fields
    - Supports allowlist, denylist, and wildcard patterns

4. **Integration in `src/responder-process.esm.js`**
   - Call auth middleware before spawning mod-app worker
   - Inject identity into request payload
   - Apply inbound request header filter before forwarding to mod-app
   - Apply outbound response header filter after mod-app responds

### Phase 2: Built-in Providers

Implement built-in providers in `src/auth/`:
- `src/auth/jwt.esm.js` — `@jwt`
- `src/auth/api-key.esm.js` — `@api-key`
- `src/auth/basic.esm.js` — `@basic`
- `src/auth/session.esm.js` — `@session`
- `src/auth/oauth-introspect.esm.js` — `@oauth-introspect`
- `src/auth/allow-all.esm.js` — `@allow-all`
- `src/auth/deny-all.esm.js` — `@deny-all`

### Phase 3: Option D — Operator-Embedded Stateless Auth

Implement stateless auth in the operator for JWT, API key, and Basic auth:

1. **Operator auth runner** in `src/operator-auth.esm.js`
   - Runs stateless auth providers inline in the operator
   - Caches auth results (keyed by credential, TTL from auth result)
   - Returns `AuthResult` for use in routing decisions

2. **Integration in `src/operator-process.esm.js`** / `src/router-worker.esm.js`
   - Run operator auth before routing decision
   - Pass identity to router for role-based pool selection
   - Forward identity to responder with request metadata

3. **Role-based routing support** in `src/router-worker.esm.js`
   - Add `routeCondition` field support (evaluated after auth, before pool dispatch)
   - Support `requireRoles`, `requireIdentity`, `denyRoles` conditions

### Phase 4: Option C — Auth Service Process with Operator Caching

Implement the auth service process for network-dependent auth:

1. **Auth service process** in `src/auth-service-process.esm.js`
   - Unprivileged external process (like router-process)
   - Loads and runs auth provider modules
   - Communicates with operator via PipeTransport IPC
   - Supports network-dependent providers (OAuth, LDAP, session stores)

2. **Operator auth cache** in `src/operator-auth-cache.esm.js`
   - LRU cache with TTL-based eviction
   - Keyed by full credential string
   - Configurable max size
   - Invalidated on config reload

3. **Integration in `src/operator-process.esm.js`**
   - Check cache before dispatching to auth service
   - Dispatch to auth service on cache miss
   - Cache result and use identity for routing

### Phase 5: Tests and Documentation

- Unit tests for each auth provider
- Integration tests for auth middleware chain (all three options)
- E2E tests for authenticated routes
- E2E tests for role-based routing
- Mod-app development guide: using `identity` in mod-apps
- Administrator guide: choosing between Options A, C, and D

---

## 10. Configuration Schema

```slid
[(
  routes=[
    [
      path=/api/:*
      pool=standard

      /* Auth chain: providers run in order; first denial short-circuits */
      auth=[
        [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
        [provider=./auth/custom-roles.esm.js   roles=[user admin]]
      ]

      /* Optional: operator-level pre-flight (fast-path rejection) */
      preflight=[
        [check=require-header  header=authorization]
      ]

      /* Request filtering (inbound: client → mod-app) */
      requestFilter=[
        allowHeaders=[authorization content-type content-length accept x-request-id]
        allowCookies=[session_id csrf_token]
      ]

      /* Response filtering (outbound: mod-app → client) */
      responseFilter=[
        denyHeaders=[x-internal-* server]
        denyCookies=[internal_*]
      ]
    ]
  ]
)]
```

---

## 11. Security Considerations

- **Auth provider privilege depends on option**: Option A (responder-side) and Option C (auth service process) run auth code unprivileged. Option D (operator-embedded) runs auth code in the privileged operator process — only trusted, audited providers should be used there.
- **Provider modules must be trusted** — they are loaded from the filesystem and run with the permissions of the process that loads them. Administrators should audit provider code.
- **Secrets should not appear in config files** — use `:env:VAR_NAME` to load from environment variables.
- **Header filtering prevents header injection** — mod-apps cannot forge request headers that were filtered out inbound, and cannot set response headers that are filtered outbound.
- **Identity is injected by the server** — mod-apps cannot forge identity by sending a crafted `identity` field in the request body (the identity field is added by the operator or responder, not parsed from the request).
- **Auth failures return minimal information** — denial responses should not leak information about why the request was denied (e.g., "Unauthorized" not "Token expired").
- **Operator auth cache security**: The operator auth cache (Options C and D) must not be poisonable. Cache keys must be the full credential string (not a truncated or hashed version that could collide). Cache entries must respect TTL strictly.

---

## 12. Open Questions

1. **Should auth providers be allowed to modify the request body?** (e.g., decrypt an encrypted body before forwarding to mod-app).
   - **Resolved** NO. DEFINITELY NOT.
2. **Should auth results be cached?** (e.g., cache JWT verification results for the token's lifetime) — Yes, but cache invalidation is complex. Propose opt-in caching per provider.
   - **Resolved** Yes, opt-in caching per provider is likely to be critical for adequate performance.
3. **Should the operator pre-flight be mandatory or optional?**
   - **Resolved** Optional; most deployments won't need it.
4. **How should auth errors be logged?**
   - **Resolved** Auth failures should be logged at `warn` level with request ID and denial reason (but not the token/credential itself).
5. **Should there be a way for mod-apps to trigger re-authentication?** (e.g., return a 401 that causes the client to re-authenticate)
   - **Resolved** Mod-apps can already return 401; no special server support needed.
6. **Which option(s) should be implemented first?** — Option A (responder-side) is simplest and provides immediate value. Options C and D require more design work but are architecturally superior. Recommend implementing Option A first, then Option D (operator-embedded stateless auth), then Option C (auth service process).
   - **Resolved** Option D, then Option C
7. **Should the auth service process (Option C) use the same pool manager as responders?**
   - **Resolved** Yes, use the generic pool manager. The auth service pool would be a small, long-lived pool (similar to the router-process pool).
8. **How should the operator cache auth results for Option C?**
   - **Resolved** Cache keyed by token/credential string, with TTL from the auth result. LRU eviction for memory management. Cache size configurable. Invalidation on config reload.
9. **Should role-based routing use a separate `routeCondition` field, or extend the existing `auth` field?** — A separate `routeCondition` field (evaluated after auth, before pool dispatch) would be cleaner and more composable than embedding role checks in the auth chain.
   - **Resolved** Defer for future development.
10. **Should the auth service process be a single process or a pool?**
    - **Resolved** A pool is more resilient (one process failure doesn't block all auth). A small static pool (2–4 processes) is likely sufficient for most deployments.

---

[supplemental keywords: authentication, authorization, JWT, OAuth, API key, session, cookie, header filtering, middleware, auth provider, identity, access control, security, pluggable, modular, responder, pre-flight, rate limiting, RBAC, role-based access control, auth service process, operator cache, pre-routing auth, role-based routing, pool selection, process lifetime, cache efficiency, responder recycling]
