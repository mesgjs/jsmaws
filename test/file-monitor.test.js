/**
 * Tests for JSMAWS File Monitor
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { FileMonitor } from "../src/file-monitor.esm.js";

Deno.test("FileMonitor - creates instance", () => {
	const monitor = new FileMonitor('test.slid', null);

	try {
		assertExists(monitor);
		assertEquals(monitor.filePath, 'test.slid');
		assertEquals(monitor.isMonitoring, false);
		assertEquals(monitor.debounceDelay, 500);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("FileMonitor - sets callback", () => {
	const callback = () => {};
	const monitor = new FileMonitor('test.slid', callback);

	try {
		assertEquals(monitor.onChange, callback);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("FileMonitor - prevents duplicate monitoring", async () => {
	// Create a temporary test file
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new FileMonitor(testFile, null);

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

Deno.test("FileMonitor - stops monitoring", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new FileMonitor(testFile, null);

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

Deno.test("FileMonitor - handles file modification", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let changeCount = 0;
	let lastPath = null;

	const callback = (filePath) => {
		changeCount++;
		lastPath = filePath;
	};

	const monitor = new FileMonitor(testFile, callback);
	monitor.debounceDelay = 100; // Faster for testing

	try {
		// Write initial content
		await Deno.writeTextFile(testFile, '[(test=1)]');

		await monitor.startMonitoring();

		// Wait a bit for initial state
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Modify the file
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Wait for debounce and callback
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Should have detected the change
		assertEquals(changeCount > 0, true);
		assertEquals(lastPath, testFile);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("FileMonitor - debounces rapid changes", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let changeCount = 0;

	const callback = () => {
		changeCount++;
	};

	const monitor = new FileMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Make rapid changes
		await Deno.writeTextFile(testFile, '[(test=2)]');
		await new Promise((resolve) => setTimeout(resolve, 50));
		await Deno.writeTextFile(testFile, '[(test=3)]');
		await new Promise((resolve) => setTimeout(resolve, 50));
		await Deno.writeTextFile(testFile, '[(test=4)]');

		// Wait for debounce
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Should have fewer callbacks than changes due to debouncing
		assertEquals(changeCount <= 2, true);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("FileMonitor - gets file modification time", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new FileMonitor(testFile, null);

	try {
		const mtime = await monitor.getFileModificationTime();

		assertExists(mtime);
		assertEquals(typeof mtime, 'number');
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("FileMonitor - handles missing file gracefully", async () => {
	const monitor = new FileMonitor('/nonexistent/path/config.slid', null);

	try {
		const mtime = await monitor.getFileModificationTime();

		assertEquals(mtime, null);
	} finally {
		monitor.stopMonitoring();
	}
});

Deno.test("FileMonitor - clears debounce timer on stop", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const monitor = new FileMonitor(testFile, null);
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

Deno.test("FileMonitor - callback receives file path on change", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let receivedPath = null;

	const callback = (filePath) => {
		receivedPath = filePath;
	};

	const monitor = new FileMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
		// Write initial content
		await Deno.writeTextFile(testFile, '[(httpPort=8080 httpsPort=8443)]');

		await monitor.startMonitoring();

		// Wait for initial state
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Modify the file to trigger callback
		await Deno.writeTextFile(testFile, '[(httpPort=8080 httpsPort=8443 hostname="test")]');

		// Wait for detection and callback
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Callback should have received the file path (not a parsed config object)
		assertEquals(receivedPath, testFile);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("FileMonitor - handles callback errors gracefully", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	const callback = () => {
		throw new Error('Callback error');
	};

	const monitor = new FileMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Trigger a change - should not crash
		await Deno.writeTextFile(testFile, '[(test=2)]');

		// Wait for error handling
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Monitor should still be running
		assertEquals(monitor.isMonitoring, true);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("FileMonitor - ignores non-modify events", async () => {
	const testFile = await Deno.makeTempFile({ suffix: '.slid' });
	let changeCount = 0;

	const callback = () => {
		changeCount++;
	};

	const monitor = new FileMonitor(testFile, callback);
	monitor.debounceDelay = 100;

	try {
		await Deno.writeTextFile(testFile, '[(test=1)]');
		await monitor.startMonitoring();

		// Wait for initial state
		await new Promise((resolve) => setTimeout(resolve, 200));

		const initialCount = changeCount;

		// Access the file (may trigger events but not modify)
		await Deno.stat(testFile);

		// Wait to see if any changes are detected
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Should not have increased significantly
		assertEquals(changeCount <= initialCount + 1, true);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(testFile);
	}
});

Deno.test("FileMonitor - detects atomic writes (file replacement)", async () => {
	// Create a temporary directory for testing
	const tempDir = await Deno.makeTempDir();
	const filePath = `${tempDir}/test-config.slid`;
	let changeCount = 0;
	let lastPath = null;

	const callback = (fp) => {
		changeCount++;
		lastPath = fp;
	};

	const monitor = new FileMonitor(filePath, callback);
	// Use default debounce delay (500ms) to match production behavior

	try {
		// Write initial content
		await Deno.writeTextFile(filePath, '[(version=1)]');

		await monitor.startMonitoring();

		// Wait for initial setup
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Simulate atomic write (like text editors do)
		// 1. Write to temp file
		// 2. Rename temp file to target file
		const tempFile = `${tempDir}/temp-${Date.now()}.slid`;
		await Deno.writeTextFile(tempFile, '[(version=2)]');
		await Deno.rename(tempFile, filePath);

		// Wait for detection and callback (debounce + processing time)
		await new Promise((resolve) => setTimeout(resolve, 700));

		// Should have detected the atomic write
		assertEquals(changeCount, 1, `Expected 1 change, got ${changeCount}`);
		assertEquals(lastPath, filePath);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(tempDir, { recursive: true });
	}
});

Deno.test("FileMonitor - detects multiple atomic writes", async () => {
	// Create a temporary directory for testing
	const tempDir = await Deno.makeTempDir();
	const filePath = `${tempDir}/test-config.slid`;
	const changes = [];

	const callback = (fp) => {
		changes.push(fp);
	};

	const monitor = new FileMonitor(filePath, callback);
	// Use default debounce delay (500ms) to match production behavior

	try {
		// Write initial content
		await Deno.writeTextFile(filePath, '[(version=1)]');

		await monitor.startMonitoring();

		// Wait for initial setup
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Helper for atomic writes
		const atomicWrite = async (content) => {
			const tempFile = `${tempDir}/temp-${Date.now()}.slid`;
			await Deno.writeTextFile(tempFile, content);
			await Deno.rename(tempFile, filePath);
		};

		// Make first atomic write
		await atomicWrite('[(version=2)]');
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Make second atomic write
		await atomicWrite('[(version=3)]');
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Should have detected both changes (each callback receives the file path)
		assertEquals(changes.length, 2, `Expected 2 changes, got ${changes.length}`);
		assertEquals(changes[0], filePath);
		assertEquals(changes[1], filePath);
	} finally {
		monitor.stopMonitoring();
		await Deno.remove(tempDir, { recursive: true });
	}
});
