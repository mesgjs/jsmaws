# Revisions 2026-05-10

## Objectives

- Multiple-host (with SNI) support
- Different routes may support different authn methods
- Header and cookie filtering based on routes\* (*not* authn providers)

\* More specifically, on route-groups

## Configuration Format Additions/Changes

```slid
[(
    /* Top-level as per jsmaws-config-example.md */

    /* Default authentication providers (in order of preference) */
    /* First successful authentication sets identity and stops */
    authn=[method ...]

    hostRoutes=[ /* Host-specific routing */
        host1=[/* routes/group references array; same syntax as top-level */]
        host2=[alias=host1] /* host2 is alias for host1; uses host1 routes */
        *=[/* routes/group refs */] /* Default when no hostname matches */
    ]

    /* Top-level (default) request and response filtering */
    requestFilter=[allowHeaders=[...] denyHeaders=[...] allowCookies=[...] denyCookies=[...]]
    responseFilter=[allowHeaders=[...] denyHeaders=[...] allowCookies=[...] denyCookies=[...]]

    routeGroups=[
        /* Qualified group (an object with a `routes` array-prop) */
        name1=[prop1=value prop2=[...] routes=[...]]
        /* Unqualified group (an array of routes) */
        name2=[routes...]
    ]

    /* Top-level routing is exclusive of host-specific routing */
    routes=[ /* Routes (array of objects, checked in order) */
        [path=... pool=...] /* Individual routes */
        [group=routeGroupName] /* Try routes from named route-group, in order */
        [path=... pool=...]
        ...
    ]
)]
```

## Route Groups

- These provide support for named, reusable routing
- A route-group reference is an object with a `group` property referencing a named route-group definition
- Qualified groups
  - An object with various conditions or other supplemental properties
  - The required `routes` property is an array of routes (just like top-level)
  - The routes are only checked if the optional conditions are all met (evaluated first)
    - `incpre=prefix` or `incpre=[...]` matches if any path prefix in the array matches
    - `excpre=prefix` or `excpre=[...]` matches if no path prefix matches
    - `method=method` or `method=[...]` matches if request method matches
  - Authentication (if prefix/method tests pass)
    - `authn=provider` or `authn=[...]` providers to use instead of top-level default
    - `role=role` or `role=[...]` matches if authn role matches (case-sensitive)
    - Role-skipping of routes may result in 404 instead of 401/403
  - Request/response filtering (if a route in the group is chosen)
    - `requestFilter=[...]` - route-group-specific request filtering
    - `responseFilter=[...]` - route-group-specific response filtering
- Unqualified groups
  - An array of routes (just like top-level)
  - Top-level (default) authn and filters apply
- Route-group routes may not contain route-group references (no nesting)

## Host-Based Routing

These configuration extensions add support for host (SNI)-based routing.

- If the config contains a top-level `hostRoutes`, then the request hostname is used to find host-specific routing, otherwise the top-level `routes` configuration is used.
- If the `hostRoutes` entry contains `alias=name`, the hostname that matched is an alias for `name` and a new lookup is attempted. While nested aliases are supported, their use is less efficient and discouraged.
- The `*` (wildcard/default) entry (if present) is used (only) if there is no matching hostname. (To be clear, these are never additional/fallback routes for specific hostnames.)
- A routing entry is a group reference if it contains a `group` property
- Individual routes and group references may be combined in any order (and are tested in order)

## Authentication

- A top-level `authn` specifies default authentication providers
- Route-group-specific `authn` can be used to locally override the top-level default
- As authentication-provider lists may overlap, *per-request* authentication results (both successes and failures) should be second-level cached by provider (separately from first-level TTL-based cache)
- `authn` providers are evaluated in order until one succeeds or all are exhausted

## Header And Cookie Filtering

- `requestFilter` and `responseFilter` from top-level are used by default
- `requestFilter` and/or `responseFilter` at route-group level is used instead when present
- Filtering is not part of authn providers

## Changes And Clarifications 2026-05-11-A

- The *top-level* `authn` contains the list of potentially-identifying authentication providers
  - `authn` is either an object or an array of objects
  - The objects contain a `provider` and any required supporting props (secrets, keys, etc)
  - Role enforcement should be implemented at the routing layer, not at this level
  - These are evaluated *in order, before routing, initiated by the operator* (some evaluations may be delegated)
  - *Evaluation stops at the first successful identification*
  - Since evaluation stops immediately up success, there is no identity merging
- A qualified route-group may include its own `authn`
  - A route-group `authn` may be a single value or an array, but each value is *scalar* (used for filtering), *not a configuration object*
  - Values are considered, *in order*, until one of the following matches (at which time no further values are considered):
    - A value matching the current (successful) identity provider; the identity will be presented
      - This *might* need to support some sort of qualifier if multiple provider instances are possible (e.g. *which* JWT?)
    - `@allow-known` when a non-empty identity is present; the identity will be presented
    - `@allow-all` always matches; the identity is *suppressed* (to routes in the group) if present
    - `@deny-all` always matches; the route-group will be skipped
  - A role may only match when an identity is presented, not when it is suppressed (an automatic failure)
  - Route-group `authn` never triggers a new evaluation
