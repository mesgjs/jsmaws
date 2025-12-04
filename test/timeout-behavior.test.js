/**
 * Timeout Behavior Tests
 * Tests for request, idle, and connection timeout behavior
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';

/**
 * Mock timer utilities for testing timeout behavior
 */
class MockTimer {
	constructor() {
		this.timers = new Map();
		this.nextId = 1;
		this.currentTime = 0;
	}

	setTimeout(callback, delay) {
		const id = this.nextId++;
		this.timers.set(id, {
			callback,
			triggerTime: this.currentTime + delay,
			type: 'timeout'
		});
		return id;
	}

	clearTimeout(id) {
		this.timers.delete(id);
	}

	advance(ms) {
		this.currentTime += ms;
		const triggered = [];

		for (const [id, timer] of this.timers.entries()) {
			if (timer.triggerTime <= this.currentTime) {
				triggered.push({ id, timer });
			}
		}

		// Execute triggered timers
		for (const { id, timer } of triggered) {
			this.timers.delete(id);
			timer.callback();
		}

		return triggered.length;
	}

	hasTimer(id) {
		return this.timers.has(id);
	}

	getTimerCount() {
		return this.timers.size;
	}

	reset() {
		this.timers.clear();
		this.currentTime = 0;
		this.nextId = 1;
	}
}

/**
 * Mock request info for testing
 */
function createMockRequestInfo(timeouts) {
	return {
		worker: { terminate: () => {} },
		timeout: null,
		idleTimeout: null,
		connectionTimeout: null,
		isStreaming: false,
		keepAlive: false,
		timeouts,
		frameBuffer: [],
		totalBuffered: 0
	};
}

Deno.test('Request timeout - fires after configured duration', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 0, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	let timeoutFired = false;
	requestInfo.timeout = timer.setTimeout(() => {
		timeoutFired = true;
	}, timeouts.reqTimeout * 1000);

	// Advance time but not enough to trigger
	timer.advance(29000);
	assertEquals(timeoutFired, false);

	// Advance past timeout
	timer.advance(1000);
	assertEquals(timeoutFired, true);
});

Deno.test('Request timeout - can be disabled with 0', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 0, idleTimeout: 0, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// With reqTimeout=0, no timer should be created
	requestInfo.timeout = timeouts.reqTimeout ? timer.setTimeout(() => {}, timeouts.reqTimeout * 1000) : null;

	assertEquals(requestInfo.timeout, null);
	assertEquals(timer.getTimerCount(), 0);
});

Deno.test('Request timeout - cleared when request completes', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 0, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	let timeoutFired = false;
	requestInfo.timeout = timer.setTimeout(() => {
		timeoutFired = true;
	}, timeouts.reqTimeout * 1000);

	// Clear timeout before it fires
	timer.clearTimeout(requestInfo.timeout);
	requestInfo.timeout = null;

	// Advance past original timeout
	timer.advance(31000);
	assertEquals(timeoutFired, false);
	assertEquals(timer.getTimerCount(), 0);
});

Deno.test('Idle timeout - only active between frames', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 60, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// Request timeout active during processing
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	assertEquals(timer.getTimerCount(), 1);

	// No idle timeout during processing
	assertEquals(requestInfo.idleTimeout, null);

	// After final frame sent, clear request timeout and start idle timeout
	timer.clearTimeout(requestInfo.timeout);
	requestInfo.timeout = null;

	let idleTimeoutFired = false;
	requestInfo.idleTimeout = timer.setTimeout(() => {
		idleTimeoutFired = true;
	}, timeouts.idleTimeout * 1000);

	assertEquals(timer.getTimerCount(), 1);

	// Advance to trigger idle timeout
	timer.advance(60000);
	assertEquals(idleTimeoutFired, true);
});

Deno.test('Idle timeout - cleared when new frame arrives', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 60, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// Start idle timeout (between frames)
	let idleTimeoutFired = false;
	requestInfo.idleTimeout = timer.setTimeout(() => {
		idleTimeoutFired = true;
	}, timeouts.idleTimeout * 1000);

	// New frame arrives - clear idle timeout
	timer.clearTimeout(requestInfo.idleTimeout);
	requestInfo.idleTimeout = null;

	// Start request timeout for new frame
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);

	// Advance past original idle timeout
	timer.advance(61000);
	assertEquals(idleTimeoutFired, false);
});

