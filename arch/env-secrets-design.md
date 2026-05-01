# JSMAWS Environment and Secrets Injection Design

**Status:** [DRAFT]  
**Date:** 2026-04-29  

---

## 1. Problem Statement

Both the auth API design ([`arch/auth-api-design.md`](auth-api-design.md)) and the data access API design ([`arch/data-access-api-design.md`](data-access-api-design.md)) require a mechanism for supplying credentials, API keys, and other sensitive values to modules and applets. Previously (since updated), the `env:VAR_NAME` shorthand appeared informally in those documents (e.g., `secret=env:JWT_SECRET`, `password=env:DB_PASSWORD`) without a formal specification.

This document formalizes that pattern into a **general-purpose value-resolver system** with:

1. **Multiple source schemes** — `:env:`, `:kv:`, `:file:`, `:secret:`, and `::` (empty scheme = literal, the default).
2. **Server-side resolution** — Secrets are resolved by the operator (typically, or possibly by the responder) before being passed to auth providers, data-source adapters, and other server-side modules. Applet code never sees raw credentials.
3. **Applet-side injection** — A filtered, explicitly-enumerated set of resolved values can be injected into applet workers at request time, enabling applets to receive feature flags, tenant IDs, public API endpoints, public keys (or even sensitive values such as private keys when the administrator explicitly chooses to inject them) without hard-coding them.
4. **Scope-based merging** — Applet environment values are defined at global, pool, and route levels and merged, with more-specific scopes overriding less-specific ones.

---

## 2. Design Principles

1. **Least privilege**: Applets receive only the values they are explicitly granted. Server-side secrets (DB passwords, JWT signing keys) are never injected into applet workers unless explicitly configured.
2. **Scheme-based extensibility**: New value sources can be added without changing the configuration syntax.
3. **Consistent syntax**: The same `:scheme:reference` syntax is used everywhere a "resolved value" is needed — in auth provider config, data source config, and applet injection definitions.
4. **Operator-side resolution**: All scheme resolution happens in the operator or responder process (privileged or semi-privileged), never inside the sandboxed applet worker.
5. **Explicit applet injection required**: Values resolved for server-side use (e.g., DB passwords) are not automatically available to applets. A separate `appEnv` block at the route/pool/global level must explicitly define what applets may receive.
6. **Mesgjs-compatible**: The API is expressible in SLID configuration and plain JavaScript.

---

## 3. Value Reference Syntax

A **value reference** is a string of the form:

```
:scheme:reference
```

Where `:scheme:` (with both leading and trailing colons) identifies the source and `reference` is the source-specific locator. The empty scheme `::` (two colons with nothing between them) means the reference is a literal string value.

For schemes that support multiple named instances, a **selector** can be specified:

```
:scheme.selector:reference
```

Where `selector` names the specific instance (e.g., a named KV store). The selector `default` is used when no selector is specified.

### 3.1 Supported Schemes

| Scheme | Syntax | Description |
|--------|--------|-------------|
| `:env:` | `:env:VAR_NAME` | OS environment variable |
| `:kv:` | `:kv:key` or `:kv:namespace/key` | Default KV store entry |
| `:kv.selector:` | `:kv.storeName:namespace/key` | Named KV store entry |
| `:file:` | `:file:/absolute/path` or `:file:relative/path` | Contents of a file (trimmed) |
| `:secret:` | `:secret:name` | Default secrets store entry (future; see §3.7) |
| `:secret.selector:` | `:secret.storeName:name` | Named secrets store entry (future) |
| `:delete:` | `:delete:` | Delete a key inherited from a broader `appEnv` scope (see §3.6) |
| `::` | `::value` | Literal string value (empty scheme = literal) |

**In particular:**
- `::` (nothing after the second colon) evaluates to the empty string `""`.
- `:::` evaluates to the literal string `":"` (a single colon).
- Any string that does not begin with `:` is treated as a plain configuration value (not a value reference) and is used as-is.

### 3.2 `:env:` — OS Environment Variable

```slid
secret=:env:JWT_SECRET
password=:env:DB_PASSWORD
apiKey=:env:STRIPE_SECRET_KEY
```

- Reads the named environment variable from the operator process's environment at startup (or on config reload).
- If the variable is not set, the server logs a warning and the value is `undefined`.
- Variable names are case-sensitive on POSIX systems.

### 3.3 `:kv:` — Deno KV Store

