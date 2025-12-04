/**
 * Tests for JSMAWS Configuration Monitor
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ConfigMonitor, createConfigMonitor } from "../src/config-monitor.esm.js";
import { NANOS } from '../src/vendor.esm.js';

Deno.test("ConfigMonitor - creates instance", () => {
	const monitor = new ConfigMonitor('test.slid', null);

	try {
		assertExists(monitor);
		assertEquals(monitor.configPath, 'test.slid');
		assertEquals(monitor.isMonitoring, false);
		assertEquals(monitor.debounceDelay, 500);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("ConfigMonitor - sets callback", () => {
	const callback = () => {};
	const monitor = new ConfigMonitor('test.slid', callback);

	try {
		assertEquals(monitor.onChange, callback);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("ConfigMonitor - factory function creates instance", () => {
	const callback = () => {};
	const monitor = createConfigMonitor('test.slid', callback);

	try {
		assertExists(monitor);
		assertEquals(monitor.configPath, 'test.slid');
		assertEquals(monitor.onChange, callback);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("ConfigMonitor - prevents duplicate monitoring", async () => {
	// Create a temporary test file
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new ConfigMonitor(testFile, null);

	try {
		// Start monitoring
		const startPromise = monitor.startMonitoring();
		await startPromise;
		assertEquals(monitor.isMonitoring, true);

		// Try to start again - should warn but not error
		await monitor.startMonitoring();
		assertEquals(monitor.isMonitoring, true);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - stops monitoring", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new ConfigMonitor(testFile, null);

	try {
		await monitor.startMonitoring();
		assertEquals(monitor.isMonitoring, true);

		monitor.stopMonitoring();
		assertEquals(monitor.isMonitoring, false);
		assertEquals(monitor.watcher, null);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles file modification", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let changeCount = 0;
	let lastConfig = null;

	const callback = (config) => {
		changeCount++;
		lastConfig = config;
	};

	const monitor = new ConfigMonitor(testFile, callback);
	monitor.debounceDelay = 100; // Faster for testing

	try {
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
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - debounces rapid changes", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let changeCount = 0;

	const callback = () => {
		changeCount++;
	};

	const monitor = new ConfigMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
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
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - gets file modification time", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new ConfigMonitor(testFile, null);

	try {
		const mtime = await monitor.getFileModificationTime();

		assertExists(mtime);
		assertEquals(typeof mtime, 'number');
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles missing file gracefully", async () => {
	const monitor = new ConfigMonitor('/nonexistent/path/config.slid', null);

	try {
		const mtime = await monitor.getFileModificationTime();

		assertEquals(mtime, null);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("ConfigMonitor - clears debounce timer on stop", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new ConfigMonitor(testFile, null);
	monitor.debounceDelay = 1000; // Long delay

	try {
		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Trigger a change
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Stop before debounce completes
		monitor.stopMonitoring();

		assertEquals(monitor.debounceTimer, null);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - parses SLID configuration", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let receivedConfig = null;

	const callback = (config) => {
		receivedConfig = config;
	};

	const monitor = new ConfigMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
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
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles callback errors gracefully", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const callback = () => {
		throw new Error('Callback error');
	};

	const monitor = new ConfigMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Trigger a change - should not crash
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Wait for error handling
		await new Promise(resolve => setTimeout(resolve, 300));

		// Monitor should still be running
		assertEquals(monitor.isMonitoring, true);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - ignores non-modify events", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let changeCount = 0;

	const callback = () => {
		changeCount++;
	};

	const monitor = new ConfigMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
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
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - handles complex SLID structures", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let receivedConfig = null;

	const callback = (config) => {
		receivedConfig = config;
	};

	const monitor = new ConfigMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
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
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("ConfigMonitor - detects atomic writes (file replacement)", async () => {
	// Create a temporary directory for testing
	const tempDir = await Deno.makeTempDir();
	const configPath = `${tempDir}/test-config.slid`;
	let changeCount = 0;
	let lastConfig = null;

	const callback = (config) => {
		changeCount++;
		lastConfig = config;
	};

	const monitor = new ConfigMonitor(configPath, callback);
	// Use default debounce delay (500ms) to match production behavior

	try {
		// Write initial config
		await Deno.writeTextFile(configPath, '[(version=1)]');

		await monitor.startMonitoring();

		// Wait for initial setup
		await new Promise(resolve => setTimeout(resolve, 100));

		// Simulate atomic write (like text editors do)
		// 1. Write to temp file
		// 2. Rename temp file to target file
		const tempFile = `${tempDir}/temp-${Date.now()}.slid`;
		await Deno.writeTextFile(tempFile, '[(version=2)]');
		await Deno.rename(tempFile, configPath);

		// Wait for detection and callback (debounce + processing time)
		await new Promise(resolve => setTimeout(resolve, 700));

		// Should have detected the atomic write
		assertEquals(changeCount, 1, `Expected 1 change, got ${changeCount}`);
		assertExists(lastConfig);
		assertEquals(lastConfig.at('version'), 2);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("ConfigMonitor - detects multiple atomic writes", async () => {
	// Create a temporary directory for testing
	const tempDir = await Deno.makeTempDir();
	const configPath = `${tempDir}/test-config.slid`;
	const changes = [];

	const callback = (config) => {
		const version = config.at('version');
		changes.push(version);
		// console.log('Processing version', version);
	};

	const monitor = new ConfigMonitor(configPath, callback);
	// Use default debounce delay (500ms) to match production behavior

	try {
		// Write initial config
		await Deno.writeTextFile(configPath, '[(version=1)]');

		await monitor.startMonitoring();

		// Wait for initial setup
		await new Promise(resolve => setTimeout(resolve, 100));

		// Helper for atomic writes
		const atomicWrite = async (content) => {
			const tempFile = `${tempDir}/temp-${Date.now()}.slid`;
			await Deno.writeTextFile(tempFile, content);
			await Deno.rename(tempFile, configPath);
		};

		// Make first atomic write
		// console.debug('Writing version 2');
		await atomicWrite('[(version=2)]');
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Make second atomic write
		// console.debug('Writing version 3');
		await atomicWrite('[(version=3)]');
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Should have detected both changes
		// console.debug('Changes seen:', changes);
		assertEquals(changes, [2, 3], `Expected versions [2, 3], got [${changes.join(', ')}]`);
		// assertEquals(changes.length, 2, `Expected 2 changes, got ${changes.length}`);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(tempDir, { recursive: true });
	}
});
