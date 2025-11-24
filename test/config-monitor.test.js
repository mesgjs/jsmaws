/**
 * Tests for JSMAWS Configuration Monitor
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ConfigMonitor, createConfigMonitor } from "../src/config-monitor.esm.js";
import { NANOS } from '../src/vendor.esm.js';

Deno.test("ConfigMonitor - creates instance", () => {
	const monitor = new ConfigMonitor('test.slid', null);

	assertExists(monitor);
	assertEquals(monitor.configPath, 'test.slid');
	assertEquals(monitor.isMonitoring, false);
	assertEquals(monitor.debounceDelay, 500);
});

Deno.test("ConfigMonitor - sets callback", () => {
	const callback = () => {};
	const monitor = new ConfigMonitor('test.slid', callback);

	assertEquals(monitor.onConfigChange, callback);
});

Deno.test("ConfigMonitor - factory function creates instance", () => {
	const callback = () => {};
	const monitor = createConfigMonitor('test.slid', callback);

	assertExists(monitor);
	assertEquals(monitor.configPath, 'test.slid');
	assertEquals(monitor.onConfigChange, callback);
});

Deno.test("ConfigMonitor - prevents duplicate monitoring", async () => {
	// Create a temporary test file
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		const monitor = new ConfigMonitor(testFile, null);

		// Start monitoring
		const startPromise = monitor.startMonitoring();
		await startPromise;
		assertEquals(monitor.isMonitoring, true);

		// Try to start again - should warn but not error
		await monitor.startMonitoring();
		assertEquals(monitor.isMonitoring, true);

		// Cleanup
		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - stops monitoring", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		const monitor = new ConfigMonitor(testFile, null);

		await monitor.startMonitoring();
		assertEquals(monitor.isMonitoring, true);

		monitor.stopMonitoring();
		assertEquals(monitor.isMonitoring, false);
		assertEquals(monitor.watcher, null);
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles file modification", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		let changeCount = 0;
		let lastConfig = null;

		const callback = (config) => {
			changeCount++;
			lastConfig = config;
		};

		const monitor = new ConfigMonitor(testFile, callback);
		monitor.debounceDelay = 100; // Faster for testing

		// Write initial content
		await Deno.writeTextFile(testFile, '[(test=1)]');

		await monitor.startMonitoring();

		// Wait a bit for initial state
		await new Promise(resolve => setTimeout(resolve, 200));

		// Modify the file
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Wait for debounce and callback
		await new Promise(resolve => setTimeout(resolve, 300));

		// Should have detected the change
		assertEquals(changeCount > 0, true);
		assertExists(lastConfig);

		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - debounces rapid changes", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		let changeCount = 0;

		const callback = () => {
			changeCount++;
		};

		const monitor = new ConfigMonitor(testFile, callback);
		monitor.debounceDelay = 100;

		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Make rapid changes
		await Deno.writeTextFile(testFile, '[(test=2)]');
		await new Promise(resolve => setTimeout(resolve, 50));
		await Deno.writeTextFile(testFile, '[(test=3)]');
		await new Promise(resolve => setTimeout(resolve, 50));
		await Deno.writeTextFile(testFile, '[(test=4)]');

		// Wait for debounce
		await new Promise(resolve => setTimeout(resolve, 300));

		// Should have fewer callbacks than changes due to debouncing
		assertEquals(changeCount <= 2, true);

		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - gets file modification time", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		const monitor = new ConfigMonitor(testFile, null);
		const mtime = await monitor.getFileModificationTime();

		assertExists(mtime);
		assertEquals(typeof mtime, 'number');
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles missing file gracefully", async () => {
	const monitor = new ConfigMonitor('/nonexistent/path/config.slid', null);
	const mtime = await monitor.getFileModificationTime();

	assertEquals(mtime, null);
});

Deno.test("ConfigMonitor - clears debounce timer on stop", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		const monitor = new ConfigMonitor(testFile, null);
		monitor.debounceDelay = 1000; // Long delay

		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Trigger a change
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Stop before debounce completes
		monitor.stopMonitoring();

		assertEquals(monitor.debounceTimer, null);
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - parses SLID configuration", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		let receivedConfig = null;

		const callback = (config) => {
			receivedConfig = config;
		};

		const monitor = new ConfigMonitor(testFile, callback);
		monitor.debounceDelay = 100;

		// Write initial SLID content
		await Deno.writeTextFile(testFile, '[(httpPort=8080 httpsPort=8443)]');

		await monitor.startMonitoring();

		// Wait for initial state
		await new Promise(resolve => setTimeout(resolve, 200));

		// Modify the file to trigger callback
		await Deno.writeTextFile(testFile, '[(httpPort=8080 httpsPort=8443 hostname="test")]');

		// Wait for detection and callback
		await new Promise(resolve => setTimeout(resolve, 300));

		assertExists(receivedConfig);
		assertEquals(receivedConfig.at('httpPort'), 8080);
		assertEquals(receivedConfig.at('httpsPort'), 8443);
		assertEquals(receivedConfig.at('hostname'), 'test');

		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles callback errors gracefully", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		const callback = () => {
			throw new Error('Callback error');
		};

		const monitor = new ConfigMonitor(testFile, callback);
		monitor.debounceDelay = 100;

		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Trigger a change - should not crash
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Wait for error handling
		await new Promise(resolve => setTimeout(resolve, 300));

		// Monitor should still be running
		assertEquals(monitor.isMonitoring, true);

		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - updates last modified time", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		const monitor = new ConfigMonitor(testFile, null);

		assertEquals(monitor.lastModified, null);

		await monitor.updateLastModified();

		assertExists(monitor.lastModified);
		assertEquals(typeof monitor.lastModified, 'number');
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - ignores non-modify events", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		let changeCount = 0;

		const callback = () => {
			changeCount++;
		};

		const monitor = new ConfigMonitor(testFile, callback);
		monitor.debounceDelay = 100;

		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Wait for initial state
		await new Promise(resolve => setTimeout(resolve, 200));

		const initialCount = changeCount;

		// Access the file (may trigger events but not modify)
		await Deno.stat(testFile);

		// Wait to see if any changes are detected
		await new Promise(resolve => setTimeout(resolve, 300));

		// Should not have increased significantly
		assertEquals(changeCount <= initialCount + 1, true);

		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles complex SLID structures", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });

	try {
		let receivedConfig = null;

		const callback = (config) => {
			receivedConfig = config;
		};

		const monitor = new ConfigMonitor(testFile, callback);
		monitor.debounceDelay = 100;

		// Write initial SLID content
		await Deno.writeTextFile(testFile, '[(httpPort=8080)]');

		await monitor.startMonitoring();

		// Wait for initial state
		await new Promise(resolve => setTimeout(resolve, 200));

		// Write complex SLID content with nested structures to trigger callback
		const slid = `[(
			httpPort=8080
			routes=[
				[path='api/users' class=static]
				[path='api/:id' class=int]
			]
		)]`;

		await Deno.writeTextFile(testFile, slid);

		// Wait for detection and callback
		await new Promise(resolve => setTimeout(resolve, 300));

		assertExists(receivedConfig);
		assertEquals(receivedConfig.at('httpPort'), 8080);
		assertExists(receivedConfig.at('routes'));

		monitor.stopMonitoring();
	} finally {
		await Deno.remove(testFile);
	}
});