```slid
secret=:kv:secrets/jwt-signing-key
apiKey=:kv:api-keys/stripe

/* Named KV store (see kvStores configuration) */
secret=:kv.production:secrets/jwt-signing-key
```

- Reads a value from the Deno KV store configured for the operator.
- The key path uses `/` as a separator, which maps to a KV key array: `:kv:secrets/jwt-signing-key` → `['secrets', 'jwt-signing-key']`.
- KV values are read at startup and cached. A `kv-reload` signal (or config reload) re-reads all KV-sourced values.
- Multiple KV stores can be configured using `kvStores` (see §7.1). The selector (`:kv.storeName:`) identifies which store to use; `:kv:` (no selector) uses the `default` store.

### 3.4 `:file:` — File Contents

```slid
secret=:file:/run/secrets/jwt-signing-key
certificate=:file:/etc/ssl/certs/my-cert.pem
```

- Reads the entire contents of the specified file.
- Relative paths are resolved relative to the `jsmaws.slid` configuration file's directory.
- Files are read at startup and cached. A config reload re-reads all file-sourced values.
- Useful for Docker secrets (`/run/secrets/...`) and similar patterns.

### 3.5 `::` — Literal Value (Empty Scheme / Escape)

```slid
/* Escape a value that starts with ':' so it is not misinterpreted as a scheme reference */
colonPrefixedValue=:::my-value-starting-with-colon

/* Inject an explicit empty string */
emptyValue=::
```

- The empty scheme `::` treats everything after the second colon as a literal string value.
- Its primary use is as an **escape** for values that begin with `:` and would otherwise be misinterpreted as a scheme reference.
- `::` (nothing after the second colon) evaluates to the empty string `""`.
- `:::` evaluates to the literal string `":"` (a single colon), and `::::value` evaluates to `"::value"`, etc.
- Plain strings that do not begin with `:` are treated as literal values and do **not** require the `::` prefix. Prefer plain strings for readability.
- **Note**: `::` injects an empty string — it does **not** delete a key inherited from a broader `appEnv` scope. Use `:delete:` for deletion (see §3.6).

### 3.6 `:delete:` — Delete Inherited `appEnv` Key

```slid
appEnv=[
  /* Delete a specific key that was set at a broader (global or pool) scope */
  featureNewUI=:delete:

  /* Wildcard: delete ALL keys inherited so far, then start fresh.
     *=:delete: is always processed first within a scope block,
     regardless of its visual position. */
  *=:delete:
  newKey=newValue
]
```

- The `:delete:` scheme removes a key from the merged `appEnv` result. The reference portion (after the second colon) is ignored and typically omitted.
- Only meaningful in `appEnv` blocks. Using `:delete:` outside of `appEnv` (e.g., in `dataSources` or `auth`) is an error.
- Allows a more-specific scope (pool or route) to suppress a value defined at a broader scope (global or pool), without injecting any value in its place.
- Distinct from `::` (which injects an empty string) — `:delete:` causes the key to be absent from `globalThis.JSMAWS.env` entirely unless a more-specific value is provided.
- **Wildcard reset**: The special key `*=:delete:` deletes **all** keys accumulated so far in the merge. It is always processed first within its scope block, regardless of its visual position. Keys defined in the same `appEnv` block (other than `*=:delete:` itself), or in more-specific scopes, are applied normally after the reset.

### 3.7 `:secret:` — Named Secrets Store (Future)

```slid
apiKey=:secret:stripe-production-key

/* Named secrets store */
apiKey=:secret.vault:stripe-production-key
```

- Reserved for future integration with external secrets managers (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, etc.).
- Multiple secrets stores can be configured using `secretsStores` (see §7.1). The selector (`:secret.storeName:`) identifies which store to use; `:secret:` (no selector) uses the `default` store.
- Not implemented in the initial version; `:secret:` (like any other unimplemented scheme) generates a configuration error.

---

## 4. Server-Side Resolution

### 4.1 Where Resolution Happens

Value references are resolved by the **operator process** at startup and on config reload. Resolved values are:

- Passed to auth provider modules (in the operator or responder, depending on the auth option chosen).
- Passed to data source adapter `init()` calls (in the responder process).
- Stored in the resolved configuration object — **never serialized back to SLID or logged**.

The responder process receives resolved values via IPC from the operator (as part of the configuration update message). The responder does **not** re-resolve references; it receives already-resolved values.

### 4.2 Resolution Timing

| Event | Action |
|-------|--------|
| Server startup | All value references in the configuration are resolved |
| Config file reload (SIGHUP or file change) | All value references are re-resolved |
| `kv-reload` signal (future) | KV-sourced values are re-read |

