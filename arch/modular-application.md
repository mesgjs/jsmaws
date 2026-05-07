# Modular Application Terminology

## Summary

JSMAWS adopts the term **mod-app** (modular application) to replace "applet" as the name for the JavaScript ES modules that handle requests within the server. The plural is **mod-apps**; the preferred short form in code and file names is **app**. The JSMAWS acronym is redefined as **JavaScript Modular Application Web Server**.

---

## Why "Applet" Is Problematic

The term "applet" carries strong, specific connotations from Java's history:

- **Java Applets (1995–2017)**: Browser-embedded Java programs running in a sandboxed JVM plugin. They were *client-side*, *browser-embedded*, *plugin-dependent*, and are now universally deprecated. Oracle officially killed them in Java 9 (2017); browsers removed NPAPI support entirely.
- The word is a diminutive of "application" — a *small* application.

The dominant mental model for "applet" in most developers' minds is: **a small, sandboxed, client-side program embedded in a browser page**. This is misleading for JSMAWS, where the units are *server-side request handlers* — the opposite side of the wire.

Additionally, the term evokes 1990s/2000s web technology, creating cognitive dissonance when applied to a modern Deno-based server framework.

---

## Why Not "Servlet"?

"Servlet" is more technically accurate (server-side, container-managed, request-dispatched) but carries its own problems:

- Strongly Java-branded — developers immediately think of `javax.servlet`, WAR files, and Tomcat.
- Implies a specific Java API contract (`init()`, `service()`, `destroy()`).
- May suggest JSMAWS is "Java for JavaScript," underselling its unique architecture.

---

## The "Inside-Out" Architecture

A key conceptual distinction motivates the new terminology:

| Traditional model | JSMAWS model |
|---|---|
| Application *contains* a web server (Express, Django, Rails) | Web server *contains* applications (modapps) |
| Full rebuild + redeploy to add/change functionality | Hot-swap individual modapps independently |
| One app = one deployable unit | One server = many independently deployable modapps |
| Server is a library/dependency | Server is the stable platform |

JSMAWS is an **inside-out application**: the overall application is a collection of modules running *inside* a web server, not a web server running *inside* an application. This is the key architectural difference from Express/Fastify/Hono-style frameworks.

This model is analogous to Apache Tomcat (servlet container) or PHP-FPM (process pool manager), but with stronger process isolation, hot-swappable modules, and a JavaScript-native execution model.

---

## Full-Stack Context

JSMAWS modapps are not purely server-side. In the Mesgjs/MWI ecosystem, a single logical modapp will often span:

- **SSR** (server-side rendering, running in JSMAWS)
- **Hydration** (transitioning from server-rendered to client-interactive)
- **CSR** (client-side rendering, running in MWI/browser)

The term "modapp" naturally encompasses this full-stack nature — it refers to the *modular application unit* as a whole, regardless of which side of the wire a given piece of code executes on.

---

## The "Mod-App" Term

**"Mod-app"** (modular application) was chosen because it:

1. **Encodes the defining architectural property**: modularity and independent hot-swappability.
2. **Works grammatically as a count noun**: "a mod-app," "three mod-apps," "deploy mod-apps."
3. **Has a natural short form**: "app" — consistent with modern usage and preferred in code and file names.
4. **Carries no misleading historical baggage**: not associated with any deprecated or competing technology.
5. **Makes the JSMAWS acronym self-documenting**: JavaScript **Mod**ular **App**lication Web Server.
6. **Aligns with the inside-out framing**: the server is the stable platform; mod-apps are the independently deployable units running inside it.
7. **Encompasses full-stack units**: a mod-app may include both server-side (JSMAWS) and client-side (MWI) components.

The "mod" prefix evokes a strong positive connotation in software culture — game mods, kernel modules, and browser extensions are all "mods" that extend a stable platform without replacing it. This maps precisely to the JSMAWS model.

The hyphenated form **"mod-app"** is preferred in comments and documentation to reinforce correct syllable boundaries and pronunciation (MOD-app, not mo-DAPP). In code identifiers and file names, the short form **"app"** is preferred (e.g., `appPath`, `appChannel`, `app-bootstrap.esm.js`) to keep identifiers concise and avoid potential camelCase ambiguity between `modapp` and `modApp`.

---

## Terminology Reference

| Term | Usage context | Definition |
|---|---|---|
| **mod-app** | Comments, documentation, prose | A JavaScript ES module that handles requests within JSMAWS; the primary deployable unit |
| **mod-apps** | Comments, documentation, prose | Plural of mod-app |
| **app** | Code identifiers, file names, config | Short form of mod-app; preferred in code (e.g., `appPath`, `appChannel`) |
| **JSMAWS** | All contexts | JavaScript Modular Application Web Server |
| **built-in mod-app** | Documentation | A mod-app shipped with JSMAWS (e.g., `@static` for static file serving) |
| **app worker** | Code, comments | The Web Worker instance that executes a mod-app for a single request |
| **app path** | Code, comments | The filesystem path or URL of a mod-app's ES module file |

---

## Transition Plan

The following steps are needed to migrate existing code, tests, and documentation from "applet" to the new terminology.

