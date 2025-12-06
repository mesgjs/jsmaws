/**
 * Applet Bootstrap Module Tests
 * Tests for environment lockdown and controlled initialization
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';

// Test helper to create a worker and wait for it to be ready
async function createTestWorker (appletCode) {
	const bootstrapPath = new URL('../src/applets/bootstrap.esm.js', import.meta.url).href;

	// Create a data URL for the test applet
	const appletUrl = `data:application/javascript;base64,${btoa(appletCode)}`;

	const worker = new Worker(bootstrapPath, {
		type: 'module',
		deno: {
			permissions: {
				read: false,
				write: false,
				net: false,
				env: false,
				run: false,
				import: true,
			}
		}
	});

	// Send bootstrap message
	worker.postMessage({
		type: 'bootstrap',
		appletPath: appletUrl
	});

	return { worker, appletUrl };
}

Deno.test('Bootstrap - console methods are filtered', async () => {
	const appletCode = `
		// Test approved methods exist
		const approved = ['assert', 'debug', 'dir', 'dirxml', 'error', 'info', 'log', 'table', 'warn'];
		const results = approved.map(method => typeof console[method] === 'function');

		// Test unapproved methods don't exist
		const unapproved = ['clear', 'count', 'group', 'time', 'trace'];
		const blocked = unapproved.map(method => typeof console[method] === 'undefined');

		self.postMessage({
			type: 'result',
			approved: results.every(r => r),
			blocked: blocked.every(r => r)
		});
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.approved, true, 'All approved console methods should exist');
	assertEquals(result.blocked, true, 'Unapproved console methods should not exist');

	worker.terminate();
});

Deno.test('Bootstrap - console is frozen', async () => {
	const appletCode = `
		let canModify = false;
		try {
			console.log = () => {};
			canModify = true;
		} catch (e) {
			canModify = false;
		}

		self.postMessage({
			type: 'result',
			frozen: !canModify
		});
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.frozen, true, 'Console should be frozen');
	worker.terminate();
});

Deno.test('Bootstrap - Deno APIs are filtered', async () => {
	const appletCode = `
		// Test approved APIs exist
		const approved = ['build', 'version', 'inspect', 'errors'];
		const results = approved.map(api => api in Deno);

		// Test unapproved APIs don't exist
		const unapproved = ['readFile', 'writeFile', 'remove', 'mkdir', 'run', 'exit'];
		const blocked = unapproved.map(api => !(api in Deno));

		self.postMessage({
			type: 'result',
			approved: results.every(r => r),
			blocked: blocked.every(r => r)
		});
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.approved, true, 'All approved Deno APIs should exist');
	assertEquals(result.blocked, true, 'Unapproved Deno APIs should not exist');
	worker.terminate();
});

Deno.test('Bootstrap - Deno is frozen', async () => {
	const appletCode = `
		let canModify = false;
		try {
			Deno.inspect = () => {};
			canModify = true;
		} catch (e) {
			canModify = false;
		}

		self.postMessage({
			type: 'result',
			frozen: !canModify
		});
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.frozen, true, 'Deno should be frozen');
	worker.terminate();
});

Deno.test('Bootstrap - console.log sends postMessage', async () => {
	const appletCode = `
		console.log('test message');
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'console') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.level, 'log');
	assertEquals(result.content, 'test message');
	worker.terminate();
});

Deno.test('Bootstrap - console.error sends postMessage', async () => {
	const appletCode = `
		console.error('error message');
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'console') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.level, 'error');
	assertEquals(result.content, 'error message');
	worker.terminate();
});

Deno.test('Bootstrap - console.assert sends error on failure', async () => {
	const appletCode = `
		console.assert(false, 'assertion failed');
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'console') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.level, 'error');
	assert(result.content.includes('Assertion failed'));
	assert(result.content.includes('assertion failed'));
	worker.terminate();
});

Deno.test('Bootstrap - console methods format multiple arguments', async () => {
	const appletCode = `
		console.log('arg1', 'arg2', 123);
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'console') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.level, 'log');
	assert(result.content.includes('arg1'));
	assert(result.content.includes('arg2'));
	assert(result.content.includes('123'));
	worker.terminate();
});

Deno.test('Bootstrap - applet loads and executes', async () => {
	const appletCode = `
		self.addEventListener('message', (event) => {
			if (event.data.type === 'ping') {
				self.postMessage({ type: 'pong', value: 42 });
			}
		});
	`;

	const { worker } = await createTestWorker(appletCode);

	// Wait a bit for applet to load
	await new Promise(resolve => setTimeout(resolve, 100));

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'pong') {
				resolve(event.data);
			}
		};
		worker.postMessage({ type: 'ping' });
	});

	assertEquals(result.value, 42);
	worker.terminate();
});

Deno.test('Bootstrap - applet error is caught and reported', async () => {
	const appletCode = `
		throw new Error('Intentional error');
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'error') {
				resolve(event.data);
			}
		};
	});

	assertEquals(typeof result.error, 'string');
	assert(result.error.includes('Intentional error'));
	assertExists(result.stack);
	worker.terminate();
});

Deno.test('Bootstrap - Deno.inspect is available for formatting', async () => {
	const appletCode = `
		const obj = { a: 1, b: 2 };
		const formatted = Deno.inspect(obj);
		self.postMessage({ type: 'result', formatted });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});

	assert(result.formatted.includes('a'));
	assert(result.formatted.includes('1'));
	worker.terminate();
});

Deno.test('Bootstrap - Deno.errors namespace is available', async () => {
	const appletCode = `
		const hasErrors = typeof Deno.errors === 'object';
		const hasNotFound = typeof Deno.errors.NotFound === 'function';
		self.postMessage({ type: 'result', hasErrors, hasNotFound });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});

	assertEquals(result.hasErrors, true);
	assertEquals(result.hasNotFound, true);
	worker.terminate();
});