### 4.3 Resolution Errors

If a value reference cannot be resolved (missing env var, missing file, KV key not found):

- The server logs an error at `error` level, including the scheme and reference (but **not** the resolved value).
- The dependent module (auth provider, data source adapter) receives `undefined` for that value.
- The module's `init()` call is expected to throw, which causes the server to log the failure and refuse to start (or, on reload, to retain the previous configuration).

### 4.4 Security: No Logging of Resolved Values

Resolved secret values must **never** appear in:
- Log output (any level)
- IPC messages (beyond the encrypted/trusted operator ↔ responder channel)
- Error messages returned to clients
- Diagnostic output

The configuration system must treat any value resolved from `:env:`, `:kv:`, `:file:`, or `:secret:` as sensitive and redact it in any serialization or logging context.

---

## 5. Applet-Side Injection

### 5.1 Motivation

Applets sometimes need configuration values that are environment-specific:
- Feature flags (`featureNewUI=true`)
- Public API endpoints (`paymentApiUrl=https://api.stripe.com/v1`)
- Tenant identifiers (`tenantId=acme-corp`)
- API keys — both public/publishable keys and, when the administrator explicitly chooses, private/secret keys

These values should not be hard-coded in applet source files. The env/secrets system provides a controlled injection mechanism via the `appEnv` configuration block.

As the sensitivity-level of any particular value often cannot be determined solely from the source, it is the user's responsibility to make sure only the necessary information is approved for applet environment injection.

### 5.2 `appEnv` Block

The `appEnv` block defines key-value pairs to inject into applet workers. It can appear at the global, pool, or route level. Values at different scopes are **merged**, with more-specific scopes overriding less-specific ones (route > pool > global).

Each key in `appEnv` maps to a value reference (or a plain string). The resolved value is injected into the applet worker as `globalThis.JSMAWS.env[key]`.

To **delete** a value inherited from a broader scope, set the key to `:delete:`. A deleted key will not appear in `globalThis.JSMAWS.env` (unless explicitly added back in the current or a more specific scope).

### 5.3 Configuration Syntax

#### Global-Level `appEnv`

```slid
[(
  /* Values injected into all applets (unless overridden or deleted at pool/route level) */
  appEnv=[
    appVersion=:env:APP_VERSION
    featureNewUI=:env:FEATURE_NEW_UI
    publicApiUrl=https://api.example.com/v1
  ]
)]
```

#### Pool-Level `appEnv`

```slid
pools=[
  standard=[
    minProcs=1
    maxProcs=20
    /* Merge with global appEnv; override or add values for this pool */
    appEnv=[
      /* Override global value for this pool */
      publicApiUrl=https://api.example.com/v2
      /* Delete a specific global value so it is not injected for this pool */
      featureNewUI=:delete:
    ]
  ]
  restricted=[
    minProcs=1
    maxProcs=5
    /* Discard ALL global appEnv values; inject only what this pool defines */
    appEnv=[
      *=:delete:
      safeMode=true
    ]
  ]
]
```

#### Route-Level `appEnv` (Highest Priority)

```slid
routes=[
  [
    path=/api/payments/:*
    pool=standard
    /* Merge with pool appEnv (which merged with global); route values take highest priority */
    appEnv=[
      stripePublishableKey=:env:STRIPE_PUBLISHABLE_KEY
      maxRetries=3
      tenantId=acme-corp
    ]
  ]
]
```

### 5.4 Merge Semantics

The effective `appEnv` for a request is computed by merging the global, pool, and route `appEnv` blocks in order:

1. Start with the global `appEnv` (if any).
2. Merge the pool's `appEnv` on top:
   - If the pool's `appEnv` contains `*=:delete:`, all keys accumulated so far are cleared before processing the remaining entries in the pool's block.
   - Other `:delete:` entries remove the named key.
   - All other entries override or add keys.
3. Merge the route's `appEnv` on top (same rules as step 2, applied to the result of step 2).

The result is the set of key-value pairs injected into the applet worker as `setupData.appEnv`.

**Example merge:**