Deno.test('Idle timeout - gets full duration each cycle', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 5, idleTimeout: 60, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// First frame processing (5 seconds)
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	timer.advance(5000);
	timer.clearTimeout(requestInfo.timeout);

	// Idle period starts (should get full 60 seconds)
	const idleStart = timer.currentTime;
	requestInfo.idleTimeout = timer.setTimeout(() => {}, timeouts.idleTimeout * 1000);

	// Advance 59 seconds - should not fire
	timer.advance(59000);
	assertEquals(timer.hasTimer(requestInfo.idleTimeout), true);

	// Advance 1 more second - should fire
	timer.advance(1000);
	assertEquals(timer.currentTime - idleStart, 60000);
});

Deno.test('Idle timeout - can be disabled with 0', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 0, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// With idleTimeout=0, no timer should be created
	requestInfo.idleTimeout = timeouts.idleTimeout > 0 
		? timer.setTimeout(() => {}, timeouts.idleTimeout * 1000) 
		: null;

	assertEquals(requestInfo.idleTimeout, null);
});

Deno.test('Connection timeout - runs for entire connection lifetime', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 5, idleTimeout: 60, conTimeout: 300 };
	const requestInfo = createMockRequestInfo(timeouts);
	requestInfo.keepAlive = true;

	// Connection timeout starts with first keepAlive frame
	let conTimeoutFired = false;
	requestInfo.connectionTimeout = timer.setTimeout(() => {
		conTimeoutFired = true;
	}, timeouts.conTimeout * 1000);

	// Simulate multiple request/idle cycles
	// First request (5s)
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	timer.advance(5000);
	timer.clearTimeout(requestInfo.timeout);

	// First idle (60s)
	requestInfo.idleTimeout = timer.setTimeout(() => {}, timeouts.idleTimeout * 1000);
	timer.advance(60000);
	timer.clearTimeout(requestInfo.idleTimeout);

	// Second request (5s)
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	timer.advance(5000);
	timer.clearTimeout(requestInfo.timeout);

	// Second idle (60s)
	requestInfo.idleTimeout = timer.setTimeout(() => {}, timeouts.idleTimeout * 1000);
	timer.advance(60000);
	timer.clearTimeout(requestInfo.idleTimeout);

	// Total elapsed: 130s, connection timeout should not have fired yet
	assertEquals(conTimeoutFired, false);
	assertEquals(timer.currentTime, 130000);

	// Advance to connection timeout
	timer.advance(170000);
	assertEquals(conTimeoutFired, true);
	assertEquals(timer.currentTime, 300000);
});

Deno.test('Connection timeout - can be disabled with 0', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 60, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);
	requestInfo.keepAlive = true;

	// With conTimeout=0, no timer should be created
	requestInfo.connectionTimeout = timeouts.conTimeout > 0
		? timer.setTimeout(() => {}, timeouts.conTimeout * 1000)
		: null;

	assertEquals(requestInfo.connectionTimeout, null);
});

Deno.test('All three timeouts - cleanup clears all', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 60, conTimeout: 300 };
	const requestInfo = createMockRequestInfo(timeouts);
	requestInfo.keepAlive = true;

	// Set all three timeouts
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	requestInfo.idleTimeout = timer.setTimeout(() => {}, timeouts.idleTimeout * 1000);
	requestInfo.connectionTimeout = timer.setTimeout(() => {}, timeouts.conTimeout * 1000);

	assertEquals(timer.getTimerCount(), 3);

	// Cleanup should clear all
	timer.clearTimeout(requestInfo.timeout);
	timer.clearTimeout(requestInfo.idleTimeout);
	timer.clearTimeout(requestInfo.connectionTimeout);

	assertEquals(timer.getTimerCount(), 0);
});