- The effective `authn` (route-group if present, top-level otherwise) shall be interpreted as having an *implied* `[@allow-known @allow-all]` at the end (not reached if there's an explicit `@allow-all` or `@deny-all` because they *always* match)
- `[@allow-known @allow-all]` accepts with or without identity (presenting if present)
- `[@allow-known @deny-all]` accepts only if identity is present
- `[@jwt @allow-all]` accepts all, but only presents identity if `@jwt` was first successful
- `@allow-known`, `@allow-all`, and `@deny-all` should be *built-in* and part of routing (not modules and not part of top-level `authn`)
- A role check is always performed if the condition is present (lack of identity for any reason, *including suppression*, is treated as a non-match and the route-group is skipped)
- Only the TTL-based cache is required (no second-level cache)
  - There is always exactly zero or one active identities (first match), which is either presented or suppressed

## Changes And Clarifications 2026-05-11-B

- `addHeaders` is removed from the auth provider interface
  - Identity is passed in normalized form to mod-apps via `requestData.identity`; no header injection needed
  - Response headers (e.g. `WWW-Authenticate`) are a mod-app concern, not a server auth concern
- Provider return values are simplified:
  - `null` / `undefined`: provider did not recognize this request (no credential present, wrong credential type, or expired/not-yet-valid credential); try next provider
  - `{ allow: true, identity }`: provider successfully identified the caller; stop chain
  - `{ allow: false, denyStatus, denyMessage }`: credential is structurally invalid or clearly malicious (e.g. bad JWT signature, malformed token); hard deny, stop chain
- Expired or not-yet-valid credentials are not malicious; providers return `null` for these cases, allowing other providers to attempt identification
- Role checks are removed from individual providers; `role` is a routing-layer condition on qualified route groups
- `@allow-all` and `@deny-all` are routing-layer constructs only (not top-level `authn` providers)
  - Maintenance mode is handled at the routing layer (e.g. a catch-all response route with `response=302 href=/maintenance`)
- `@allow-all` (top-level provider) is renamed to `@test-identity` to avoid confusion with the routing-layer `@allow-all` construct
  - `@test-identity` always returns a configurable identity; intended for development and testing
- The `providerName` field is added to the success `AuthResult` (the spec string used to load the provider, e.g. `@jwt`); used by route-group authn filter to match the active identity's provider

## Changes And Clarifications 2026-05-14-A

### Response Routes: `responseText` and `headers`

A `response` route (a route that returns a fixed server-generated response without dispatching to a mod-app) should support two additional optional properties:

- `responseText` — a plain-text body to include in the response (e.g. `"Unauthorized"`)
- `headers` — an object of response headers to include (e.g. `[www-authenticate='Basic realm="My App"']`)

This enables `WWW-Authenticate` challenges (and similar protocol-level headers) to be expressed entirely in configuration, without requiring a mod-app. For example:

```slid
routeGroups=[
    protected=[
        authn=[@allow-known @deny-all]
        routes=[
            [path=/api/:*  pool=standard  app=./apps/api.esm.js]
        ]
    ]
    challenge=[
        authn=[@allow-all]
        routes=[
            [path=/api/:*  response=401  responseText=Unauthorized  headers=[www-authenticate='Basic realm="My App"']]
        ]
    ]
]
routes=[
    [group=protected]
    [group=challenge]
]
```

**How this works:**

1. The `protected` group uses `authn=[@allow-known @deny-all]` — only routes if an identity is present. If the caller is authenticated, the request is dispatched to the mod-app.
2. The `challenge` group uses `authn=[@allow-all]` — always matches (identity suppressed). The `response=401` route returns a fixed 401 with the `WWW-Authenticate` header, prompting the client to authenticate.

**Design notes:**

- `responseText` is optional; if omitted, the response body is empty (or the default HTTP status phrase).
- `headers` is optional; if omitted, no extra headers are added beyond the standard response headers.
- `responseText` and `headers` are only meaningful on `response` routes (routes with a `response` property specifying an HTTP status code or redirect). They are ignored on routes that dispatch to a mod-app.
- This pattern generalizes beyond `WWW-Authenticate`: any fixed-response route can include arbitrary headers (e.g. `location` for redirects, `retry-after` for 503 maintenance responses).
- `WWW-Authenticate` is a mod-app concern when the mod-app decides whether to require authentication (e.g. serving public content to unauthenticated users). It is a configuration concern when the server enforces authentication at the routing layer via route groups.

### Route-Level `authn` and `role` Filtering

Individual routes may carry their own `authn` (scalar filter) and `role` properties, with the same semantics as qualified route-group `authn`/`role`. A route-level value overrides the enclosing group-level value (or top-level default) for that specific route.

**Precedence (most specific wins):** route-level `authn`/`role` > group-level `authn`/`role` > top-level implied `[@allow-known @allow-all]`

**Evaluation order:** Route-level `authn`/`role` are evaluated *before* path matching for that route — consistent with how group-level `authn`/`role` are evaluated before the group's routes are searched. A route with `authn`/`role` that rejects is skipped entirely (path matching is not attempted), exactly as a group is skipped when its `authn`/`role` rejects. Conceptually, a route with `authn`/`role` is an implicit one-route group.

This eliminates the need to define a separate route group solely to attach an authn filter to a single route. The `WWW-Authenticate` challenge pattern from above can be expressed more concisely without named groups:

```slid
routes=[
    [path=/api/:*  authn=[@allow-known @deny-all]  pool=standard  app=./apps/api.esm.js]
    [path=/api/:*  authn=[@allow-all]  response=401  responseText=Unauthorized  headers=[www-authenticate='Basic realm="My App"']]
]
```

It also allows these types of related routes to be included in groups (groups may not contain other groups).

**Implementation notes:**

- Route-level `authn`/`role` use the same evaluation logic as group-level (`#evaluateGroupAuthnFilter()` and the role check).
- If route-level `authn` or `role` rejects, the route is skipped and matching continues with the next route.
- `requestFilter`/`responseFilter` remain group-level only; per-route filtering is not supported (the `incpre`/`excpre` group pattern covers the primary use case for filtering without per-route granularity).
