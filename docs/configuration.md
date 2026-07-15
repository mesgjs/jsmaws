# JSMAWS Configuration Reference

This document describes all configuration options for the JavaScript Modular Application Web Server (JSMAWS). Configuration is written in [SLID format](../arch/configuration.md) and stored in a `.slid` file (typically `jsmaws.slid`).

The configuration file is monitored for changes and reloaded automatically when modified.

## Table of Contents

1. [Configuration File Format](#configuration-file-format)
2. [Network Settings](#network-settings)
3. [SSL / TLS Settings](#ssl--tls-settings)
4. [Process Management](#process-management)
5. [Logging](#logging)
6. [Filesystem Settings](#filesystem-settings)
7. [Routing](#routing)
   - [Top-Level Routes](#top-level-routes)
   - [Route Properties](#route-properties)
   - [Path Syntax](#path-syntax)
   - [Method Values](#method-values)
   - [Route Groups](#route-groups)
   - [Host-Based Routing](#host-based-routing)
8. [Process Pools](#process-pools)
   - [Pool Parameters](#pool-parameters)
   - [Scaling Strategies](#scaling-strategies)
   - [Timeout Parameters](#timeout-parameters)
9. [Authentication](#authentication)
   - [Top-Level `authn`](#top-level-authn)
   - [Auth Pool (`authPool`)](#auth-pool-authpool)
   - [Built-in Auth Providers](#built-in-auth-providers)
   - [Route-Group and Route-Level Auth Filters](#route-group-and-route-level-auth-filters)
10. [Header and Cookie Filtering](#header-and-cookie-filtering)
11. [Environment and Secrets Injection](#environment-and-secrets-injection)
    - [Value Reference Syntax](#value-reference-syntax)
    - [KV Store Configuration](#kv-store-configuration)
    - [Mod-App Environment Injection (`appEnv`)](#mod-app-environment-injection-appenv)
12. [MIME Types](#mime-types)
13. [Chunking](#chunking)
14. [Complete Example](#complete-example)

---

## Configuration File Format

JSMAWS uses SLID format for its configuration file. The outermost container uses `[( )]` boundary markers:

```slid
[(
    /* Comments use C-style block syntax */
    key=value
    key2=[nested=value]
    arrayKey=[item1 item2 item3]
)]
```

Boolean values use `@t` (true) and `@f` (false). Strings containing spaces or special characters should be quoted.

Value references (`:scheme:reference`) allow secrets and environment variables to be injected at configuration load time. See [Value Reference Syntax](#value-reference-syntax).

---

## Network Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `hostname` | string | `localhost` | Hostname or IP address to bind to |
| `httpPort` | number | `80` | HTTP port (used for ACME challenges and HTTPS redirects) |
| `httpsPort` | number | `443` | HTTPS port |
| `noSSL` | boolean | `@f` | Set `@t` to run in HTTP-only mode (development/localhost) |

```slid
[(
    hostname=0.0.0.0
    httpPort=80
    httpsPort=443
    /* For development: */
    /* noSSL=@t */
    /* httpPort=8080 */
)]
```

---

## SSL / TLS Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `certFile` | string | — | Path to SSL certificate file (PEM format) |
| `keyFile` | string | — | Path to SSL private key file (PEM format) |
| `sslCheckIntervalHours` | number | `1` | How often (in hours) to check for certificate updates |
| `acmeChallengeDir` | string | — | Directory for Let's Encrypt ACME challenge files |

Both `certFile` and `keyFile` are required when `noSSL` is not set. The server monitors the certificate files for changes and reloads the HTTPS server automatically when they are updated (e.g., after certificate renewal by an external ACME client such as certbot).

```slid
[(
    certFile=/etc/letsencrypt/live/example.com/fullchain.pem
    keyFile=/etc/letsencrypt/live/example.com/privkey.pem
    sslCheckIntervalHours=1
    acmeChallengeDir=/var/www/acme-challenge
)]
```

---

## Process Management

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `uid` | number | — | Numeric user ID for sub-processes (required when running as root) |
| `gid` | number | — | Numeric group ID for sub-processes (required when running as root) |
| `shutdownDelay` | number | `30` | Graceful shutdown timeout in seconds |
| `shutdownSpread` | number | `0` | Deadline spread for graceful shutdown. When `>= 1`, the value is in seconds and is subtracted from the deadline at each successive layer (operator → responder → mod-app). When `0 < value < 1`, the value is treated as a fraction of `shutdownDelay` and converted to an integer number of seconds (minimum 1s). A spread of `0` means all layers share the same deadline (not ideal). |
| `healthCheckInterval` | number | `60` | Health check interval in seconds |

Sub-processes are spawned with the configured `uid`/`gid` for privilege separation. Numeric IDs are required (symbolic names are not supported). When running as root, both `uid` and `gid` must be configured.

```slid
[(
    uid=33      /* www-data on Debian/Ubuntu */
    gid=33
)]
```

---

## Logging

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `logLevel` | string | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `logDestination` | string | `console` | Log destination: `console` or `syslog` |
| `logFormat` | string | `apache` | Log format: `apache` |

```slid
[(
    logLevel=info
    logDestination=console
    logFormat=apache
)]
```

---

## Filesystem Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `root` | string | — | Filesystem root directory for static file serving (used by `@static` mod-app) |
| `appRoot` | string | — | Filesystem root directory for mod-app files (used when resolving relative `app` paths in routes) |
| `extensions` | array | `['.esm.js' '.js']` | File extensions to try when resolving filesystem-based routes (`@*` and `@name` path patterns) |
| `fsRouting` | boolean | `@f` | Enable filesystem-based routing (`@*` and `@name` path patterns); requires `appRoot` |

`root` and `appRoot` may be the same directory or different directories. Trailing slashes are optional — JSMAWS normalizes them internally.

`extensions` controls which file extensions are tried (in order) when resolving a filesystem route. The router verifies that the resolved path is a file (or a symlink resolving to a file), not a directory.

```slid
[(
    root=/var/www/html
    appRoot=/var/www/apps
    extensions=['.esm.js' '.js']
    fsRouting=@t
)]
```

---

## Routing

### Top-Level Routes

Routes are defined as an array under the `routes` key. Routes are checked in order; the first match wins.

```slid
[(
    routes=[
        [path=/api/:*  pool=standard  app=./apps/api.esm.js]
        [path=/static/:*  pool=fast  app=@static]
        [regex='^/.*'  response=404]
    ]
)]
```

Routes may also reference named route groups (see [Route Groups](#route-groups)):

```slid
routes=[
    [group=publicGroup]
    [group=adminGroup]
    [regex='^/.*'  response=404]
]
```

### Route Properties

| Property | Type | Description |
|----------|------|-------------|
| `path` | string | Path pattern to match (see [Path Syntax](#path-syntax)) |
| `regex` | string | Regular expression to match against the full pathname |
| `method` | string \| array | HTTP method filter (see [Method Values](#method-values)); default: `get` |
| `pool` | string | Name of the process pool to handle this route |
| `app` | string | Mod-app path, or `@static` for static file serving |
| `root` | string | Local filesystem root for this route (overrides global `root`) |
| `response` | number \| string | HTTP status code for a fixed response (no mod-app dispatched) |
| `href` | string | Redirect target URL (used with `response` for redirects) |
| `responseText` | string | Plain-text body for fixed-response routes (optional) |
| `headers` | object | Additional response headers for fixed-response routes (optional) |
| `authn` | string \| array | Route-level authn scalar filter (overrides group/top-level) |
| `role` | string \| array | Required role(s) for this route |
| `appEnv` | object | Route-level mod-app environment overrides (see [`appEnv`](#mod-app-environment-injection-appenv)) |
| `persistent` | boolean | Set `@t` to run the mod-app in a persistent, long-lived worker (overrides pool) |
| `reqTimeout` | number | Request timeout in seconds (overrides pool/global) |
| `idleTimeout` | number | Idle timeout between frames in seconds (overrides pool/global) |
| `conTimeout` | number | Connection lifetime timeout in seconds (overrides pool/global) |
| `maxChunkSize` | number | Maximum chunk size in bytes for this route (overrides pool/global) |

**Fixed-response routes** (with `response`) return a server-generated response without dispatching to a mod-app. The `responseText` and `headers` properties allow customizing the body and headers:

```slid
/* 404 with custom body */
[regex='^/.*'  response=404  responseText='Not Found']

/* 401 with WWW-Authenticate challenge header */
[path=/api/:*  authn=[@allow-all]  response=401  responseText=Unauthorized  headers=[www-authenticate='Basic realm="My App"']]

/* 301 redirect */
[path=/old/:*  response=301  href=/new/:*]
```

### Path Syntax

Path patterns are matched against the URL pathname. Segments are separated by `/`.

| Syntax | Description | Example |
|--------|-------------|---------|
| `literal` | Exact match for a path segment | `api`, `users` |
| `:name` | Named parameter (required) | `:id`, `:action` |
| `:?name` | Named parameter (optional) | `:?action` |
| `:*` | Tail wildcard — matches all remaining segments | |
| `@name` | Filesystem mod-app by name | `@myapp` |
| `@*` | Filesystem mod-app — any name from URL | |

Examples:

```slid
path=/api/users/:id          /* matches /api/users/123 */
path=/api/@*/:?action        /* filesystem route: any mod-app, optional action */
path=/static/:*              /* matches /static/anything/here */
```

### Method Values

The `method` property accepts a single value or an array:

| Value | HTTP Methods |
|-------|-------------|
| `any` | All methods |
| `read` | `GET`, `HEAD` |
| `write` | `PATCH`, `POST`, `PUT` |
| `modify` | `DELETE`, `PATCH`, `PUT` |
| `get`, `post`, `put`, `delete`, `patch`, `head`, `options` | Specific method |

```slid
method=read
method=[get post]
method=any
```

### Route Groups

Named, reusable routing groups are defined under `routeGroups`. A group reference in a route array uses `[group=groupName]`.

**Unqualified groups** are plain arrays of routes — top-level `authn` and filters apply:

```slid
routeGroups=[
    publicRoutes=[
        [path=/public/:*  pool=standard  app=./apps/public.esm.js]
        [path=/health  pool=fast  app=./apps/health.esm.js]
    ]
]
routes=[
    [group=publicRoutes]
]
```

**Qualified groups** are objects with a `routes` array and optional conditions:

| Property | Type | Description |
|----------|------|-------------|
| `routes` | array | Routes within this group |
| `incpre` | string \| array | Include only if pathname starts with any of these prefixes |
| `excpre` | string \| array | Exclude if pathname starts with any of these prefixes |
| `method` | string \| array | Include only if request method matches |
| `authn` | string \| array | Scalar authn filter for this group (overrides top-level) |
| `role` | string \| array | Required role(s) for routes in this group |
| `requestFilter` | object | Request header/cookie filter for this group (overrides top-level) |
| `responseFilter` | object | Response header/cookie filter for this group (overrides top-level) |

```slid
routeGroups=[
    adminGroup=[
        authn=[@allow-known @deny-all]
        role=admin
        incpre=/admin
        routes=[
            [path=/admin/:*  pool=standard  app=./apps/admin.esm.js]
        ]
    ]
]
```

Route-group routes may not contain nested group references.

### Host-Based Routing

For multi-host (SNI) deployments, use `hostRoutes` instead of top-level `routes`. The request hostname is used to select the route array.

```slid
[(
    hostRoutes=[
        example.com=[
            [path=/api/:*  pool=standard  app=./apps/api.esm.js]
            [path=/:*  pool=fast  app=@static]
        ]
        www.example.com=[alias=example.com]   /* alias: use example.com routes */
        *=[                                    /* default: no hostname match */
            [regex='^/.*'  response=404]
        ]
    ]
)]
```

| Property | Description |
|----------|-------------|
| `alias=name` | This hostname is an alias for `name`; use that host's routes |
| `*` | Wildcard/default entry used when no hostname matches |

`hostRoutes` and top-level `routes` are mutually exclusive. When `hostRoutes` is present, top-level `routes` is ignored.

---

## Process Pools

Pools are named, configurable groups of sub-processes. Routes reference pools by name. If no `pools` are defined, a default `standard` pool is created automatically.

```slid
[(
    pools=[
        fast=[
            minProcs=2
            maxProcs=10
            maxReqs=1000
            reqTimeout=5
        ]
        standard=[
            minProcs=1
            maxProcs=20
            maxReqs=100
            reqTimeout=60
            conTimeout=300
        ]
        stream=[
            minProcs=0
            maxProcs=50
            maxReqs=1
            reqTimeout=0
            idleTimeout=60
            conTimeout=3600
            resType=[stream bidi]
        ]
    ]
)]
```

### Pool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `minProcs` | number | `1` | Minimum number of processes (use `0` for `ondemand`) |
| `maxProcs` | number | `20` | Maximum number of processes |
| `minWorkers` | number | `1` | Minimum concurrent workers per process |
| `maxWorkers` | number | `4` | Maximum concurrent workers per process |
| `maxReqs` | number | — | Maximum requests per process before recycling (omit or `0` for unlimited) |
| `resType` | array | all | Allowed response types: `response`, `stream`, `bidi` |
| `persistent` | boolean | `@f` | Set `@t` to make all mod-apps running in this pool persistent (long-lived workers) |
| `maxWorkerReqs` | number | — | Maximum requests a persistent worker handles before being gracefully recycled (omit or `0` for unlimited) |
| `workerIdleTimeout` | number | — | Idle timeout in seconds before terminating an idle persistent worker (omit or `0` for unlimited) |
| `appEnv` | object | — | Pool-level mod-app environment values (see [`appEnv`](#mod-app-environment-injection-appenv)) |

**`resType`** restricts which response modes a pool accepts. Omit to allow all types. Examples:
- `resType=[response]` — regular responses only (no streaming or WebSocket)
- `resType=[stream bidi]` — streaming and bidirectional only (no regular responses)

**`maxReqs=1`** creates one-shot processes (each process handles exactly one request then exits). Combined with `maxWorkers=1`, this is the recommended configuration for WebSocket/streaming pools.

### Persistent Workers

When `persistent=@t` is configured for a pool (or a route), the responder process maintains a registry of persistent workers. Instead of spawning a new Web Worker for every request, idle persistent workers are kept alive and reused sequentially for subsequent requests.

* **`maxWorkerReqs`**: To mitigate potential memory leaks in long-running mod-apps, you can configure `maxWorkerReqs` (e.g., `10000`). The responder process will gracefully recycle the worker after it has handled the specified number of requests.
* **`workerIdleTimeout`**: To free up system resources during periods of low traffic, you can configure `workerIdleTimeout` (e.g., `300` for 5 minutes). Idle persistent workers that have not handled any requests for this duration will be terminated.

### Scaling Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| Normal | Scales between `minProcs` and `maxProcs` based on load | Variable workloads with baseline demand |
| On-Demand | Set `minProcs` to 0; spawns processes only when needed | Sporadic, low-frequency workloads |
| Static | Set `minProcs` equal to `maxProcs` | Predictable, consistent workloads |

Processes beyond `minProcs` exit after being idle for `idleTimeout` seconds (process idle timeout, not connection idle timeout).

### Timeout Parameters

All three timeout types can be configured at global, pool, and route levels. More-specific levels override less-specific ones (route > pool > global).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `reqTimeout` | `30` | Request processing timeout in seconds; `0` = disabled |
| `idleTimeout` | `0` | Idle timeout between frames in seconds (streaming/bidi only); `0` = disabled |
| `conTimeout` | `0` | Connection lifetime timeout in seconds (streaming/bidi only); `0` = disabled |

**Global timeout defaults** (lowest priority):

```slid
[(
    reqTimeout=30
    idleTimeout=0
    conTimeout=0
)]
```

**Pool-level overrides** (medium priority):

```slid
pools=[
    stream=[
        reqTimeout=0       /* no per-request timeout for streaming */
        idleTimeout=60     /* 60s idle between frames */
        conTimeout=3600    /* 1 hour max connection lifetime */
    ]
]
```

**Route-level overrides** (highest priority):

```slid
[path=/api/slow  pool=standard  reqTimeout=120]
```

### Router Pool (`routerPool`)

When `fsRouting` is enabled, JSMAWS can optionally delegate filesystem route resolution to a dedicated router sub-process pool. Router sub-processes run with reduced privilege and offload filesystem I/O from the operator process.

`routerPool` accepts standard [process pool parameters](#pool-parameters):

```slid
[(
    routerPool=[
        minProcs=1
        maxProcs=2
    ]
)]
```

When `routerPool` is not configured, filesystem routing runs inline in the operator process.

---

**Global chunk size** (used by PolyTransport for IPC):

| Key | Default | Description |
|-----|---------|-------------|
| `chunkSize` | `65536` | Maximum chunk size in bytes for IPC transport |

---

## Authentication

### Top-Level `authn`

The top-level `authn` key defines the site-level default authentication provider chain. Providers are evaluated in order before routing; evaluation stops at the first successful identification.

```slid
[(
    authn=[
        [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
        [provider=@api-key  header=x-api-key  keys=:env:API_KEYS]
    ]
)]
```

Each entry in the `authn` array is a provider configuration object with a `provider` key identifying the provider and any provider-specific configuration properties.

Provider return semantics:
- `null` — provider did not recognize this request (no credential, wrong type, expired); try next provider
- `{ allow: true, identity }` — provider successfully identified the caller; stop chain
- `{ allow: false, denyStatus, denyMessage }` — credential is structurally invalid or malicious; hard deny, stop chain

### Auth Pool (`authPool`)

For external authentication providers (OAuth introspection, session stores, LDAP), configure an `authPool` to run auth in a dedicated unprivileged sub-process. The operator caches results for efficiency.

`authPool` accepts standard [process pool parameters](#pool-parameters):

```slid
[(
    authPool=[
        minProcs=1
        maxProcs=4
    ]
)]
```

When `authPool` is configured:
- Initial operator-resident providers (`@jwt`, `@api-key`, `@basic`, `@test-identity`) run inline in the operator (fast path)
- Everything from the first external provider (custom paths, `@session`, `@oauth-is`, etc.) and beyond is delegated to an auth sub-process

When `authPool` is not configured, all providers run inline in the operator (without privilege reduction) as a fallback.

### Built-in Auth Providers

#### `@jwt` — JSON Web Token

Verifies JWT in the `Authorization: Bearer` header, or in a named cookie when `cookie` is configured.

| Property | Default | Description |
|----------|---------|-------------|
| `provider` | — | `@jwt` |
| `secret` | — | HMAC signing secret (for HS256/HS384/HS512) |
| `publicKey` | — | RSA public key in PEM format (for RS256/RS384/RS512) |
| `algorithm` | `HS256` | JWT algorithm: `HS256`, `HS384`, `HS512`, `RS256`, `RS384`, `RS512` |
| `claimsField` | `roles` | JWT claim field containing the user's roles |
| `cookie` | — | Cookie name to read the JWT from; if set, the `Authorization` header is ignored |

```slid
/* JWT from Authorization: Bearer header (default) */
authn=[
    [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
]

/* JWT from a named cookie */
authn=[
    [provider=@jwt  secret=:env:JWT_SECRET  cookie=auth_token]
]
```

#### `@api-key` — API Key

Verifies an API key from a configurable request header.

| Property | Default | Description |
|----------|---------|-------------|
| `provider` | — | `@api-key` |
| `header` | `x-api-key` | Header name to read the key from |
| `keys` | — | Comma-separated list of valid keys, or array |
| `keyMap` | — | JSON object mapping key → subject (optional; if provided, `keys` is ignored) |

```slid
authn=[
    [provider=@api-key  header=x-api-key  keys=:env:API_KEYS]
]
```

When `keyMap` is provided, the subject is looked up from the map. When only `keys` is provided, the subject is the key itself.

#### `@basic` — HTTP Basic Authentication

Verifies `Authorization: Basic` credentials.

| Property | Default | Description |
|----------|---------|-------------|
| `provider` | — | `@basic` |
| `users` | — | User credentials: JSON object `{"user":"pass"}`, or comma-separated `user:pass` pairs |
| `base64` | `@f` | Set `@t` if passwords in `users` are base64-encoded |

```slid
authn=[
    [provider=@basic  users=:env:BASIC_AUTH_USERS]
]
```

> **Note:** `WWW-Authenticate` challenge headers are technically a mod-app concern, not a JSMAWS concern, but you can use a `response=401` route with `headers=[www-authenticate='Basic realm="My App"']` to send the challenge directly from the configuration.

#### `@test-identity` — Development/Testing

Always succeeds, injecting a configurable identity. **For development and testing only.**

| Property | Default | Description |
|----------|---------|-------------|
| `provider` | — | `@test-identity` |
| `identity` | — | Identity to inject: `[sub=dev-user  roles=[admin]]` |

```slid
authn=[
    [provider=@test-identity  identity=[sub=dev-user  roles=[admin user]]]
]
```

### Route-Group and Route-Level Auth Filters

Route groups and individual routes can carry scalar `authn` filters and `role` checks that override the top-level default. These are evaluated *before* path matching.

**Scalar `authn` filter values** (evaluated in order until one matches):

| Value | Behavior |
|-------|----------|
| `@allow-known` | Matches if a non-empty identity is present; identity is presented |
| `@allow-all` | Always matches; identity is suppressed (null to routes in the group) |
| `@deny-all` | Always matches; route/group is skipped |
| `providerName` | Matches if the active identity's provider equals this value; identity is presented |

An implied `[@allow-known @allow-all]` is appended to the end of every filter (not reached if there is an explicit `@allow-all` or `@deny-all`).

**`role`** checks are always performed if present. A null or suppressed identity causes the route/group to be skipped (resulting in 404).

```slid
routeGroups=[
    /* Only authenticated users with 'admin' role */
    adminGroup=[
        authn=[@allow-known @deny-all]
        role=admin
        routes=[
            [path=/admin/:*  pool=standard  app=./apps/admin.esm.js]
        ]
    ]
    /* Challenge unauthenticated users */
    challengeGroup=[
        authn=[@allow-all]
        routes=[
            [path=/admin/:*  response=401  responseText=Unauthorized  headers=[www-authenticate='Basic realm="Admin"']]
        ]
    ]
]
routes=[
    [group=adminGroup]
    [group=challengeGroup]
]
```

The same pattern can be expressed more concisely with route-level `authn`:

```slid
routes=[
    [path=/admin/:*  authn=[@allow-known @deny-all]  role=admin  pool=standard  app=./apps/admin.esm.js]
    [path=/admin/:*  authn=[@allow-all]  response=401  responseText=Unauthorized  headers=[www-authenticate='Basic realm="Admin"']]
]
```

---

## Header and Cookie Filtering

Request and response headers/cookies can be filtered at the top level (default) or at the route-group level (override). Filtering is independent of authentication.

> **Filtering runs after auth, before mod-app dispatch.** Authentication providers always receive the original, unfiltered request headers. `requestFilter` controls what the mod-app sees — not what the auth layer sees. This means you can safely omit `authorization` (or any other credential header) from `allowHeaders` to prevent mod-apps from accessing raw credentials; auth will still work correctly. The authenticated identity is passed to the mod-app separately via `JSMAWS.request.identity`.

**Top-level (default) filters:**

```slid
[(
    requestFilter=[
        allowHeaders=[authorization content-type content-length accept x-request-id]
        allowCookies=[session_id csrf_token]
    ]
    responseFilter=[
        denyHeaders=[x-internal-* server x-powered-by]
        denyCookies=[internal_*]
    ]
)]
```

**Route-group-level filters** (override top-level for routes in that group):

```slid
routeGroups=[
    apiGroup=[
        requestFilter=[
            allowHeaders=[authorization content-type x-api-key]
        ]
        responseFilter=[
            denyHeaders=[set-cookie]
        ]
        routes=[...]
    ]
]
```

### Filter Properties

Both `requestFilter` and `responseFilter` accept the same properties:

| Property | Description |
|----------|-------------|
| `allowHeaders` | Allowlist: only listed headers pass through |
| `denyHeaders` | Denylist: all headers except listed ones pass through |
| `allowCookies` | Allowlist: only listed cookies pass through |
| `denyCookies` | Denylist: all cookies except listed ones pass through |

- Header filtering is case-insensitive; cookie filtering is case-sensitive.
- Patterns support simple wildcards: `x-internal-*` matches `x-internal-foo`, `x-internal-bar`, etc.
- When both `allow*` and `deny*` are specified, the allowlist takes precedence; deny further restricts.
- When neither is specified, all headers/cookies pass through (default, backward compatible).

---

## Environment and Secrets Injection

### Value Reference Syntax

Any configuration value can be a **value reference** of the form `:scheme:reference`. Value references are resolved by the operator at startup and on config reload. Resolved values are never logged.

| Scheme | Syntax | Description |
|--------|--------|-------------|
| `:env:` | `:env:VAR_NAME` | OS environment variable |
| `:file:` | `:file:/path/to/file` | Contents of a file (trimmed); relative paths resolved from config file directory |
| `:kv:` | `:kv:key` or `:kv:namespace/key` | Default Deno KV store entry |
| `:kv.name:` | `:kv.storeName:namespace/key` | Named KV store entry |
| `::` | `::literal-value` | Literal string (escape for values starting with `:`) |
| `:delete:` | `:delete:` | Delete a key inherited from a broader `appEnv` scope |

```slid
authn=[
    [provider=@jwt  secret=:env:JWT_SECRET]
    [provider=@basic  users=:file:/run/secrets/basic-users]
]
```

If a value reference cannot be resolved (missing env var, missing file), the server logs an error and the dependent module receives `undefined`.

### KV Store Configuration

Configure Deno KV stores for use with `:kv:` references:

```slid
[(
    /* Single default store */
    kvStore=/var/lib/jsmaws/secrets.db

    /* Or multiple named stores */
    kvStores=[
        default=/var/lib/jsmaws/secrets.db
        production=https://api.deno.com/databases/...
    ]
)]
```

`kvStore=path` is shorthand for `kvStores=[default=path]`.

### Mod-App Environment Injection (`appEnv`)

The `appEnv` block defines key-value pairs to inject into mod-app workers as `globalThis.JSMAWS.env`. It can appear at the global, pool, or route level. Values are merged with more-specific scopes overriding less-specific ones (route > pool > global).

All injected values are **strings**. Mod-apps must parse numeric or boolean values as needed.

**Global-level `appEnv`** (injected into all mod-apps unless overridden):

```slid
[(
    appEnv=[
        appVersion=:env:APP_VERSION
        publicApiUrl=https://api.example.com/v1
        featureNewUI=:env:FEATURE_NEW_UI
    ]
)]
```

**Pool-level `appEnv`** (merged with global; overrides or deletes global values for this pool):

```slid
pools=[
    standard=[
        appEnv=[
            publicApiUrl=https://api.example.com/v2   /* override global */
            featureNewUI=:delete:                     /* remove from this pool */
        ]
    ]
]
```

**Route-level `appEnv`** (highest priority; merged with pool and global):

```slid
routes=[
    [
        path=/api/payments/:*
        pool=standard
        appEnv=[
            stripePublishableKey=:env:STRIPE_PUBLISHABLE_KEY
            maxRetries=3
        ]
    ]
]
```

**Merge rules:**
- `*=:delete:` clears all accumulated keys before processing other entries in the block
  - Always processed first when present (regardless of visual position)
- `:delete:` on a specific key removes it from the merged result
  - Do not `:delete:` specific keys you intend to override
- All other values override or add keys

**Accessing injected values in mod-apps:**

```javascript
const { publicApiUrl, appVersion } = globalThis.JSMAWS.env;
const maxRetries = parseInt(globalThis.JSMAWS.env.maxRetries ?? '3', 10);
```

`globalThis.JSMAWS.env` is always a frozen plain object (never `null`). All values are strings.

---

## MIME Types

The `mimeTypes` object maps file extensions to MIME type strings. Used by the `@static` mod-app for static file serving. First match wins — longer suffixes should appear first.

```slid
[(
    mimeTypes=[
        '.html'=text/html
        '.htm'=text/html
        '.js'=text/javascript
        '.mjs'=text/javascript
        '.json'=application/json
        '.css'=text/css
        '.txt'=text/plain
        '.png'=image/png
        '.jpg'=image/jpeg
        '.jpeg'=image/jpeg
        '.gif'=image/gif
        '.svg'=image/svg+xml
        '.woff2'=font/woff2
        '.woff'=font/woff
    ]
)]
```

---

## Chunking

The `chunkSize` parameter controls the maximum chunk size (in bytes) used by the PolyTransport IPC layer. This is the only chunking parameter retained after the PolyTransport refactoring.

| Key | Default | Description |
|-----|---------|-------------|
| `chunkSize` | `65536` | Maximum chunk size in bytes for IPC transport (global default) |

`chunkSize` can also be set at the pool level (in `pools.[name].maxChunkSize`) or at the route level (`maxChunkSize`). The hierarchy is route > pool > global.

---

## Complete Example

```slid
[(
    /* ── Network ─────────────────────────────────────────────── */
    hostname=0.0.0.0
    httpPort=80
    httpsPort=443

    /* ── SSL ─────────────────────────────────────────────────── */
    certFile=/etc/letsencrypt/live/example.com/fullchain.pem
    keyFile=/etc/letsencrypt/live/example.com/privkey.pem
    sslCheckIntervalHours=1
    acmeChallengeDir=/var/www/acme-challenge

    /* ── Process Management ──────────────────────────────────── */
    uid=33
    gid=33
    shutdownDelay=30
    shutdownSpread=0.1

    /* ── Logging ─────────────────────────────────────────────── */
    logLevel=info
    logDestination=console
    logFormat=apache

    /* ── Filesystem Settings ─────────────────────────────────── */
    root=/var/www/html
    appRoot=/var/www/apps
    /* extensions=['.esm.js' '.js'] */   /* default */
    /* fsRouting=@t */                   /* enable filesystem-based routing */

    /* ── MIME Types ──────────────────────────────────────────── */
    mimeTypes=[
        '.html'=text/html
        '.js'=text/javascript
        '.json'=application/json
        '.css'=text/css
        '.txt'=text/plain
        '.png'=image/png
        '.jpg'=image/jpeg
        '.svg'=image/svg+xml
        '.woff2'=font/woff2
    ]

    /* ── Global Timeouts ─────────────────────────────────────── */
    reqTimeout=30
    idleTimeout=0
    conTimeout=0

    /* ── Global Mod-App Environment ──────────────────────────── */
    appEnv=[
        appVersion=:env:APP_VERSION
        publicApiUrl=https://api.example.com/v1
    ]

    /* ── Authentication ──────────────────────────────────────── */
    authn=[
        [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
        [provider=@api-key  header=x-api-key  keys=:env:API_KEYS]
    ]

    /* ── Auth Sub-Process Pool (for external providers) ──────── */
    /* authPool=[minProcs=1  maxProcs=4] */

    /* ── Default Header Filtering ────────────────────────────── */
    requestFilter=[
        allowHeaders=[authorization content-type content-length accept x-request-id x-api-key]
    ]
    responseFilter=[
        denyHeaders=[x-internal-* server x-powered-by]
    ]

    /* ── Process Pools ───────────────────────────────────────── */
    pools=[
        /* Fast pool: short-duration, high-frequency requests */
        fast=[
            minProcs=2
            maxProcs=10
            maxWorkers=8
            maxReqs=1000
            reqTimeout=5
        ]

        /* Standard pool: general application requests */
        standard=[
            minProcs=1
            maxProcs=20
            maxWorkers=4
            maxReqs=100
            reqTimeout=60
            conTimeout=300
        ]

        /* Stream pool: WebSocket and SSE connections */
        stream=[
            minProcs=0
            maxProcs=50
            maxWorkers=1
            maxReqs=1
            reqTimeout=0
            idleTimeout=60
            conTimeout=3600
            resType=[stream bidi]
        ]
    ]

    /* ── Route Groups ────────────────────────────────────────── */
    routeGroups=[
        /* Protected API: requires authentication */
        protectedApi=[
            authn=[@allow-known @deny-all]
            routes=[
                [path=/api/:*  pool=standard  app=./apps/api.esm.js]
            ]
        ]
        /* Challenge unauthenticated API requests */
        apiChallenge=[
            authn=[@allow-all]
            routes=[
                [path=/api/:*  response=401  responseText=Unauthorized  headers=[www-authenticate='Bearer realm="API"']]
            ]
        ]
    ]

    /* ── Routes ──────────────────────────────────────────────── */
    routes=[
        /* Static files */
        [path=/static/:*  pool=fast  app=@static  method=read]

        /* Protected API routes */
        [group=protectedApi]
        [group=apiChallenge]

        /* WebSocket connections */
        [path=/ws/:*  pool=stream  app=./apps/ws.esm.js  method=any]

        /* Catch-all 404 */
        [regex='^/.*'  response=404]
    ]
)]
```

---

## See Also

- [`arch/pool-configuration-design.md`](../arch/pool-configuration-design.md) — Pool configuration specification and design
- [`arch/auth-api-design.md`](../arch/auth-api-design.md) — Authentication and authorization API design
- [`arch/auth-revisions-20260510.md`](../arch/auth-revisions-20260510.md) — Auth model revisions: `hostRoutes`, `routeGroups`, route-level `authn`/`role`
- [`arch/env-secrets-design.md`](../arch/env-secrets-design.md) — Environment and secrets injection design
- [`arch/jsmaws-config-example.md`](../arch/jsmaws-config-example.md) — Additional configuration examples
- [`examples/jsmaws-examples.slid`](../examples/jsmaws-examples.slid) — Example configuration with example apps