| Key | Global | Pool (standard) | Route (/api/payments) | Effective |
|-----|--------|-----------------|----------------------|-----------|
| `appVersion` | `:env:APP_VERSION` → `"2.3.1"` | _(not set)_ | _(not set)_ | `"2.3.1"` |
| `featureNewUI` | `:env:FEATURE_NEW_UI` → `"true"` | `:delete:` | _(not set)_ | _(not injected)_ |
| `publicApiUrl` | `https://api.example.com/v1` | `https://api.example.com/v2` | _(not set)_ | `"https://api.example.com/v2"` |
| `stripePublishableKey` | _(not set)_ | _(not set)_ | `:env:STRIPE_PUBLISHABLE_KEY` → `"pk_live_..."` | `"pk_live_..."` |
| `maxRetries` | _(not set)_ | _(not set)_ | `3` | `"3"` |

### 5.5 Injection Mechanics

At request dispatch time, the responder assembles the `setupData` object sent to the applet worker's bootstrap. The effective `appEnv` (after merging) is included as `setupData.appEnv`:

```javascript
// setupData received by bootstrap.esm.js
{
    appPath: '/var/www/apps/payments.esm.js',
    maxChunkSize: 65536,
    dataSources: ['db', 'paymentApi'],
    appEnv: {
        appVersion: '2.3.1',
        publicApiUrl: 'https://api.example.com/v2',
        stripePublishableKey: 'pk_live_...',
        maxRetries: '3',
        tenantId: 'acme-corp',
    },
    // ... other setup fields
}
```

The bootstrap exposes the injected values via `globalThis.JSMAWS.env`:

```javascript
// In bootstrap.esm.js (addition):
jsmawsNamespace.env = Object.freeze(setupData.appEnv ?? {});
```

Applet code accesses injected values via:

```javascript
export default async function (_setupData) {
    const { publicApiUrl, appVersion } = globalThis.JSMAWS.env;
    // ...
}
```

### 5.6 Value Types

All injected values are **strings** in `globalThis.JSMAWS.env`. SLID configuration values may be non-string types (numbers, booleans via `@t`/`@f`, etc.), so the `appEnv` assembly step **coerces all values to strings** using JavaScript's standard `String()` conversion before including them in `setupData.appEnv`. Applets that need numeric or boolean values must parse them:

```javascript
const maxRetries = parseInt(globalThis.JSMAWS.env.maxRetries ?? '3', 10);
const featureEnabled = globalThis.JSMAWS.env.featureNewUI === 'true';
```

This is intentional: it keeps the applet API simple and consistent (always strings), while allowing administrators to use natural SLID types in configuration without needing to quote everything.

### 5.7 Security Constraints on Injection

The following constraints apply to applet-side injection:

1. **No values injected by default**: While any value can be injected into an applet worker, none are ever injected automatically. Values must be explicitly listed in an `appEnv` block at an appropriate scope to be injected.

2. **Injection is one-way and read-only**: Applets cannot write to the env namespace (`globalThis.JSMAWS.env` is frozen). This particular feature deliberately omits any provision for sending values in the opposite direction (*from* applets).

3. **No cross-route leakage**: Each request's `setupData.appEnv` is assembled fresh from the effective merged `appEnv` for that route. An applet cannot access values from a different route's `appEnv`.

---

## 6. Value Resolver Architecture

### 6.1 Component: `ValueResolver`

A new module `src/value-resolver.esm.js` implements the resolution logic:

```javascript
// Conceptual interface
class ValueResolver {
    constructor (config) { ... }

    /**
     * Resolve a single value reference.
     * @param {string} ref - Value reference (e.g., ':env:JWT_SECRET', ':file:/run/secrets/key')
     * @returns {Promise<string|undefined>} Resolved value, or undefined if not found
     */
    async resolve (ref) { ... }

    /**
     * Resolve all value references in a plain object (recursively).
     * Strings matching ':scheme:reference' are replaced with resolved values.
     * Non-string values are passed through unchanged.
     * @param {Object} obj - Object to resolve
     * @returns {Promise<Object>} New object with all references resolved
     */
    async resolveObject (obj) { ... }

    /**
     * Reload all cached values (env vars re-read, files re-read, KV re-fetched).
     */
    async reload () { ... }
}
```

### 6.2 Integration Points

| Integration Point | How Value Resolver Is Used |
|---|---|
| `src/configuration.esm.js` | `Configuration.updateConfig()` calls `valueResolver.resolveObject(rawConfig)` to produce a resolved config object; `getEffectiveAppEnv(routeSpec, poolName)` merges, resolves, and coerces `appEnv` blocks to string values |
| `src/operator-process.esm.js` | Holds the `ValueResolver` instance; passes resolved config to responders via IPC |
| `src/responder-process.esm.js` | Receives already-resolved config from operator; calls `config.getEffectiveAppEnv()` when assembling `setupData` |
| `src/applets/bootstrap.esm.js` | Reads `setupData.appEnv` and exposes as `globalThis.JSMAWS.env` |

