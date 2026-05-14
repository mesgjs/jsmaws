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

// ============================================================================
// Router Class - Route Groups Tests
// ============================================================================

Deno.test("Router - findRoute matches route in unqualified group", async () => {
	const config = new Configuration({
		routes: [{ group: 'myGroup' }],
		routeGroups: {
			myGroup: [
				{ path: 'api/users', app: '/users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/users.esm.js');
	assertEquals(result.routeGroup, null); // Unqualified groups have no group config
});

Deno.test("Router - findRoute matches route in qualified group", async () => {
	const config = new Configuration({
		routes: [{ group: 'apiGroup' }],
		routeGroups: {
			apiGroup: {
				incpre: '/api',
				routes: [
					{ path: 'api/users', app: '/users.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/users.esm.js');
	assertExists(result.routeGroup); // Qualified groups return group config
	assertEquals(result.routeGroup.incpre, '/api');
});

Deno.test("Router - findRoute skips qualified group when incpre does not match", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'apiGroup' },
			{ path: 'other/path', app: '/other.esm.js' },
		],
		routeGroups: {
			apiGroup: {
				incpre: '/api',
				routes: [
					{ path: 'api/users', app: '/users.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	// /other/path does not match incpre=/api, so group is skipped
	const result = await router.findRoute('/other/path', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/other.esm.js');
	assertEquals(result.routeGroup, null);
});

Deno.test("Router - findRoute skips qualified group when excpre matches", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'apiGroup' },
			{ path: 'api/public', app: '/public.esm.js' },
		],
		routeGroups: {
			apiGroup: {
				excpre: '/api/public',
				routes: [
					{ path: 'api/public', app: '/private.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	// /api/public matches excpre, so group is skipped
	const result = await router.findRoute('/api/public', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/public.esm.js');
});

Deno.test("Router - findRoute skips qualified group when method does not match", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'postGroup' },
			{ path: 'api/data', app: '/get-handler.esm.js' },
		],
		routeGroups: {
			postGroup: {
				method: 'post',
				routes: [
					{ path: 'api/data', app: '/post-handler.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	// GET request does not match method=post group
	const result = await router.findRoute('/api/data', 'GET');

	assertExists(result);
	assertEquals(result.match.app, '/get-handler.esm.js');
});

Deno.test("Router - findRoute matches qualified group with method array", async () => {
	const config = new Configuration({
		routes: [{ group: 'writeGroup' }],
		routeGroups: {
			writeGroup: {
				method: ['post', 'put'],
				routes: [
					{ path: 'api/data', app: '/write-handler.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	const postResult = await router.findRoute('/api/data', 'POST');
	assertExists(postResult);
	assertEquals(postResult.match.app, '/write-handler.esm.js');

	const putResult = await router.findRoute('/api/data', 'PUT');
	assertExists(putResult);

	const getResult = await router.findRoute('/api/data', 'GET');
	assertEquals(getResult, null);
});

Deno.test("Router - findRoute returns null for unknown group", async () => {
	const config = new Configuration({
		routes: [{ group: 'nonExistentGroup' }],
		routeGroups: {},
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');
	assertEquals(result, null);
});

Deno.test("Router - findRoute warns about nested group references", async () => {
	const config = new Configuration({
		routes: [{ group: 'outerGroup' }],
		routeGroups: {
			outerGroup: [
				{ group: 'innerGroup' }, // Nested group reference — not allowed
				{ path: 'api/users', app: '/users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	// Nested group reference is skipped; direct route still matches
	const result = await router.findRoute('/api/users', 'GET');
	assertExists(result);
	assertEquals(result.match.app, '/users.esm.js');
});

Deno.test("Router - findRoute returns routeGroup with scalar authn filter and filters", async () => {
	const config = new Configuration({
		routes: [{ group: 'secureGroup' }],
		routeGroups: {
			secureGroup: {
				authn: '@allow-known', // Scalar authn filter (not config objects)
				requestFilter: { allowHeaders: ['authorization', 'content-type'] },
				responseFilter: { denyHeaders: ['x-internal-*'] },
				routes: [
					{ path: 'api/secure', app: '/secure.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	// With identity present, @allow-known presents the identity
	const authState = { identity: { sub: 'user-123', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/secure', 'GET', null, authState);

	assertExists(result);
	assertExists(result.routeGroup);
	assertEquals(result.routeGroup.authn, '@allow-known');
	assertExists(result.routeGroup.requestFilter);
	assertExists(result.routeGroup.responseFilter);
	assertEquals(result.presentedIdentity.sub, 'user-123');
});

// ============================================================================
// Router Class - Route Group Authn Filter Tests
// ============================================================================

Deno.test("Router - route group @allow-known presents identity when present", async () => {
	const config = new Configuration({
		routes: [{ group: 'knownGroup' }],
		routeGroups: {
			knownGroup: {
				authn: '@allow-known',
				routes: [{ path: 'api/known', app: '/known.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/known', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.presentedIdentity.sub, 'alice');
});

Deno.test("Router - route group @allow-known with implied @allow-all allows null identity (suppressed)", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'knownGroup' },
		],
		routeGroups: {
			knownGroup: {
				authn: '@allow-known',
				routes: [{ path: 'api/known', app: '/known.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	// No identity — @allow-known doesn't match, implied @allow-all at end suppresses identity
	const authState = { identity: null, provider: null };
	const result = await router.findRoute('/api/known', 'GET', null, authState);

	// Implied @allow-all at end allows the request with null identity
	assertExists(result);
	assertEquals(result.match.app, '/known.esm.js'); // Matches via implied @allow-all
	assertEquals(result.presentedIdentity, null); // Identity suppressed
});

Deno.test("Router - route group [@allow-known @deny-all] skips group when no identity", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'knownGroup' },
			{ path: 'api/known', app: '/fallback.esm.js' },
		],
		routeGroups: {
			knownGroup: {
				authn: ['@allow-known', '@deny-all'],
				routes: [{ path: 'api/known', app: '/known.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	// No identity — @allow-known doesn't match, @deny-all skips the group
	const authState = { identity: null, provider: null };
	const result = await router.findRoute('/api/known', 'GET', null, authState);

	// @deny-all skips the group; falls through to fallback
	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route group @allow-all suppresses identity", async () => {
	const config = new Configuration({
		routes: [{ group: 'publicGroup' }],
		routeGroups: {
			publicGroup: {
				authn: '@allow-all',
				routes: [{ path: 'api/public', app: '/public.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/public', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.presentedIdentity, null); // Identity suppressed by @allow-all
});

Deno.test("Router - route group @deny-all skips group", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'deniedGroup' },
			{ path: 'api/denied', app: '/fallback.esm.js' },
		],
		routeGroups: {
			deniedGroup: {
				authn: '@deny-all',
				routes: [{ path: 'api/denied', app: '/denied.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/denied', 'GET', null, authState);

	// @deny-all skips the group; falls through to fallback
	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route group provider name filter presents identity when provider matches", async () => {
	const config = new Configuration({
		routes: [{ group: 'jwtGroup' }],
		routeGroups: {
			jwtGroup: {
				authn: '@jwt', // Only allow @jwt-authenticated users
				routes: [{ path: 'api/jwt-only', app: '/jwt-only.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/jwt-only', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.presentedIdentity.sub, 'alice');
});

Deno.test("Router - route group provider name filter with @allow-all allows non-matching provider (suppressed)", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'jwtGroup' },
		],
		routeGroups: {
			jwtGroup: {
				authn: ['@jwt', '@allow-all'], // Skip implied @allow-known; only present identity if @jwt
				routes: [{ path: 'api/jwt-only', app: '/jwt-only.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	// API key user — not @jwt, so group is skipped (implied @allow-all at end suppresses)
	const authState = { identity: { sub: 'api-user', roles: [], provider: '@api-key' }, provider: '@api-key' };
	const result = await router.findRoute('/api/jwt-only', 'GET', null, authState);

	// Falls through to fallback (implied @allow-all at end)
	assertExists(result);
	assertEquals(result.match.app, '/jwt-only.esm.js'); // Matches via implied @allow-all
	assertEquals(result.presentedIdentity, null); // Identity suppressed
});

Deno.test("Router - route group role check passes when identity has required role", async () => {
	const config = new Configuration({
		routes: [{ group: 'adminGroup' }],
		routeGroups: {
			adminGroup: {
				role: 'admin',
				routes: [{ path: 'api/admin', app: '/admin.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: ['admin', 'user'], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/admin', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.match.app, '/admin.esm.js');
	assertEquals(result.presentedIdentity.sub, 'alice');
});

Deno.test("Router - route group role check skips group when identity lacks required role", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'adminGroup' },
			{ path: 'api/admin', app: '/fallback.esm.js' },
		],
		routeGroups: {
			adminGroup: {
				role: 'admin',
				routes: [{ path: 'api/admin', app: '/admin.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	// User without admin role — role check fails, group skipped
	const authState = { identity: { sub: 'alice', roles: ['user'], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/admin', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route group role check skips group when identity is null", async () => {
	const config = new Configuration({
		routes: [
			{ group: 'adminGroup' },
			{ path: 'api/admin', app: '/fallback.esm.js' },
		],
		routeGroups: {
			adminGroup: {
				role: 'admin',
				routes: [{ path: 'api/admin', app: '/admin.esm.js' }],
			},
		},
	});
	const router = new Router(config);

	// No identity — role check fails (null identity), group skipped
	const authState = { identity: null, provider: null };
	const result = await router.findRoute('/api/admin', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - top-level routes present identity as-is (no filter)", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/users.esm.js' }],
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: ['user'], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/users', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.presentedIdentity.sub, 'alice'); // Identity presented as-is
	assertEquals(result.routeGroup, null); // No route group
});

Deno.test("Router - findRoute with no authState returns null presentedIdentity", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/users.esm.js' }],
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.presentedIdentity, null); // No authState provided
});

// ============================================================================
// Router Class - Host Routes Tests
// ============================================================================

Deno.test("Router - findRoute uses top-level routes when no hostRoutes", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/users.esm.js' }],
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET', 'example.com');

	assertExists(result);
	assertEquals(result.match.app, '/users.esm.js');
});

Deno.test("Router - findRoute uses host-specific routes when hostRoutes configured", async () => {
	const config = new Configuration({
		hostRoutes: {
			'api.example.com': [
				{ path: 'api/users', app: '/api-users.esm.js' },
			],
			'*': [
				{ path: 'api/users', app: '/default-users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	const apiResult = await router.findRoute('/api/users', 'GET', 'api.example.com');
	assertExists(apiResult);
	assertEquals(apiResult.match.app, '/api-users.esm.js');

	const defaultResult = await router.findRoute('/api/users', 'GET', 'other.example.com');
	assertExists(defaultResult);
	assertEquals(defaultResult.match.app, '/default-users.esm.js');
});

Deno.test("Router - findRoute follows hostname alias", async () => {
	const config = new Configuration({
		hostRoutes: {
			'www.example.com': { alias: 'example.com' },
			'example.com': [
				{ path: 'api/users', app: '/users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	// www.example.com is an alias for example.com
	const result = await router.findRoute('/api/users', 'GET', 'www.example.com');
	assertExists(result);
	assertEquals(result.match.app, '/users.esm.js');
});

Deno.test("Router - findRoute falls back to top-level routes when hostname not in hostRoutes", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/fallback.esm.js' }],
		hostRoutes: {
			'api.example.com': [
				{ path: 'api/users', app: '/api-users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	// unknown.example.com not in hostRoutes, no wildcard — falls back to top-level routes
	const result = await router.findRoute('/api/users', 'GET', 'unknown.example.com');
	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - findRoute uses wildcard host when no specific match", async () => {
	const config = new Configuration({
		hostRoutes: {
			'api.example.com': [
				{ path: 'api/users', app: '/api-users.esm.js' },
			],
			'*': [
				{ path: 'api/users', app: '/wildcard-users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET', 'other.example.com');
	assertExists(result);
	assertEquals(result.match.app, '/wildcard-users.esm.js');
});

Deno.test("Router - findRoute uses top-level routes when no hostname provided", async () => {
	const config = new Configuration({
		routes: [{ path: 'api/users', app: '/top-level.esm.js' }],
		hostRoutes: {
			'api.example.com': [
				{ path: 'api/users', app: '/host-specific.esm.js' },
			],
		},
	});
	const router = new Router(config);

	// No hostname provided — uses top-level routes
	const result = await router.findRoute('/api/users', 'GET', null);
	assertExists(result);
	assertEquals(result.match.app, '/top-level.esm.js');
});

Deno.test("Router - findRoute supports group references in hostRoutes", async () => {
	const config = new Configuration({
		hostRoutes: {
			'api.example.com': [
				{ group: 'apiRoutes' },
			],
		},
		routeGroups: {
			apiRoutes: [
				{ path: 'api/users', app: '/users.esm.js' },
			],
		},
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/users', 'GET', 'api.example.com');
	assertExists(result);
	assertEquals(result.match.app, '/users.esm.js');
});

// ============================================================================
// Route Class - responseText and headers Tests
// ============================================================================

Deno.test("Route - parses responseText property", () => {
	const route = new Route({ path: 'api/auth', response: 401, responseText: 'Unauthorized' });

	assertEquals(route.responseText, 'Unauthorized');
	assertEquals(route.response, 401);
});

Deno.test("Route - responseText defaults to null when not specified", () => {
	const route = new Route({ path: 'api/auth', response: 401 });

	assertEquals(route.responseText, null);
});

Deno.test("Route - parses headers property for response routes", () => {
	const route = new Route({
		path: 'api/auth',
		response: 401,
		headers: { 'www-authenticate': 'Basic realm="My App"' },
	});

	assertEquals(route.headers['www-authenticate'], 'Basic realm="My App"');
});

Deno.test("Route - headers defaults to empty object when not specified", () => {
	const route = new Route({ path: 'api/auth', response: 401 });

	assertEquals(typeof route.headers, 'object');
	assertEquals(Object.keys(route.headers).length, 0);
});

Deno.test("Route - result getter includes responseText and headers", () => {
	const route = new Route({
		path: 'api/auth',
		response: 401,
		responseText: 'Unauthorized',
		headers: { 'www-authenticate': 'Basic realm="My App"' },
	});

	const result = route.result;
	assertEquals(result.responseText, 'Unauthorized');
	assertEquals(result.headers['www-authenticate'], 'Basic realm="My App"');
	assertEquals(result.response, 401);
});

Deno.test("Router - findRoute returns responseText and headers for response routes", async () => {
	const config = new Configuration({
		routes: [
			{
				path: 'api/protected',
				response: 401,
				responseText: 'Unauthorized',
				headers: { 'www-authenticate': 'Basic realm="My App"' },
			},
		],
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/protected', 'GET');

	assertExists(result);
	assertEquals(result.route.response, 401);
	assertEquals(result.route.responseText, 'Unauthorized');
	assertEquals(result.route.headers['www-authenticate'], 'Basic realm="My App"');
});

Deno.test("Router - findRoute returns responseText and headers from route group", async () => {
	const config = new Configuration({
		routes: [{ group: 'challengeGroup' }],
		routeGroups: {
			challengeGroup: {
				authn: '@allow-all',
				routes: [
					{
						path: 'api/protected',
						response: 401,
						responseText: 'Unauthorized',
						headers: { 'www-authenticate': 'Basic realm="My App"' },
					},
				],
			},
		},
	});
	const router = new Router(config);

	const result = await router.findRoute('/api/protected', 'GET');

	assertExists(result);
	assertEquals(result.route.response, 401);
	assertEquals(result.route.responseText, 'Unauthorized');
	assertEquals(result.route.headers['www-authenticate'], 'Basic realm="My App"');
});

// ============================================================================
// Router Class - Route-Level authn/role Filtering Tests
// ============================================================================

Deno.test("Router - route-level @allow-known presents identity when present", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/protected', authn: '@allow-known', app: '/protected.esm.js' },
		],
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/protected', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.presentedIdentity.sub, 'alice');
});

Deno.test("Router - route-level @allow-known skips route when no identity (implied @allow-all at end)", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/protected', authn: '@allow-known', app: '/protected.esm.js' },
			{ path: 'api/protected', app: '/fallback.esm.js' },
		],
	});
	const router = new Router(config);

	// No identity — @allow-known doesn't match, implied @allow-all at end matches without identity
	const authState = { identity: null, provider: null };
	const result = await router.findRoute('/api/protected', 'GET', null, authState);

	// Implied @allow-all at end allows the request with null identity
	assertExists(result);
	assertEquals(result.match.app, '/protected.esm.js'); // Matches via implied @allow-all
	assertEquals(result.presentedIdentity, null);
});

Deno.test("Router - route-level [@allow-known @deny-all] skips route when no identity", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/protected', authn: ['@allow-known', '@deny-all'], app: '/protected.esm.js' },
			{ path: 'api/protected', app: '/fallback.esm.js' },
		],
	});
	const router = new Router(config);

	// No identity — @allow-known doesn't match, @deny-all skips the route
	const authState = { identity: null, provider: null };
	const result = await router.findRoute('/api/protected', 'GET', null, authState);

	// @deny-all skips the route; falls through to fallback
	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route-level @allow-all suppresses identity", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/public', authn: '@allow-all', app: '/public.esm.js' },
		],
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/public', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.presentedIdentity, null); // Identity suppressed by @allow-all
});

Deno.test("Router - route-level @deny-all skips route", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/denied', authn: '@deny-all', app: '/denied.esm.js' },
			{ path: 'api/denied', app: '/fallback.esm.js' },
		],
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/denied', 'GET', null, authState);

	// @deny-all skips the route; falls through to fallback
	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route-level authn overrides group-level authn", async () => {
	// Group has @allow-all (suppresses identity), but route has @allow-known (presents identity)
	const config = new Configuration({
		routes: [{ group: 'publicGroup' }],
		routeGroups: {
			publicGroup: {
				authn: '@allow-all', // Group suppresses identity
				routes: [
					// Route overrides with @allow-known — presents identity if present
					{ path: 'api/mixed', authn: '@allow-known', app: '/mixed.esm.js' },
				],
			},
		},
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/mixed', 'GET', null, authState);

	assertExists(result);
	// Route-level @allow-known overrides group-level @allow-all; identity is presented
	assertEquals(result.presentedIdentity.sub, 'alice');
});

Deno.test("Router - route-level role check passes when identity has required role", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/admin', role: 'admin', app: '/admin.esm.js' },
		],
	});
	const router = new Router(config);

	const authState = { identity: { sub: 'alice', roles: ['admin', 'user'], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/admin', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.match.app, '/admin.esm.js');
	assertEquals(result.presentedIdentity.sub, 'alice');
});

Deno.test("Router - route-level role check skips route when identity lacks required role", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/admin', role: 'admin', app: '/admin.esm.js' },
			{ path: 'api/admin', app: '/fallback.esm.js' },
		],
	});
	const router = new Router(config);

	// User without admin role — role check fails, route skipped
	const authState = { identity: { sub: 'alice', roles: ['user'], provider: '@jwt' }, provider: '@jwt' };
	const result = await router.findRoute('/api/admin', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route-level role check skips route when identity is null", async () => {
	const config = new Configuration({
		routes: [
			{ path: 'api/admin', role: 'admin', app: '/admin.esm.js' },
			{ path: 'api/admin', app: '/fallback.esm.js' },
		],
	});
	const router = new Router(config);

	// No identity — role check fails (null identity), route skipped
	const authState = { identity: null, provider: null };
	const result = await router.findRoute('/api/admin', 'GET', null, authState);

	assertExists(result);
	assertEquals(result.match.app, '/fallback.esm.js');
});

Deno.test("Router - route-level authn/role on response route (WWW-Authenticate challenge pattern)", async () => {
	// Pattern from auth-revisions-20260510.md 2026-05-14-A:
	// Route 1: @allow-known @deny-all — dispatches to mod-app when authenticated
	// Route 2: @allow-all — returns 401 with WWW-Authenticate when not authenticated
	const config = new Configuration({
		routes: [
			{
				path: 'api/protected',
				authn: ['@allow-known', '@deny-all'],
				app: '/api.esm.js',
			},
			{
				path: 'api/protected',
				authn: '@allow-all',
				response: 401,
				responseText: 'Unauthorized',
				headers: { 'www-authenticate': 'Basic realm="My App"' },
			},
		],
	});
	const router = new Router(config);

	// Authenticated request — dispatches to mod-app
	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const authedResult = await router.findRoute('/api/protected', 'GET', null, authState);
	assertExists(authedResult);
	assertEquals(authedResult.match.app, '/api.esm.js');
	assertEquals(authedResult.presentedIdentity.sub, 'alice');

	// Unauthenticated request — returns 401 challenge
	const unauthState = { identity: null, provider: null };
	const unauthResult = await router.findRoute('/api/protected', 'GET', null, unauthState);
	assertExists(unauthResult);
	assertEquals(unauthResult.route.response, 401);
	assertEquals(unauthResult.route.responseText, 'Unauthorized');
	assertEquals(unauthResult.route.headers['www-authenticate'], 'Basic realm="My App"');
	assertEquals(unauthResult.presentedIdentity, null); // Identity suppressed by @allow-all
});

Deno.test("Router - route-level authn inside group (protected+challenge pair in group)", async () => {
	// Pattern: protected+challenge route pairs inside a group (groups may not contain other groups)
	const config = new Configuration({
		routes: [{ group: 'apiGroup' }],
		routeGroups: {
			apiGroup: {
				incpre: '/api',
				routes: [
					{
						path: 'api/protected',
						authn: ['@allow-known', '@deny-all'],
						app: '/api.esm.js',
					},
					{
						path: 'api/protected',
						authn: '@allow-all',
						response: 401,
						responseText: 'Unauthorized',
						headers: { 'www-authenticate': 'Basic realm="My App"' },
					},
				],
			},
		},
	});
	const router = new Router(config);

	// Authenticated request — dispatches to mod-app
	const authState = { identity: { sub: 'alice', roles: [], provider: '@jwt' }, provider: '@jwt' };
	const authedResult = await router.findRoute('/api/protected', 'GET', null, authState);
	assertExists(authedResult);
	assertEquals(authedResult.match.app, '/api.esm.js');

	// Unauthenticated request — returns 401 challenge
	const unauthState = { identity: null, provider: null };
	const unauthResult = await router.findRoute('/api/protected', 'GET', null, unauthState);
	assertExists(unauthResult);
	assertEquals(unauthResult.route.response, 401);
	assertEquals(unauthResult.route.headers['www-authenticate'], 'Basic realm="My App"');
});