### Naming Conventions Summary

| Context | Term to use | Examples |
|---|---|---|
| Comments and documentation | mod-app / mod-apps | "Main mod-app entry point", "spawns mod-app worker" |
| Code variable names | `app` prefix/suffix | `appPath`, `appChannel`, `appModule`, `appWorker` |
| File names | `app` | `app-bootstrap.esm.js`, `static-app.esm.js` |
| Directory names | `apps` | `src/apps/`, `examples/apps/` |
| Test file names | `app` | `app-bootstrap.test.js` |
| Route-part type names | `app-named`, `app-any` | (internal router types) |
| PolyTransport channel name | `'app'` | `transport.requestChannel('app')` |

### Scope of Changes

The term "applet" appears in:

- **Source code** (`src/`): comments, variable names (`appletPath`, `appletChannel`, `appletModule`, `appletURL`, `appletHref`, `appletWorker`), string literals, JSDoc
- **Test files** (`test/`, `test-e2e/`): comments, variable names, test descriptions
- **Architecture documents** (`arch/`): throughout most documents
- **Configuration files**: `jsmaws.slid` (comments), `examples/`
- **README.md**: title, description, feature list
- **Memory bank** (`.kilocode/rules/memory-bank/`): `brief.md`, `architecture.md`, `context.md`, `tech.md`

### Step 1 — Update Source Code (`src/`)

Files to update:

- [`src/applets/bootstrap.esm.js`](../src/applets/bootstrap.esm.js) — rename to `src/apps/app-bootstrap.esm.js`; update variable names (`appletPath` → `appPath`, `appletModule` → `appModule`, `appletChannel` → `appChannel`); update comments ("applet" → "mod-app") and JSDoc
- [`src/applets/static-content.esm.js`](../src/applets/static-content.esm.js) — rename to `src/apps/static-app.esm.js`; update comments ("Main applet entry point" → "Main mod-app entry point")
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) — update all variable names (`appletPath` → `appPath`, `appletChannel` → `appChannel`, `appletWorker` → `appWorker`, `appletURL` → `appURL`, `appletHref` → `appHref`); update comments ("applet" → "mod-app") and JSDoc; update import paths for renamed bootstrap/static files
- [`src/operator-process.esm.js`](../src/operator-process.esm.js) — update `appletPath` → `appPath` in `affinityMap`, `getProcessWithAffinity()`, `updateAffinity()`; update comments
- [`src/operator-request-state.esm.js`](../src/operator-request-state.esm.js) — update `appletPath` parameter and `this.app` assignment comment; update inline comments
- [`src/process-manager.esm.js`](../src/process-manager.esm.js) — update `addAffinity(appletPath)` → `addAffinity(appPath)`, `hasAffinity(appletPath)` → `hasAffinity(appPath)`; update comments
- [`src/request-channel-pool.esm.js`](../src/request-channel-pool.esm.js) — update comments referencing "applet console output" → "mod-app console output"
- [`src/router-worker.esm.js`](../src/router-worker.esm.js) — update comments; rename internal route-part types `applet-named` → `app-named` and `applet-any` → `app-any`

**Note on `src/applets/` directory**: Rename to `src/apps/`. Update all import paths that reference this directory.

### Step 2 — Update Test Files (`test/`, `test-e2e/`)

Files to update:

- [`test/applet-bootstrap.test.js`](../test/applet-bootstrap.test.js) — rename to `test/app-bootstrap.test.js`; update all variable names (`appletCode` → `appCode`, `appletUrl` → `appUrl`, `appletChannel` → `appChannel`); update test descriptions ("applet" → "mod-app") and comments; update import path for renamed bootstrap file
- [`test/static-content.test.js`](../test/static-content.test.js) — update comments ("Static Content Applet Tests" → "Static Content Mod-App Tests"); update variable names (`appletChannel` → `appChannel`); update import path for renamed static-content file
- [`test/security-validation.test.js`](../test/security-validation.test.js) — update comments and variable names (`appletCode` → `appCode`, `appletChannel` → `appChannel`, `appletUrl` → `appUrl`); update import path for renamed bootstrap file
- [`test/responder-process.test.js`](../test/responder-process.test.js) — update comments referencing "applet" → "mod-app"
- [`test/request-state-machine.test.js`](../test/request-state-machine.test.js) — update `appletPath` → `appPath` in test fixtures
- [`test/router-worker.test.js`](../test/router-worker.test.js) — update test descriptions ("parses named applet path" → "parses named mod-app path", etc.); update assertions referencing `applet-named` → `app-named` and `applet-any` → `app-any`
- [`test-e2e/e2e-http-basic.test.js`](../test-e2e/e2e-http-basic.test.js) — update test descriptions ("hello-world applet" → "hello-world mod-app"); update import paths for renamed example files
- [`test-e2e/e2e-sse-streaming.test.js`](../test-e2e/e2e-sse-streaming.test.js) — update comments ("sse-clock applet" → "sse-clock mod-app"); update import paths
- [`test-e2e/e2e-websocket-bidi.test.js`](../test-e2e/e2e-websocket-bidi.test.js) — update comments; update import paths

