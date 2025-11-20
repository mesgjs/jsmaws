/**
 * Tests for JSMAWS Router
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Router, Route } from "../src/router.esm.js";
import { NANOS } from '../src/vendor.esm.js';

Deno.test("Route - parses literal path", () => {
	const spec = new NANOS({ path: 'api/users', 'class': 'static' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[0].type, 'literal');
	assertEquals(route.pathParts[0].value, 'api');
	assertEquals(route.pathParts[1].type, 'literal');
	assertEquals(route.pathParts[1].value, 'users');
	assertEquals(route.class, 'static');
});

Deno.test("Route - parses path with parameters", () => {
	const spec = new NANOS({ path: 'api/:id/users/:name' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 4);
	assertEquals(route.pathParts[0].type, 'literal');
	assertEquals(route.pathParts[1].type, 'param');
	assertEquals(route.pathParts[1].name, 'id');
	assertEquals(route.pathParts[2].type, 'literal');
	assertEquals(route.pathParts[3].type, 'param');
	assertEquals(route.pathParts[3].name, 'name');
});

Deno.test("Route - parses applet paths", () => {
	const spec = new NANOS({ path: 'api/@myapp/action' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 3);
	assertEquals(route.pathParts[0].type, 'literal');
	assertEquals(route.pathParts[1].type, 'applet-named');
	assertEquals(route.pathParts[1].name, 'myapp');
	assertEquals(route.pathParts[2].type, 'literal');
});

Deno.test("Route - parses wildcard applet", () => {
	const spec = new NANOS({ path: 'apps/@*' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[1].type, 'applet-any');
});

Deno.test("Route - parses tail parameter", () => {
	const spec = new NANOS({ path: 'files/:*' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 2);
	assertEquals(route.pathParts[1].type, 'tail');
});

Deno.test("Route - parses optional parameters", () => {
	const spec = new NANOS({ path: 'api/@app/:?format' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 3);
	assertEquals(route.pathParts[2].type, 'optional-param');
	assertEquals(route.pathParts[2].name, 'format');
});

Deno.test("Route - parses regex pattern", () => {
	const spec = new NANOS({ regex: '^/api/v[0-9]+/.*' });
	const route = new Route(spec);

	assertExists(route.regexPattern);
	assertEquals(route.regexPattern.test('/api/v1/users'), true);
	assertEquals(route.regexPattern.test('/api/v2/posts'), true);
	assertEquals(route.regexPattern.test('/api/users'), false);
});

Deno.test("Route - parses HTTP methods", () => {
	const spec = new NANOS({ method: 'get' });
	const route = new Route(spec);

	assertEquals(route.method.length, 1);
	assertEquals(route.method[0], 'get');
});

Deno.test("Route - parses method shortcuts", () => {
	const spec1 = new NANOS({ method: 'read' });
	const route1 = new Route(spec1);
	assertEquals(route1.method.includes('get'), true);
	assertEquals(route1.method.includes('head'), true);

	const spec2 = new NANOS({ method: 'write' });
	const route2 = new Route(spec2);
	assertEquals(route2.method.includes('post'), true);
	assertEquals(route2.method.includes('put'), true);
	assertEquals(route2.method.includes('patch'), true);
});

Deno.test("Route - parses WebSocket flag", () => {
	const spec = new NANOS({ ws: '@t' });
	const route = new Route(spec);

	assertEquals(route.ws, true);
});

Deno.test("Route - parses response code", () => {
	const spec = new NANOS({ response: 404 });
	const route = new Route(spec);

	assertEquals(route.response, 404);
});

Deno.test("Route - parses redirect", () => {
	const spec = new NANOS({ response: 307, href: 'https://example.com' });
	const route = new Route(spec);

	assertEquals(route.response, 307);
	assertEquals(route.href, 'https://example.com');
});

Deno.test("Route - matches literal path", () => {
	const spec = new NANOS({ path: 'api/users' });
	const route = new Route(spec);
	const match = route.match('/api/users', 'GET');

	assertExists(match);
	assertEquals(match.params, {});
});

Deno.test("Route - matches path with parameters", () => {
	const spec = new NANOS({ path: 'api/:id/users/:name' });
	const route = new Route(spec);
	const match = route.match('/api/123/users/john', 'GET');

	assertExists(match);
	assertEquals(match.params.id, '123');
	assertEquals(match.params.name, 'john');
});

Deno.test("Route - rejects non-matching path", () => {
	const spec = new NANOS({ path: 'api/users' });
	const route = new Route(spec);
	const match = route.match('/api/posts', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - rejects wrong method", () => {
	const spec = new NANOS({ path: 'api/users', method: 'post' });
	const route = new Route(spec);
	const match = route.match('/api/users', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - matches any method", () => {
	const spec = new NANOS({ path: 'api/users', method: 'any' });
	const route = new Route(spec);

	assertExists(route.match('/api/users', 'GET'));
	assertExists(route.match('/api/users', 'POST'));
	assertExists(route.match('/api/users', 'DELETE'));
});

Deno.test("Route - matches applet path", () => {
	const spec = new NANOS({ path: 'apps/@myapp/action' });
	const route = new Route(spec);
	const match = route.match('/apps/myapp/action', 'GET');

	assertExists(match);
	assertEquals(match.app, 'myapp');
});

Deno.test("Route - matches wildcard applet", () => {
	const spec = new NANOS({ path: 'apps/@*' });
	const route = new Route(spec);
	const match = route.match('/apps/anyapp', 'GET');

	assertExists(match);
	assertEquals(match.app, 'anyapp');
});

Deno.test("Route - matches tail parameter", () => {
	const spec = new NANOS({ path: 'files/:*' });
	const route = new Route(spec);
	const match = route.match('/files/path/to/file.txt', 'GET');

	assertExists(match);
	assertEquals(match.tail, 'path/to/file.txt');
});

Deno.test("Route - matches optional parameter when present", () => {
	const spec = new NANOS({ path: 'api/@app/:?format' });
	const route = new Route(spec);
	const match = route.match('/api/myapp/json', 'GET');

	assertExists(match);
	assertEquals(match.app, 'myapp');
	assertEquals(match.params.format, 'json');
});

Deno.test("Route - matches optional parameter when absent", () => {
	const spec = new NANOS({ path: 'api/@app/:?format' });
	const route = new Route(spec);
	const match = route.match('/api/myapp', 'GET');

	assertExists(match);
	assertEquals(match.app, 'myapp');
	assertEquals(match.params.format, undefined);
});

Deno.test("Route - matches regex pattern", () => {
	const spec = new NANOS({ regex: '^/api/v[0-9]+/.*' });
	const route = new Route(spec);

	assertExists(route.match('/api/v1/users', 'GET'));
	assertExists(route.match('/api/v2/posts', 'GET'));
	assertEquals(route.match('/api/users', 'GET'), null);
});

Deno.test("Router - creates with empty config", () => {
	const router = new Router();

	assertExists(router);
	assertEquals(router.routes.length, 0);
	assertEquals(router.appRoot, '');
	assertEquals(router.root, '');
});

Deno.test("Router - parses appRoot", () => {
	const config = new NANOS({ appRoot: '/apps' });
	const router = new Router(config);

	assertEquals(router.appRoot, '/apps/');
});

Deno.test("Router - parses root", () => {
	const config = new NANOS({ root: '/var/www' });
	const router = new Router(config);

	assertEquals(router.root, '/var/www/');
});

Deno.test("Router - parses routes from NANOS", () => {
	const route1 = new NANOS({ path: 'api/users', 'class': 'static' });
	const route2 = new NANOS({ path: 'api/posts', 'class': 'int' });
	const routes = new NANOS([route1, route2]);

	const config = new NANOS({ routes });
	const router = new Router(config);

	assertEquals(router.routes.length, 2);
	assertEquals(router.routes[0].class, 'static');
	assertEquals(router.routes[1].class, 'int');
});

Deno.test("Router - finds matching route", () => {
	const route1 = new NANOS({ path: 'api/users', 'class': 'static' });
	const routes = new NANOS([route1]);
	const config = new NANOS({ routes });

	const router = new Router(config);
	const result = router.findRoute('/api/users', 'GET');

	assertExists(result);
	assertEquals(result.route.class, 'static');
	assertEquals(result.match.params, {});
});

Deno.test("Router - returns first matching route", () => {
	const route1 = new NANOS({ path: 'api/:id', 'class': 'static' });
	const route2 = new NANOS({ path: 'api/:id', 'class': 'int' });
	const routes = new NANOS([route1, route2]);
	const config = new NANOS({ routes });

	const router = new Router(config);
	const result = router.findRoute('/api/123', 'GET');

	assertExists(result);
	assertEquals(result.route.class, 'static'); // First match
});

Deno.test("Router - returns null for no matching route", () => {
	const route1 = new NANOS({ path: 'api/users' });
	const routes = new NANOS([route1]);
	const config = new NANOS({ routes });

	const router = new Router(config);
	const result = router.findRoute('/api/posts', 'GET');

	assertEquals(result, null);
});

Deno.test("Router - updates configuration", () => {
	const router = new Router();
	assertEquals(router.routes.length, 0);

	const route1 = new NANOS({ path: 'api/users' });
	const routes = new NANOS([route1]);
	const newConfig = new NANOS({ routes, appRoot: '/apps' });

	router.updateConfig(newConfig);

	assertEquals(router.routes.length, 1);
	assertEquals(router.appRoot, '/apps/');
});

Deno.test("Route - complex path with mixed parts", () => {
	const spec = new NANOS({ path: 'api/v1/:version/@app/action/:id/:?format' });
	const route = new Route(spec);
	const match = route.match('/api/v1/2/myapp/action/123/json', 'GET');

	assertExists(match);
	assertEquals(match.params.version, '2');
	assertEquals(match.app, 'myapp');
	assertEquals(match.params.id, '123');
	assertEquals(match.params.format, 'json');
});

Deno.test("Route - rejects path with extra segments", () => {
	const spec = new NANOS({ path: 'api/users' });
	const route = new Route(spec);
	const match = route.match('/api/users/123', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - rejects path with missing required segments", () => {
	const spec = new NANOS({ path: 'api/:id/users/:name' });
	const route = new Route(spec);
	const match = route.match('/api/123', 'GET');

	assertEquals(match, null);
});

Deno.test("Route - parses applet from spec", () => {
	const spec = new NANOS({ app: '/path/to/app.esm.js' });
	const route = new Route(spec);

	assertEquals(route.app, '/path/to/app.esm.js');
	assertEquals(route.isVirtual, true);
});

Deno.test("Route - parses local root", () => {
	const spec = new NANOS({ root: '/var/apps' });
	const route = new Route(spec);

	assertEquals(route.root, '/var/apps');
});

Deno.test("Route - case-insensitive method matching", () => {
	const spec = new NANOS({ path: 'api/users', method: 'POST' });
	const route = new Route(spec);

	assertExists(route.match('/api/users', 'post'));
	assertExists(route.match('/api/users', 'POST'));
});

Deno.test("Route - empty path matches root", () => {
	const spec = new NANOS({ path: '' });
	const route = new Route(spec);

	assertEquals(route.pathParts.length, 0);
});

Deno.test("Route - regex with path constraint", () => {
	const spec = new NANOS({ 
		path: 'api/:version',
		regex: '^/api/v[0-9]+$'
	});
	const route = new Route(spec);

	assertExists(route.match('/api/v1', 'GET'));
	assertEquals(route.match('/api/beta', 'GET'), null);
});