Deno.test('Timeout hierarchy - route overrides pool overrides global', () => {
	// This is a conceptual test showing the hierarchy
	const global = { reqTimeout: 30, idleTimeout: 60, conTimeout: 300 };
	const pool = { reqTimeout: 10, idleTimeout: 20, conTimeout: 200 };
	const route = { reqTimeout: 120, idleTimeout: 90, conTimeout: 600 };

	// Simulate hierarchy resolution (route > pool > global)
	const resolved = {
		reqTimeout: route.reqTimeout ?? pool.reqTimeout ?? global.reqTimeout,
		idleTimeout: route.idleTimeout ?? pool.idleTimeout ?? global.idleTimeout,
		conTimeout: route.conTimeout ?? pool.conTimeout ?? global.conTimeout,
	};

	assertEquals(resolved.reqTimeout, 120);  // Route wins
	assertEquals(resolved.idleTimeout, 90);  // Route wins
	assertEquals(resolved.conTimeout, 600);  // Route wins
});

Deno.test('Timeout semantics - request vs idle distinction', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 30, idleTimeout: 60, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// Phase 1: Request processing (request timeout active)
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	assertEquals(requestInfo.idleTimeout, null);
	assertEquals(timer.getTimerCount(), 1);

	// Simulate request completion
	timer.clearTimeout(requestInfo.timeout);
	requestInfo.timeout = null;

	// Phase 2: Between frames (idle timeout active)
	requestInfo.idleTimeout = timer.setTimeout(() => {}, timeouts.idleTimeout * 1000);
	assertEquals(requestInfo.timeout, null);
	assertEquals(timer.getTimerCount(), 1);

	// New frame arrives
	timer.clearTimeout(requestInfo.idleTimeout);
	requestInfo.idleTimeout = null;

	// Phase 3: Processing new frame (request timeout active again)
	requestInfo.timeout = timer.setTimeout(() => {}, timeouts.reqTimeout * 1000);
	assertEquals(requestInfo.idleTimeout, null);
	assertEquals(timer.getTimerCount(), 1);
});

Deno.test('Stream pool typical config - request disabled, idle and connection enabled', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 0, idleTimeout: 300, conTimeout: 3600 };
	const requestInfo = createMockRequestInfo(timeouts);
	requestInfo.keepAlive = true;

	// Request timeout disabled
	requestInfo.timeout = timeouts.reqTimeout > 0
		? timer.setTimeout(() => {}, timeouts.reqTimeout * 1000)
		: null;
	assertEquals(requestInfo.timeout, null);

	// Idle timeout enabled (5 minutes between frames)
	requestInfo.idleTimeout = timer.setTimeout(() => {}, timeouts.idleTimeout * 1000);
	assertExists(requestInfo.idleTimeout);

	// Connection timeout enabled (1 hour total)
	requestInfo.connectionTimeout = timer.setTimeout(() => {}, timeouts.conTimeout * 1000);
	assertExists(requestInfo.connectionTimeout);

	assertEquals(timer.getTimerCount(), 2);
});

Deno.test('Fast pool typical config - short timeouts', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 5, idleTimeout: 10, conTimeout: 60 };
	const requestInfo = createMockRequestInfo(timeouts);

	// All timeouts should be short
	assertEquals(timeouts.reqTimeout, 5);
	assertEquals(timeouts.idleTimeout, 10);
	assertEquals(timeouts.conTimeout, 60);

	// Request timeout fires quickly
	let reqTimeoutFired = false;
	requestInfo.timeout = timer.setTimeout(() => {
		reqTimeoutFired = true;
	}, timeouts.reqTimeout * 1000);

	timer.advance(5000);
	assertEquals(reqTimeoutFired, true);
});

Deno.test('Timeout edge case - zero timeout means disabled, not immediate', () => {
	const timer = new MockTimer();
	const timeouts = { reqTimeout: 0, idleTimeout: 0, conTimeout: 0 };
	const requestInfo = createMockRequestInfo(timeouts);

	// Zero means disabled, not "fire immediately"
	requestInfo.timeout = timeouts.reqTimeout > 0
		? timer.setTimeout(() => {}, timeouts.reqTimeout * 1000)
		: null;

	assertEquals(requestInfo.timeout, null);
	assertEquals(timer.getTimerCount(), 0);

	// Advance time - nothing should fire
	timer.advance(1000000);
	assertEquals(timer.getTimerCount(), 0);
});
