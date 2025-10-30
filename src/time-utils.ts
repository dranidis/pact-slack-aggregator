/**
 * Time utility functions that can be mocked in tests
 */

// Default implementation uses Date.now()
let getCurrentTime = (): number => Date.now();
resetTime();

/**
 * Get the current timestamp
 */
export function now(): number {
	return getCurrentTime();
}

/**
 * Mock the current time (for testing)
 */
export function mockTime(mockFn: () => number): void {
	getCurrentTime = mockFn;
}

/**
 * Reset time to use Date.now() (for testing cleanup)
 */
export function resetTime(): void {
	getCurrentTime = () => Date.now();
}

/**
 * Get the minute bucket for a given timestamp
 */
export function getMinuteBucket(timestamp: number, bucketDuration: number): string {
	return Math.floor(timestamp / bucketDuration).toString();
}

