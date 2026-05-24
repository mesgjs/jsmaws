/**
 * Test file monitor with atomic writes (like text editors do)
 *
 * Many text editors (vim, emacs, vscode) use atomic writes:
 * 1. Write to a temporary file
 * 2. Rename/move the temp file to the target file
 *
 * This can cause Deno.watchFs to stop watching the original file.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { FileMonitor } from "../src/file-monitor.esm.js";

Deno.test("FileMonitor - detects changes with atomic writes", async () => {
	// Create a temporary config file
	const tempDir = await Deno.makeTempDir();
	const filePath = `${tempDir}/test-config.slid`;

	// Write initial content
	await Deno.writeTextFile(filePath, "[(version=1)]");

	// Track file change notifications
	const changes = [];
	let changeCount = 0;

	const onChange = async (fp) => {
		changeCount++;
		// Read the file to verify the content changed (the monitor only provides the path)
		const text = await Deno.readTextFile(fp);
		changes.push(text);
		console.log(`[TEST] File change ${changeCount}: ${fp}`);
	};

	// Create and start monitor
	const monitor = new FileMonitor(filePath, onChange);
	await monitor.startMonitoring();

	// Wait for initial setup
	await new Promise((resolve) => setTimeout(resolve, 100));

	try {
		// Simulate atomic write (like text editors do)
		const atomicWrite = async (content) => {
			const tempFile = `${tempDir}/temp-${Date.now()}.slid`;
			await Deno.writeTextFile(tempFile, content);
			await Deno.rename(tempFile, filePath);
		};

		// Make first change with atomic write
		console.log('[TEST] Making first atomic write...');
		await atomicWrite("[(version=2)]");
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Make second change with atomic write
		console.log('[TEST] Making second atomic write...');
		await atomicWrite("[(version=3)]");
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Make third change with atomic write
		console.log('[TEST] Making third atomic write...');
		await atomicWrite("[(version=4)]");
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Verify all changes were detected
		console.log(`[TEST] Total changes detected: ${changeCount}`);

		assertEquals(changeCount, 3, `Expected 3 changes, got ${changeCount}`);

	} finally {
		// Cleanup
		monitor.stopMonitoring();
		await Deno.remove(tempDir, { recursive: true });
	}
});