### 6.3 Resolved Configuration

The `Configuration` class maintains a single representation:

- **Resolved config** (`config.config`): The resolved object with actual values (e.g., `{ secret: 'my-actual-secret' }`). Used for all runtime access.

Raw (unresolved) configuration is **not retained** after resolution. Config reload is triggered by file-level change detection (via `Deno.watchFs` in `src/config-monitor.esm.js`), not by comparing parsed config objects. IPC uses JSON serialization of the resolved config.

### 6.4 KV Store Lifecycle

The KV store (for `:kv:` references) is opened once by the operator at startup:

```javascript
// In operator-process.esm.js
const kvStores = {};
for (const [name, path] of Object.entries(this.config.kvStores ?? {})) {
    kvStores[name] = await Deno.openKv(path);
}
```

The `ValueResolver` holds references to the open KV stores and uses them for all `:kv:` and `:kv.selector:` resolutions. KV stores are closed when the operator shuts down.

---

## 7. Configuration Schema

### 7.1 Global Configuration

```slid
[(
  /* Optional: KV store(s) for :kv: references */
  /* kvStore=/path is an alias for kvStores=[default=/path] */
  kvStores=[
    default=/var/lib/jsmaws/secrets.db
    /* or: production=https://api.deno.com/databases/... for Deno Deploy KV */
    /* production=https://api.deno.com/databases/... */
  ]

  /* Optional: Secrets store adapter(s) for :secret: references (future) */
  /* secretsStore=[...] is an alias for secretsStores=[default=[...]] */
  /* secretsStores=[
    default=[
      adapter=@vault
      address=:env:VAULT_ADDR
      token=:env:VAULT_TOKEN
      mountPath=secret/jsmaws
    ]
  ] */

  /* Values injected into all applets (merged with pool/route appEnv) */
  appEnv=[
    appVersion=:env:APP_VERSION
    featureNewUI=:env:FEATURE_NEW_UI
    publicApiUrl=https://api.example.com/v1
  ]

  /* Auth provider configuration (uses value references) */
  /* auth providers are configured per-route; see auth-api-design.md */

  /* Data source configuration (uses value references) */
  dataSources=[
    db=[
      adapter=@postgres
      host=:env:DB_HOST
      port=5432
      database=:env:DB_NAME
      user=:env:DB_USER
      password=:env:DB_PASSWORD
    ]
    cache=[
      adapter=@redis
      host=:env:REDIS_HOST
      password=:env:REDIS_PASSWORD
    ]
  ]
)]
```

### 7.2 Pool-Level `appEnv`

```slid
pools=[
  standard=[
    minProcs=1
    maxProcs=20
    /* Merge with global appEnv; override or delete values for this pool */
    appEnv=[
      /* Override global value */
      publicApiUrl=https://api.example.com/v2
      /* Delete global value (not injected for this pool) */
      featureNewUI=:delete:
    ]
  ]
  admin=[
    minProcs=1
    maxProcs=5
    /* Admin pool: add an extra value, keep global defaults otherwise */
    appEnv=[
      adminMode=true
    ]
  ]
]
```

### 7.3 Route-Level `appEnv`

```slid
routes=[
  [
    path=/api/payments/:*
    pool=standard
    dataSources=[db]
    auth=[[provider=@jwt  secret=:env:JWT_SECRET]]
    /* Route-level appEnv merges on top of pool and global appEnv */
    appEnv=[
      stripePublishableKey=:env:STRIPE_PUBLISHABLE_KEY
      maxRetries=3
      tenantId=acme-corp
    ]
  ]
  [
    path=/api/users/:*
    pool=standard
    dataSources=[db cache]
    /* Uses merged global + pool appEnv (no route-level override) */
  ]
  [
    path=/public/:*
    pool=standard
    /* No appEnv at any level: JSMAWS.env is {} for this route */
  ]
]
```

---

## 8. Applet API

### 8.1 `globalThis.JSMAWS.env`

The injected environment is available as a frozen plain object on the `JSMAWS` namespace:

```javascript
// Always available (may be empty object if no appEnv configured at any scope)
const env = globalThis.JSMAWS.env;

// Access individual values
const apiUrl = env.publicApiUrl;           // string or undefined
const version = env.appVersion;            // string or undefined
const retries = parseInt(env.maxRetries ?? '3', 10);
```

