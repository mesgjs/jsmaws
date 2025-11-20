# JSMAWS Configuration

## General Configuration

- Default path: `jsmaws.slid`
- MIME types for extension-based content types
  - First match wins (if a longer suffix needs to "override" a shorter suffix, it should appear first).
  - Enumerate under `mimeTypes` level, e.g.: `[mimeTypes=['.htm'=text/html '.html'=text/html '.js'=text/javascript '.txt'=text/plain]]`
- `appRoot=/ar1/ar2`: the base path for relative `app` paths (add trailing `/` if missing)
- `root=/dr1/dr2/...`: the default filesystem "root" directory for `path` specifications

## Routing Configuration

- Routes should be under the `routes` level: `[routes=[[spec]...]]`
- Route specifications
  - A `path=part/part/...` to match the URL path
    - `:name` part: match any single path part (a URL part is required; assigned key `['params', name]`)
    - `@name` part: applet path part (URL part must match `name`; assigned key `app`)
    - `@*` part: match any applet (present at the current file path unless *virtual*) (assigned key `app`)
    - `:?name` (post-applet) part: match any single path part (a URL part is optional; assigned key `['params', name]` if present)
    - `:*` (post-applet) part: matches the remainder of the URL path as a single string (may be empty; assigned key `tail`)
      - `:?` (and technically, another `:*`) could appear after this, but won't match (non-fatal; just won't be (re-)assigned)
      - Anything else after this guarantees the route will never match
    - Other parts: these are (potentially) "filesystem parts" (they must match the next URL part)
      - (In contrast, variable parts are not included in the construction of filesystem paths)
  - A `regex=pattern` to match the URL path
    - Can be used *in addition to* `path` to further constrain matches
    - Can be used *instead of* `path` for purely-regex-based virtual routes
      - When used without `path`, `app` *MUST* be specified in the route configuration (user-input alone must not be able to determine which applet is executed)
  - A service `class` of `static`, `int` (internal), or `ext` (external)
  - `ws` flag: set to true (`@t`) if client-initiated websocket connections are allowed
  - Or a response (`response=404` or `response='404 Not Found'`)
    - A redirect response should include a target `href`: `[path=/example response=307 href=https://example.com]`
  - Optional `method=method` or `method=[method...]`
    - Methods are mapped to lower case (e.g. `get`, not `GET`)
    - Default, if not specified, is to match only `get`
    - Can also specify `any` to match any method
    - `read` is short for `method=[get head]`
    - `write` is short for `method=[patch post put]`
    - `modify` is short for `method=[delete patch put]`
  - Optional absolute or relative applet path, `app=/?path/...`
    - This results in a "virtual route" - the URL path is never checked against the filesystem
  - Optional local root, `root=/lr1/lr2/...`
  - Optional response headers (simple list of positional values): `headers=[header...]`
  - An applet request (class of `int` or `ext`) should load a JavaScript applet
    - Use the applet path from `app=path` if provided, otherwise use the applet matched from the URL path
    - If the applet ends in `.js`, use the applet path as-is; otherwise, try `.esm.js` (first) and `.js` extensions (second)
- Routes are checked in order; the first matching route is used
- For both virtual and filesystem-based routes, if there are URL components after the applet that are not accounted for (i.e. "consumed") by variable-part matching, the route is deemed non-matching.

## Filesystem Paths For Filesystem-Based Routes

- Let the *pre-path* be defined as any *non-variable* path parts preceding the applet part (`@name` or `@*`)
- For filesystem-based (non-virtual) routes:
  - The applet must be present at `/dr1/dr2/.../pre-path/parts/.../applet{.esm,}.js` if the routing entry *does not have* a local root
  - The applet must be present at `/lr1/lr2/.../applet{.esm,}.js` if routing entry *does have* a local root (the pre-path must match the routing specification, but has no effect on the filesystem path)

## Ideas For Potential Future Enhancements

- As routing is likely to be more volatile than the rest of the server configuration, we might want to consider supporting the use of an optional, secondary configuration file
  - The file name itself would be part of the main configuration file (`routeConfigFile`), and should be relative to the main configuration file's directory if it's not an absolute path (suggested name: `jsmaws-routes.slid`)
- `poolMin` and `poolMax` for creating service instance pools for high-frequency requests
