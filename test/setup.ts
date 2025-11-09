import { vi, beforeEach, afterEach } from 'vitest';

// Global setup to suppress console output during tests
beforeEach(() => {
	// Suppress console.log and console.error during tests
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	// Restore all mocks after each test
	vi.restoreAllMocks();
});