Properties:
- Always a plain object (never `null` or `undefined`)
- Frozen (`Object.isFrozen(globalThis.JSMAWS.env) === true`)
- All values are strings
- Keys are exactly those present in the effective merged `appEnv` for the route (after `:delete:` keys are removed and all values coerced to strings)
- Available from the first line of the applet's default export function

### 8.2 Mesgjs-Style Access (Future)

For Mesgjs applets, the env namespace will be accessible via the standard Mesgjs message-passing API. The exact form is TBD pending Mesgjs integration design.

---

## 9. Interaction with Auth and Data Access APIs

### 9.1 Auth API

The auth API design uses value references for provider secrets:

```slid
auth=[
  [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
  [provider=@api-key  header=x-api-key  keys=:env:API_KEYS]
]
```

Under this proposal:
- `:env:JWT_SECRET` is a value reference resolved by the `ValueResolver` at startup.
- The resolved value is passed to the auth provider's `init()` or `check()` call.
- The JWT secret is **never** injected into applet workers (it is not in any `appEnv` block).
- The auth provider receives the resolved value as a plain string in its configuration object.

### 9.2 Data Access API

The data access API uses value references for connection credentials:

```slid
dataSources=[
  db=[
    adapter=@postgres
    host=:env:DB_HOST
    password=:env:DB_PASSWORD
  ]
]
```

Under this proposal:
- All value references in `dataSources` are resolved by the `ValueResolver` at startup.
- The resolved configuration is passed to the adapter's `init()` call in the responder process.
- Database passwords are **never** injected into applet workers.
- Applets access data via the `JSMAWS.data` channel (IPC), not via direct database connections.

### 9.3 Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────┐
│  jsmaws.slid (raw config with value references)                 │
│  :env:JWT_SECRET, :kv:secrets/db-password, :file:/run/secrets/  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ ValueResolver.resolveObject()
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Resolved Configuration (operator-internal, never logged)       │
│  JWT_SECRET='abc123', db-password='hunter2', key='-----BEGIN...'│
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │  Auth Providers  │  │  Data Adapters   │  (server-side only) │
│  │  (get secrets)   │  │  (get creds)     │                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Applet Injection (appEnv merge applied)                 │   │
│  │  Only explicitly-enumerated values pass                  │   │
│  │  → setupData.appEnv → globalThis.JSMAWS.env (frozen)     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Implementation Plan

### Phase 1: Value Resolver Core

1. **`src/value-resolver.esm.js`** — `ValueResolver` class
   - `resolve(ref)` — resolves a single value reference
   - `resolveObject(obj)` — recursively resolves all string values in an object
   - `reload()` — re-reads all cached values
   - Support for `:env:`, `:file:`, `::` (literal/empty) schemes
   - `:kv:` and `:kv.selector:` support (requires KV store references)

2. **`src/configuration.esm.js`** — Integration
   - `Configuration` constructor accepts a `ValueResolver` instance (optional; defaults to a no-op resolver for tests)
   - `updateConfig()` calls `valueResolver.resolveObject()` on the raw config and stores only the resolved result
   - `getEffectiveAppEnv(routeSpec, poolName)` — merges global, pool, and route `appEnv` blocks and returns the resolved env object for a request

3. **`src/operator-process.esm.js`** — Integration
   - Creates `ValueResolver` at startup with KV store references
   - Passes resolved config to responders (already the case; no protocol change needed)

### Phase 2: Applet Injection

4. **`src/responder-process.esm.js`** — Injection into setupData
   - Call `config.getEffectiveAppEnv(routeSpec, poolName)` when assembling `setupData`
   - Include result as `setupData.appEnv`

5. **`src/applets/bootstrap.esm.js`** — Expose `JSMAWS.env`
   - `jsmawsNamespace.env = Object.freeze(setupData.appEnv ?? {})`

### Phase 3: KV Store Support

6. **`src/operator-process.esm.js`** — KV store lifecycle
   - Open KV store(s) at startup if `config.kvStores` is set (or `config.kvStore` alias)
   - Pass KV store references to `ValueResolver`
   - Close KV stores on shutdown

7. **`src/value-resolver.esm.js`** — `:kv:` and `:kv.selector:` scheme implementation
   - `resolve(':kv:namespace/key')` → `kvStores.default.get(['namespace', 'key'])`
   - `resolve(':kv.storeName:namespace/key')` → `kvStores.storeName.get(['namespace', 'key'])`

### Phase 4: Tests and Documentation

