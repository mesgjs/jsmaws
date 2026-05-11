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
