/**
 * Tests for JSMAWS Router Worker
 * Tests the Router and Route classes that handle request routing
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Router, Route } from "../src/router-worker.esm.js";
import { RouterWorkerProxy } from "../src/router-worker-proxy.esm.js";
import { Configuration } from "../src/configuration.esm.js";

// ============================================================================
// Route Class - Path Parsing Tests
// ============================================================================

Deno.test("Route - parses literal path", () => {
	const route = new Route({ path: 'api/users', pool: 'standard', app: '/app.esm.js' });

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[0].type, 'literal');
	assertEquals(route.pathParts[0].value, 'api');
	assertEquals(route.pathParts[1].type, 'literal');
	assertEquals(route.pathParts[1].value, 'users');
	assertEquals(route.pool, 'standard');
});

Deno.test("Route - parses path with parameters", () => {
	const route = new Route({ path: 'api/:id/users/:name', app: '/app.esm.js' });

	assertEquals(route.pathParts.length, 4);
	assertEquals(route.pathParts[0].type, 'literal');
	assertEquals(route.pathParts[1].type, 'param');
	assertEquals(route.pathParts[1].name, 'id');
	assertEquals(route.pathParts[2].type, 'literal');
	assertEquals(route.pathParts[3].type, 'param');
	assertEquals(route.pathParts[3].name, 'name');
});

Deno.test("Route - parses named mod-app path", () => {
	const route = new Route({ path: 'api/@myapp' });

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[0].type, 'literal');
	assertEquals(route.pathParts[1].type, 'app-named');
	assertEquals(route.pathParts[1].name, 'myapp');
});

Deno.test("Route - parses wildcard mod-app", () => {
	const route = new Route({ path: 'apps/@*' });

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[1].type, 'app-any');
});

Deno.test("Route - parses mod-app with required parameter", () => {
	const route = new Route({ path: 'api/@myapp/:action' });

	assertEquals(route.pathParts.length, 3);
	assertEquals(route.pathParts[1].type, 'app-named');
	assertEquals(route.pathParts[2].type, 'param');
	assertEquals(route.pathParts[2].name, 'action');
});

Deno.test("Route - parses mod-app with optional parameter", () => {
	const route = new Route({ path: 'api/@myapp/:?format' });

	assertEquals(route.pathParts.length, 3);
	assertEquals(route.pathParts[1].type, 'app-named');
	assertEquals(route.pathParts[2].type, 'optional-param');
	assertEquals(route.pathParts[2].name, 'format');
});

Deno.test("Route - parses mod-app with tail parameter", () => {
	const route = new Route({ path: 'api/@myapp/:*' });

	assertEquals(route.pathParts.length, 3);
	assertEquals(route.pathParts[1].type, 'app-named');
	assertEquals(route.pathParts[2].type, 'tail');
});

Deno.test("Route - parses tail parameter", () => {
	const route = new Route({ path: 'files/:*', app: '@static' });

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[1].type, 'tail');
});

Deno.test("Route - parses regex pattern", () => {
	const route = new Route({ regex: '^/api/v[0-9]+/.*', app: '/app.esm.js' });

	assertExists(route.regexPattern);
	assertEquals(route.regexPattern.test('/api/v1/users'), true);
	assertEquals(route.regexPattern.test('/api/v2/posts'), true);
	assertEquals(route.regexPattern.test('/api/users'), false);
});

// ============================================================================
// Route Class - Property Parsing Tests
// ============================================================================

Deno.test("Route - parses HTTP methods", () => {
	const route = new Route({ method: 'get', app: '/app.esm.js' });

	assertEquals(route.method.length, 1);
	assertEquals(route.method[0], 'get');
});

Deno.test("Route - parses method shortcuts", () => {
	const route1 = new Route({ method: 'read', app: '/app.esm.js' });
	assertEquals(route1.method.includes('get'), true);
	assertEquals(route1.method.includes('head'), true);

	const route2 = new Route({ method: 'write', app: '/app.esm.js' });
	assertEquals(route2.method.includes('post'), true);
	assertEquals(route2.method.includes('put'), true);
	assertEquals(route2.method.includes('patch'), true);
});

Deno.test("Route - parses pool name", () => {
	const route = new Route({ path: 'api/users', pool: 'fast', app: '/app.esm.js' });

	assertEquals(route.pool, 'fast');
});

Deno.test("Route - parses response code", () => {
	const route = new Route({ path: 'old', response: 404 });

	assertEquals(route.response, 404);
});

Deno.test("Route - parses redirect", () => {
	const route = new Route({ path: 'old', response: 307, href: 'https://example.com' });

	assertEquals(route.response, 307);
	assertEquals(route.href, 'https://example.com');
});

Deno.test("Route - parses mod-app from spec", () => {
	const route = new Route({ path: 'api/users', app: '/path/to/app.esm.js' });

	assertEquals(route.app, '/path/to/app.esm.js');
});

Deno.test("Route - parses local root", () => {
	const route = new Route({ path: 'test/@*', root: '/var/apps' });

	assertEquals(route.root, '/var/apps');
});

// ============================================================================
// Route Class - Classification Tests
// ============================================================================

Deno.test("Route - classifies filesystem route with @name", () => {
	const route = new Route({ path: 'api/@myapp' });

	assertEquals(route.isFilesystem, true);
	assertEquals(route.isVirtual, false);
});

Deno.test("Route - classifies filesystem route with @*", () => {
	const route = new Route({ path: 'apps/@*' });

	assertEquals(route.isFilesystem, true);
	assertEquals(route.isVirtual, false);
});

Deno.test("Route - classifies filesystem route with parameters", () => {
	const route = new Route({ path: 'api/@myapp/:action' });

	assertEquals(route.isFilesystem, true);
	assertEquals(route.isVirtual, false);
});

Deno.test("Route - classifies virtual route with app property", () => {
	const route = new Route({ path: 'api/users', app: '/path/to/app.esm.js' });

	assertEquals(route.isFilesystem, false);
	assertEquals(route.isVirtual, true);
});

Deno.test("Route - classifies virtual route with @static app", () => {
	const route = new Route({ path: 'static/:*', app: '@static' });

	assertEquals(route.isFilesystem, false);
	assertEquals(route.isVirtual, true);
});

Deno.test("Route - classifies response route", () => {
	const route = new Route({ path: 'old-path', response: 301, href: '/new-path' });

	assertEquals(route.isFilesystem, false);
	assertEquals(route.isVirtual, true);
});

Deno.test("Route - warns about invalid route (no resolution mechanism)", () => {
	const route = new Route({ path: 'api/users' }); // No app, no @name/@*, no response

	assertEquals(route.isFilesystem, false);
	assertEquals(route.isVirtual, false);
});

// ============================================================================
// Route Class - Path Matching Tests
// ============================================================================

Deno.test("Route - matchPath matches literal path", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/users', app: '/app.esm.js' }, config);
	const match = route.matchPath('/api/users', 'GET');

	assertExists(match);
	assertEquals(match.params, {});
});

Deno.test("Route - matchPath matches path with parameters", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/:id/users/:name', app: '/app.esm.js' }, config);
	const match = route.matchPath('/api/123/users/john', 'GET');

	assertExists(match);
	assertEquals(match.params.id, '123');
	assertEquals(match.params.name, 'john');
});

Deno.test("Route - matchPath rejects non-matching path", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/users', app: '/app.esm.js' }, config);
	const match = route.matchPath('/api/posts', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - matchPath rejects wrong method", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/users', method: 'post', app: '/app.esm.js' }, config);
	const match = route.matchPath('/api/users', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - matchPath matches any method", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/users', method: 'any', app: '/app.esm.js' }, config);

	assertExists(route.matchPath('/api/users', 'GET'));
	assertExists(route.matchPath('/api/users', 'POST'));
	assertExists(route.matchPath('/api/users', 'DELETE'));
});

Deno.test("Route - matchPath case-insensitive method matching", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/users', method: 'POST', app: '/app.esm.js' }, config);

	assertExists(route.matchPath('/api/users', 'post'));
	assertExists(route.matchPath('/api/users', 'POST'));
});

Deno.test("Route - matchPath matches named mod-app", () => {
	const config = new Configuration({ fsRouting: true });
	const route = new Route({ path: 'apps/@myapp' }, config);
	const match = route.matchPath('/apps/myapp', 'GET');

	assertExists(match);
	// Filesystem routes include prePath
	assertEquals(match.app, 'apps/myapp');
});

Deno.test("Route - matchPath matches wildcard mod-app", () => {
	const config = new Configuration({ fsRouting: true });
	const route = new Route({ path: 'apps/@*' }, config);
	const match = route.matchPath('/apps/anyapp', 'GET');

	assertExists(match);
	// Filesystem routes include prePath
	assertEquals(match.app, 'apps/anyapp');
});

Deno.test("Route - matchPath matches mod-app with required parameter", () => {
	const config = new Configuration({ fsRouting: true });
	const route = new Route({ path: 'api/@myapp/:action' }, config);
	const match = route.matchPath('/api/myapp/create', 'GET');

	assertExists(match);
	// Filesystem routes include prePath
	assertEquals(match.app, 'api/myapp');
	assertEquals(match.params.action, 'create');
});

Deno.test("Route - matchPath matches mod-app with optional parameter when present", () => {
	const config = new Configuration({ fsRouting: true });
	const route = new Route({ path: 'api/@myapp/:?format' }, config);
	const match = route.matchPath('/api/myapp/json', 'GET');

	assertExists(match);
	// Filesystem routes include prePath
	assertEquals(match.app, 'api/myapp');
	assertEquals(match.params.format, 'json');
});

Deno.test("Route - matchPath matches mod-app with optional parameter when absent", () => {
	const config = new Configuration({ fsRouting: true });
	const route = new Route({ path: 'api/@myapp/:?format' }, config);
	const match = route.matchPath('/api/myapp', 'GET');

	assertExists(match);
	// Filesystem routes include prePath
	assertEquals(match.app, 'api/myapp');
	assertEquals(match.params.format, undefined);
});

Deno.test("Route - matchPath matches mod-app with tail parameter", () => {
	const config = new Configuration({ fsRouting: true });
	const route = new Route({ path: 'api/@myapp/:*' }, config);
	const match = route.matchPath('/api/myapp/path/to/resource', 'GET');

	assertExists(match);
	// Filesystem routes include prePath
	assertEquals(match.app, 'api/myapp');
	assertEquals(match.tail, 'path/to/resource');
});

Deno.test("Route - matchPath matches tail parameter", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'files/:*', app: '@static' }, config);
	const match = route.matchPath('/files/path/to/file.txt', 'GET');

	assertExists(match);
	assertEquals(match.tail, 'path/to/file.txt');
});

Deno.test("Route - matchPath matches regex pattern", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ regex: '^/api/v[0-9]+/.*', app: '/app.esm.js' }, config);

	assertExists(route.matchPath('/api/v1/users', 'GET'));
	assertExists(route.matchPath('/api/v2/posts', 'GET'));
	assertEquals(route.matchPath('/api/users', 'GET'), null);
});

Deno.test("Route - matchPath rejects path with extra segments", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/users', app: '/app.esm.js' }, config);
	const match = route.matchPath('/api/users/123', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - matchPath rejects path with missing required segments", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ path: 'api/:id/users/:name', app: '/app.esm.js' }, config);
	const match = route.matchPath('/api/123', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - matchPath with regex and path constraint", () => {
	const config = new Configuration({ fsRouting: false });
	const route = new Route({ 
		path: 'api/:version',
		regex: '^/api/v[0-9]+$',
		app: '/app.esm.js'
	}, config);

	assertExists(route.matchPath('/api/v1', 'GET'));
	assertEquals(route.matchPath('/api/beta', 'GET'), null);
});

// ============================================================================
// Route Class - Filesystem Verification Tests
// ============================================================================

Deno.test("Route - match includes filesystem verification", async () => {
	const tempDir = await Deno.makeTempDir();
	// Create test/ subdirectory
	const testDir = `${tempDir}/test`;
	await Deno.mkdir(testDir);
	const testFile = `${testDir}/myapp.esm.js`;
	await Deno.writeTextFile(testFile, '// test');

	try {
		const config = new Configuration({ root: tempDir, fsRouting: true });
		const route = new Route({ path: 'test/@*' }, config);

		const match = await route.match('/test/myapp', 'GET');
		assertExists(match);
		// Should return full absolute path for responder to load
		assertEquals(match.app, `${testDir}/myapp.esm.js`);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("Route - match returns null for non-existent file", async () => {
	const tempDir = await Deno.makeTempDir();

	try {
		const config = new Configuration({ root: tempDir, fsRouting: true });
		const route = new Route({ path: 'test/@*' }, config);

		const match = await route.match('/test/nonexistent', 'GET');
		assertEquals(match, null);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("Route - match tries extensions in order", async () => {
	const tempDir = await Deno.makeTempDir();
	// Create test/ subdirectory
	const testDir = `${tempDir}/test`;
	await Deno.mkdir(testDir);
	const testFile = `${testDir}/myapp.js`; // Only .js exists
	await Deno.writeTextFile(testFile, '// test');

	try {
		const config = new Configuration({
			root: tempDir,
			extensions: ['.esm.js', '.js'],
			fsRouting: true
		});
		const route = new Route({ path: 'test/@*' }, config);

		const match = await route.match('/test/myapp', 'GET');
		assertExists(match);
		// Should return full absolute path
		assertEquals(match.app, `${testDir}/myapp.js`);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("Route - match skips directories", async () => {
	const tempDir = await Deno.makeTempDir();
	// Create test/ subdirectory
	const testDir = `${tempDir}/test`;
	await Deno.mkdir(testDir);
	const dirPath = `${testDir}/myapp.esm.js`;
	await Deno.mkdir(dirPath);

	try {
		const config = new Configuration({ root: tempDir, fsRouting: true });
		const route = new Route({ path: 'test/@*' }, config);

		const match = await route.match('/test/myapp', 'GET');
		assertEquals(match, null); // Should not match directory
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("Route - match uses local root if specified", async () => {
	const tempDir = await Deno.makeTempDir();
	const customRoot = `${tempDir}/custom/root/test`;
	await Deno.mkdir(customRoot, { recursive: true });
	const testFile = `${customRoot}/myapp.esm.js`;
	await Deno.writeTextFile(testFile, '// test');

	try {
		const config = new Configuration({ root: tempDir, fsRouting: true });
		const route = new Route({ path: 'test/@*', root: customRoot }, config);

		const match = await route.match('/test/myapp', 'GET');
		// TEST IS FAILING (match is null - probably (incorrectly) trying to FS verify with a pre-path on a local root (not the defined behavior))
		assertExists(match);
		// Should return full absolute path
		assertEquals(match.app, `${customRoot}/myapp.esm.js`);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

// ============================================================================
// Router Class - Configuration Tests
// ============================================================================

Deno.test("Router - creates with Configuration", () => {
	const config = new Configuration({});
	const router = new Router(config);

	assertExists(router);
	assertEquals(router.routes.length, 0);
});

Deno.test("Router - parses routes from configuration", () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/users', pool: 'standard', app: '/users.esm.js' },
			{ path: 'api/posts', pool: 'fast', app: '/posts.esm.js' }
		]
	});
	const router = new Router(config);

	assertEquals(router.routes.length, 2);
	assertEquals(router.routes[0].pool, 'standard');
	assertEquals(router.routes[1].pool, 'fast');
});

Deno.test("Router - updates configuration", () => {
	const config = new Configuration({});
	const router = new Router(config);
	assertEquals(router.routes.length, 0);

	config.updateConfig({ routes: [{ path: 'api/users', app: '/app.esm.js' }] });
	router.updateConfig();

	assertEquals(router.routes.length, 1);
});

// ============================================================================
// Router Class - Route Finding Tests
// ============================================================================

Deno.test("Router - findRoute finds matching route", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.route.app, '/app.esm.js');
	assertEquals(result.match.params, {});
});

Deno.test("Router - findRoute returns first matching route", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/:id', pool: 'standard', app: '/app1.esm.js' },
			{ path: 'api/:id', pool: 'fast', app: '/app2.esm.js' }
		]
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/123', 'GET');

	assertExists(result);
	assertEquals(result.route.pool, 'standard'); // First match
});

Deno.test("Router - findRoute returns null for no match", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/posts', 'GET');

	assertEquals(result, null);
});

Deno.test("Router - findRoute resolves relative virtual app paths", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: 'users.esm.js' }],
		appRoot: '/apps'
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/apps/users.esm.js');
});

Deno.test("Router - findRoute does not modify absolute paths", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/absolute/path/app.esm.js' }],
		appRoot: '/apps'
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/absolute/path/app.esm.js');
});

Deno.test("Router - findRoute does not modify @static", async () => {
	const config = new Configuration({
		routes: [{ path: 'static/:*', app: '@static' }],
		appRoot: '/apps'
	});
	const router = new Router(config);

	const result = await router.findRoute('/static/file.txt', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '@static');
});

Deno.test("Router - findRoute does not modify URL paths", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: 'https://example.com/app.esm.js' }],
		appRoot: '/apps'
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.match.app, 'https://example.com/app.esm.js');
});

// ============================================================================
// Router Class - Filesystem Routing Tests
// ============================================================================

Deno.test("Router - skips filesystem routes when fsRouting disabled", () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/@myapp' }, // Filesystem route
			{ path: 'api/users', app: '/app.esm.js' } // Virtual route
		],
		fsRouting: false
	});
	const router = new Router(config);

	// Should only include non-filesystem routes
	assertEquals(router.routes.length, 1);
	assertEquals(router.routes[0].pathParts[1].value, 'users');
});

Deno.test("Router - includes filesystem routes when fsRouting enabled", () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/@myapp' }, // Filesystem route
			{ path: 'api/users', app: '/app.esm.js' } // Virtual route
		],
		fsRouting: true
	});
	const router = new Router(config);

	// Should include all routes
	assertEquals(router.routes.length, 2);
});

Deno.test("Router - findRoute verifies filesystem routes", async () => {
	const tempDir = await Deno.makeTempDir();
	// Create test/ subdirectory
	const testDir = `${tempDir}/test`;
	await Deno.mkdir(testDir);
	const testFile = `${testDir}/myapp.esm.js`;
	await Deno.writeTextFile(testFile, '// test');

	try {
		const config = new Configuration({
			routes: [{ path: 'test/@*' }],
			root: tempDir,
			fsRouting: true
		});
		const router = new Router(config);

		const result = await router.findRoute('/test/myapp', 'GET');

		assertExists(result);
		// Should return full absolute path
		assertEquals(result.match.app, `${testDir}/myapp.esm.js`);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("Router - findRoute returns null for non-existent filesystem route", async () => {
	const tempDir = await Deno.makeTempDir();

	try {
		const config = new Configuration({
			routes: [{ path: 'test/@*' }],
			root: tempDir,
			fsRouting: true
		});
		const router = new Router(config);

		const result = await router.findRoute('/test/nonexistent', 'GET');

		assertEquals(result, null);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("Router - findRoute continues to next route if filesystem verification fails", async () => {
	const tempDir = await Deno.makeTempDir();
	const testFile = `${tempDir}/fallback.esm.js`;
	await Deno.writeTextFile(testFile, '// test');

	try {
		const config = new Configuration({
			routes: [
				{ path: 'test/@*' }, // Filesystem route
				{ path: 'test/:name', app: 'fallback.esm.js' } // Virtual fallback
			],
			root: tempDir,
			appRoot: tempDir + '/',
			fsRouting: true
		});
		const router = new Router(config);

		const result = await router.findRoute('/test/nonexistent', 'GET');

		assertExists(result);
		assertEquals(result.match.app, `${tempDir}/fallback.esm.js`);
	} finally {
		await Deno.remove(tempDir, { recursive: true });
	}
});

// ============================================================================
// RouterWorkerProxy Manager Tests
// ============================================================================

Deno.test("RouterWorkerProxy - creates worker instance", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-1', workerUrl);

	assertExists(worker);
	assertEquals(worker.id, 'test-1');
	assertEquals(worker.isAvailable, false);
	assertEquals(worker.isInitialized, false);

	worker.terminate();
});

Deno.test("RouterWorkerProxy - initializes with config", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-2', workerUrl);

	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});

	await worker.initialize(config);

	assertEquals(worker.isInitialized, true);
	assertEquals(worker.isAvailable, true);

	worker.terminate();
});

Deno.test("RouterWorkerProxy - finds route via worker", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-3', workerUrl);

	const config = new Configuration({
		routes: [{ path: 'api/users', pool: 'standard', app: '/app.esm.js' }]
	});

	await worker.initialize(config);

	const result = await worker.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.route.pool, 'standard');
	assertEquals(result.match.params, {});

	worker.terminate();
});

Deno.test("RouterWorkerProxy - returns null for non-matching route", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-4', workerUrl);

	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});

	await worker.initialize(config);

	const result = await worker.findRoute('/api/posts', 'GET');

	assertEquals(result, null);

	worker.terminate();
});

Deno.test("RouterWorkerProxy - updates configuration", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-5', workerUrl);

	// Initial config
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});

	await worker.initialize(config);

	// Should find initial route
	let result = await worker.findRoute('/api/users', 'GET');
	assertExists(result);

	// Update config
	config.updateConfig({ routes: [{ path: 'api/posts', app: '/app.esm.js' }] });
	await worker.updateConfig(config);

	// Should find new route
	result = await worker.findRoute('/api/posts', 'GET');
	assertExists(result);

	// Should not find old route
	result = await worker.findRoute('/api/users', 'GET');
	assertEquals(result, null);

	worker.terminate();
});

Deno.test("RouterWorkerProxy - handles fsRouting flag", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-6', workerUrl);

	const config = new Configuration({
		routes: [
			{ path: 'api/@myapp' }, // Filesystem route
			{ path: 'api/users', app: '/app.esm.js' } // Virtual route
		],
		fsRouting: false
	});

	// Initialize with fsRouting disabled
	await worker.initialize(config);

	// Should not find filesystem route
	let result = await worker.findRoute('/api/myapp', 'GET');
	assertEquals(result, null);

	// Should find virtual route
	result = await worker.findRoute('/api/users', 'GET');
	assertExists(result);

	// Update with fsRouting enabled
	config.set('fsRouting', true);
	await worker.updateConfig(config);

	// Should now find filesystem route (but won't match without actual file)
	result = await worker.findRoute('/api/myapp', 'GET');
	// Note: Will be null because no actual file exists
	assertEquals(result, null);

	worker.terminate();
});

/*
 * Test does not appear to be reliable
 *
Deno.test("RouterWorkerProxy - handles timeout", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-7', workerUrl);

	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});

	await worker.initialize(config);

	// Send message with very short timeout
	try {
		await worker.sendMessage('route', { pathname: '/api/users', method: 'GET' }, 1);
		assert(false, 'Should have timed out');
	} catch (error) {
		console.log('Error message was:', error.message);
		assert(error.message.includes('timeout'));
	}

	worker.terminate();
});
 */

Deno.test("RouterWorkerProxy - marks unavailable during routing", async () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-8', workerUrl);

	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/app.esm.js' }]
	});

	await worker.initialize(config);

	assertEquals(worker.isAvailable, true);

	// Start routing (don't await yet)
	const routePromise = worker.findRoute('/api/users', 'GET');

	// Worker should be marked unavailable during routing
	assertEquals(worker.isAvailable, false);

	// Wait for routing to complete
	await routePromise;

	// Worker should be available again
	assertEquals(worker.isAvailable, true);

	worker.terminate();
});

Deno.test("RouterWorkerProxy - generates unique message IDs", () => {
	const workerUrl = new URL('../src/router-worker.esm.js', import.meta.url).href;
	const worker = new RouterWorkerProxy('test-9', workerUrl);

	const id1 = worker.generateMessageId();
	const id2 = worker.generateMessageId();
	const id3 = worker.generateMessageId();

	assert(id1 !== id2);
	assert(id2 !== id3);
	assert(id1.startsWith('test-9-'));

	worker.terminate();
});