8. Unit tests for `ValueResolver` (all schemes)
9. Unit tests for `Configuration.getEffectiveAppEnv()` (merge hierarchy)
10. Integration tests for applet injection (bootstrap receives `setupData.appEnv`)
11. E2E tests for env-injected applets
12. Administrator guide: configuring value references and applet injection
13. Applet developer guide: using `globalThis.JSMAWS.env`

---

## 11. Security Considerations

- **No values injected by default**: Values are never injected into applet workers unless explicitly enumerated in an `appEnv` block. The `appEnv` configuration is the security boundary.
- **Deletion support**: Setting a key to `:delete:` in a more-specific `appEnv` block deletes it from the merged result, preventing injection of values defined at broader scopes.
- **Frozen env object**: `globalThis.JSMAWS.env` (a "shallow" object containing only string-valued properties) is frozen.
- **No serialization of resolved values**: Resolved values must not appear in logs, error messages, or diagnostic output. Raw (unresolved) config is not retained; IPC transmits only the resolved config over the trusted operator ↔ responder channel.
- **Env var access is operator-only**: The operator process reads environment variables. Responder processes receive already-resolved values via IPC. Responders do not have access to the operator's environment.
- **KV store access control**: KV stores used for `:kv:` references should be accessible only to the operator process (file permissions, network ACLs). Responders do not access KV stores directly.
- **File reference path traversal**: `:file:` references must be validated to prevent path traversal attacks. Relative paths are resolved relative to the config file directory; absolute paths are used as-is. Paths containing `..` components are rejected.

---

## 12. Open Questions

1. **Should `:delete:` accept an optional reference portion, or require it to be empty?**
  - **Resolved**: The reference portion is ignored if present. The special key `*=:delete:` clears all accumulated keys at that point in the merge, allowing a more-specific scope to start fresh. Keys defined in the same block, or in more-specific scopes, are applied normally.

2. **Should `appEnv` values support non-string types?** (e.g., numbers, booleans) — Current proposal: strings only, for simplicity. Applets parse as needed. Revisit if this proves too inconvenient.
  - **Resolved** No. Value domain is applet responsibility. Avoid assumptions, PolyTransport byte-stream encoding complications, responder value re-parsing.

3. **How should `:kv:` references handle missing keys?** — Current proposal: `undefined` (same as missing env var). Should there be a default value syntax? e.g., `:kv:key?default-value`.
  - **Resolved** Default-value handling is (trivial) applet responsibility. No need to complicate the server.

4. **Should there be a `reload` API for applets?** (e.g., to pick up updated env values mid-request) — No. Env values are resolved at request dispatch time and are immutable for the lifetime of the applet worker. Applets that need dynamic config should use the `data` channel to query a KV store directly (if granted access).
  - **Resolved** Correct - static data only (which might include credentials to access a live data connection, via separate data-access-api-design)

5. **Should the `:secret:` scheme be implemented in Phase 1 as a stub, or deferred entirely?** — Current proposal: stub in Phase 1 (logs error, returns `undefined`). This allows configuration files to use `:secret:` references without breaking, while making it clear the feature is not yet implemented.
  - **Resolved** No; documented proposal only. Zero scheme-specific code implementation for now. Standard error messaging for unimplemented schemes.

6. **Should value references be allowed in pool configuration?** (e.g., `maxProcs=:env:POOL_MAX_PROCS`)
  - **Resolved** A context-free resolver that processes all string values uniformly is simpler to implement than one that must know which configuration sections support value references.

7. **How should the `appEnv` merge work when a route has no `appEnv` block?**
  - **Resolved**: Inherit the merged global + pool `appEnv`. If no `appEnv` is defined at any scope, `JSMAWS.env` is `{}`. The default behavior is no injection, which is the safe default.

8. **Should `kvStore` (singular) be a true alias for `kvStores=[default=...]`, or should it be a separate, simpler configuration path?**
  - **Resolved**: `kvStore=path` is syntactic sugar for `kvStores=[default=path]`. The `ValueResolver` normalizes both forms internally.

---

## 13. Open Issues

The following issues require resolution in a separate task:

### 13.1 ValueResolver Architecture

**Issue**: The current design shows `ValueResolver` as a class with a `reload()` method, but this is fundamentally incompatible with the stated principle that "raw (unresolved) configuration is **not retained** after resolution" (§6.3).

**Problems**:
1. **`reload()` cannot work**: Without retaining the original `:env:VAR_NAME` references, there is nothing to re-resolve. The method would need to re-read the SLID file and re-parse it, which is the responsibility of `config-monitor.esm.js`, not the value resolver.