**Note on `deno.json`**: After renaming `test/applet-bootstrap.test.js` → `test/app-bootstrap.test.js`, verify test glob patterns in [`deno.json`](../deno.json) and [`deno-dev.json`](../deno-dev.json) still match.

### Step 3 — Update Example Files (`examples/`)

Files to update:

- [`examples/applets/`](../examples/applets/) — rename directory to `examples/apps/`; update all import paths in example client files
- [`examples/clients/http-hello.esm.js`](../examples/clients/http-hello.esm.js) — update comments; update import paths
- [`examples/clients/sse-clock.esm.js`](../examples/clients/sse-clock.esm.js) — update comments; update import paths
- [`examples/clients/ws-echo.esm.js`](../examples/clients/ws-echo.esm.js) — update comments; update import paths
- [`examples/README.md`](../examples/README.md) — update all references

### Step 4 — Update Configuration Files

Files to update:

- [`jsmaws.slid`](../jsmaws.slid) — update comments ("Base path for relative applet paths" → "Base path for relative mod-app paths")
- [`examples/jsmaws-examples.slid`](../examples/jsmaws-examples.slid) — update comments

**Note on `appRoot` config key**: The configuration key `appRoot` (base path for relative mod-app paths) already uses the "app" short form. No rename needed.

### Step 5 — Update Architecture Documents (`arch/`)

Priority order (most actively referenced first):

1. [`arch/applet-protocol.md`](../arch/applet-protocol.md) — rename to `arch/app-protocol.md`; update all content ("applet" → "mod-app")
2. [`arch/static-applet.md`](../arch/static-applet.md) — rename to `arch/static-app.md`; update all content
3. [`arch/development-and-test-plan.md`](../arch/development-and-test-plan.md) — update all references
4. [`arch/refactor-with-poly-transport.md`](../arch/refactor-with-poly-transport.md) — update all references; update channel name `'applet'` → `'app'` in diagrams and specs
5. [`arch/service-api-design.md`](../arch/service-api-design.md) — update all references
6. [`arch/auth-api-design.md`](../arch/auth-api-design.md) — update all references
7. [`arch/env-secrets-design.md`](../arch/env-secrets-design.md) — update all references
8. [`arch/requirements.md`](../arch/requirements.md) — update all references
9. [`arch/pool-configuration-design.md`](../arch/pool-configuration-design.md) — update all references
10. [`arch/service-class-research.md`](../arch/service-class-research.md) — update all references
11. All remaining `arch/*.md` files — update as needed

**Note on document renames**: When renaming `applet-protocol.md` → `app-protocol.md` and `static-applet.md` → `static-app.md`, update all cross-references in other arch documents and in the document index in [`.kilocode/rules/memory-bank/tech.md`](../.kilocode/rules/memory-bank/tech.md).

### Step 6 — Update README and Memory Bank

- [`README.md`](../README.md) — update title ("JavaScript Multi-Applet Web Server" → "JavaScript Modular Application Web Server"), description, and feature list
- [`.kilocode/rules/memory-bank/brief.md`](../.kilocode/rules/memory-bank/brief.md) — update project name and all "applet" references
- [`.kilocode/rules/memory-bank/architecture.md`](../.kilocode/rules/memory-bank/architecture.md) — update all references; update document index entries for renamed arch files
- [`.kilocode/rules/memory-bank/tech.md`](../.kilocode/rules/memory-bank/tech.md) — update document index entries for renamed arch files
- [`.kilocode/rules/memory-bank/context.md`](../.kilocode/rules/memory-bank/context.md) — update references as needed

### Step 7 — Update Internal Protocol Channel Name

The PolyTransport channel named `'applet'` (used in `PostMessageTransport` between responder and mod-app worker) should be renamed to `'app'` for consistency with the new naming conventions.

Files affected:
- [`src/apps/app-bootstrap.esm.js`](../src/apps/app-bootstrap.esm.js) — `transport.requestChannel('applet')` → `transport.requestChannel('app')`
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) — same
- [`test/app-bootstrap.test.js`](../test/app-bootstrap.test.js) — same
- [`test/static-content.test.js`](../test/static-content.test.js) — same
- [`test/security-validation.test.js`](../test/security-validation.test.js) — same
- [`test/responder-process.test.js`](../test/responder-process.test.js) — same
- [`arch/refactor-with-poly-transport.md`](../arch/refactor-with-poly-transport.md) — update channel name in diagrams and specs (covered in Step 5)

---

## Transition Approach

The transition can be done in a single pass or incrementally:

- **Single pass** (recommended): Complete all steps in one coordinated change. Avoids a mixed-terminology codebase and ensures all cross-references are updated together.
- **Incremental**: Update source code first (Step 1), then tests (Step 2), then docs (Steps 3–6). Acceptable if the full pass is too large for a single session.

In either case, a global search for `applet` (case-insensitive) after the transition should be used to catch any missed occurrences before committing.

[supplemental keywords: terminology, naming, applet rename, mod-app, modular application, servlet, handler, inside-out architecture, hot-swap, independent deployment, JSMAWS acronym]
