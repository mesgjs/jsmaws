/**
 * Tests for operator privilege validation
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Configuration } from '../src/configuration.esm.js';
import { OperatorProcess, ServerConfig } from '../src/operator.esm.js';

// Mock Deno.uid for testing
const originalUid = Deno.uid;

function mockUid(uid) {
	Deno.uid = () => uid;
}

function restoreUid() {
	Deno.uid = originalUid;
}

Deno.test('validatePrivilegeConfiguration - running as root with uid/gid configured', () => {
	mockUid(0); // Mock running as root

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({ uid: 1000, gid: 1000 });
		operator.initializeLogger();

		// Should not throw
		operator.validatePrivilegeConfiguration();
	} finally {
		restoreUid();
	}
});

Deno.test('validatePrivilegeConfiguration - running as root without uid/gid throws error', () => {
	mockUid(0); // Mock running as root

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({});
		operator.initializeLogger();

		// Should throw
		assertThrows(
			() => operator.validatePrivilegeConfiguration(),
			Error,
			"uid and gid must be configured when running as root"
		);
	} finally {
		restoreUid();
	}
});

Deno.test('validatePrivilegeConfiguration - running as root with only uid throws error', () => {
	mockUid(0); // Mock running as root

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({ uid: 1000 });
		operator.initializeLogger();

		// Should throw
		assertThrows(
			() => operator.validatePrivilegeConfiguration(),
			Error,
			"uid and gid must be configured when running as root"
		);
	} finally {
		restoreUid();
	}
});

Deno.test('validatePrivilegeConfiguration - running as root with only gid throws error', () => {
	mockUid(0); // Mock running as root

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({ gid: 1000 });
		operator.initializeLogger();

		// Should throw
		assertThrows(
			() => operator.validatePrivilegeConfiguration(),
			Error,
			"uid and gid must be configured when running as root"
		);
	} finally {
		restoreUid();
	}
});

Deno.test('validatePrivilegeConfiguration - not running as root with uid/gid configured logs warning', () => {
	mockUid(1000); // Mock running as non-root user

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({ uid: 1000, gid: 1000 });
		operator.initializeLogger();

		// Capture logger warnings
		const warnings = [];
		const originalWarn = operator.logger.warn;
		operator.logger.warn = (msg) => warnings.push(msg);

		// Should not throw, but should log warning
		operator.validatePrivilegeConfiguration();

		assertEquals(warnings.length, 1);
		assertEquals(warnings[0].includes('not running as root'), true);

		// Restore logger
		operator.logger.warn = originalWarn;
	} finally {
		restoreUid();
	}
});

Deno.test('validatePrivilegeConfiguration - not running as root without uid/gid is fine', () => {
	mockUid(1000); // Mock running as non-root user

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({});
		operator.initializeLogger();

		// Should not throw or warn
		operator.validatePrivilegeConfiguration();
	} finally {
		restoreUid();
	}
});

Deno.test('validatePrivilegeConfiguration - not running as root with only uid logs warning', () => {
	mockUid(1000); // Mock running as non-root user

	try {
		const serverConfig = new ServerConfig({ noSSL: true });
		const operator = new OperatorProcess(serverConfig);
		operator.configuration = new Configuration({ uid: 1000 });
		operator.initializeLogger();

		// Capture logger warnings
		const warnings = [];
		const originalWarn = operator.logger.warn;
		operator.logger.warn = (msg) => warnings.push(msg);

		// Should not throw, but should log warning
		operator.validatePrivilegeConfiguration();

		assertEquals(warnings.length, 1);
		assertEquals(warnings[0].includes('not running as root'), true);

		// Restore logger
		operator.logger.warn = originalWarn;
	} finally {
		restoreUid();
	}
});