2. **KV store lifecycle is unclear**: The design states that KV stores are opened at startup and passed to the `ValueResolver` (§6.4). However, KV store paths are themselves part of the configuration. On config reload, the set of KV stores may have changed (new stores added, old ones removed, paths modified). Keeping old KV store instances open after a config reload seems questionable.

3. **Caching model is contradictory**: The design mentions "cached values" in multiple places (§3.3, §3.4, §6.1), but if no original references are retained, there is no mapping to re-resolve from. The cache would be pointless.

**Proposed Resolution**:
- Remove the `reload()` method from `ValueResolver`. Config reload is handled by `config-monitor.esm.js` detecting file changes and triggering a full re-parse and re-resolution.
- On config reload, close all existing KV stores and open new ones based on the new configuration's `kvStores` block.
- `ValueResolver` should be stateless (or nearly so), holding only the KV store references needed for the current resolution pass.
- Consider whether `ValueResolver` should be a class at all, or just a set of helper functions that accept KV stores as parameters.

### 13.2 Scheme Handler Modularity

**Issue**: The design does not specify how scheme handlers (`:env:`, `:kv:`, `:file:`, `:secret:`) are implemented or organized. For extensibility, these should be modular and separately loadable.

**Problems**:
1. **No separate API for scheme handlers**: The implementation plan (§10) suggests all schemes are implemented directly in `src/value-resolver.esm.js`, which makes adding new schemes (like `:secret:`) require modifying the core resolver.

2. **Extensibility is limited**: The design principle (§2.2) states "Scheme-based extensibility: New value sources can be added without changing the configuration syntax," but the implementation does not support adding new schemes without modifying the resolver code.

**Proposed Resolution**:
- Define a scheme handler interface/protocol (e.g., `async function resolveScheme(reference, context) { ... }`).
- Implement each scheme in a separate file:
  - `src/schemes/env-scheme.esm.js` — `:env:` handler
  - `src/schemes/file-scheme.esm.js` — `:file:` handler
  - `src/schemes/kv-scheme.esm.js` — `:kv:` and `:kv.selector:` handler
  - `src/schemes/literal-scheme.esm.js` — `::` handler
  - `src/schemes/delete-scheme.esm.js` — `:delete:` handler (appEnv-specific)
  - (future) `src/schemes/secret-scheme.esm.js` — `:secret:` handler
- `ValueResolver` (or the resolver function set) dynamically loads and dispatches to the appropriate scheme handler based on the scheme prefix.
- ~~Scheme handlers receive a context object with necessary resources (e.g., `{ kvStores, configDir }` for `:kv:` and `:file:` handlers).~~

FEEDBACK:
- Retain the 'ValueResolver' as a class.
- Create a barrel file to load the ValueResolver and currently-supported scheme classes.
- Add a static method on the ValueResolver to register a simple mapping between scheme names and corresponding implementation classes.
- While not expected in practice (at least initially), it should be valid to register a scheme-class multiple times with different schemes (to allow scheme aliasing for backwards-compatibility, as one possible example use-case).
- The barrel file should export a function that calls the static method to register each of the scheme-classes it is loading. This function should be called once during JSMAWS initialization.
- The first time a registered scheme is encountered in a resolution pass (per config (re)load), the ValueResolver can create and save a scheme-class instance which it will use to resolve instances of that scheme-type.
- The scheme-class constructor should be passed the (entire) raw configuration currently being resolved in order to extract any portion it needs.
- Literal and delete schemes provide mandatory, core functionality, require no external resolution, and should therefore be built directly into the resolver.
- Other scheme classes should implement:
  - `async .resolve(valueReference)`, passing the entire original value reference (full scheme, along with optional reference if presence) and returning the resolved value
  - `async .done()`, for end-of-pass cleanup (file or other resource closure, etc)

---

[supplemental keywords: environment variables, secrets management, credentials, API keys, value resolver, env injection, applet configuration, kv store, file secrets, Docker secrets, appEnv, access control, configuration security, :secret: scheme, :env: scheme, :kv: scheme, :file: scheme, :delete: scheme, literal scheme, empty scheme, :: syntax, :scheme: syntax, selector, kvStores, secretsStores, setupData, JSMAWS.env, bootstrap, operator, responder, value reference, scheme prefix, merge semantics, scope hierarchy, erasure, key deletion, reload, caching, modularity, extensibility, scheme handlers]
