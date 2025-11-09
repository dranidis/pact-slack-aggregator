import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		globals: true,
		setupFiles: ['./test/setup.ts'],
		include: ['test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
		exclude: ['node_modules/**', 'dist/**', '.wrangler/**'],
		// Ensure test isolation
		isolate: true,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.dev.jsonc' },
				// Force isolated storage for each test
				isolatedStorage: true,
			},
		},
		// Add timeout for VS Code compatibility
		testTimeout: 10000,
		hookTimeout: 10000,
		// Force tests to run in sequence to prevent state conflicts
		sequence: {
			concurrent: false,
		},
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'html', 'lcov'],
			reportsDirectory: './coverage',
			exclude: ['dist', 'tests', 'node_modules', '.wrangler/**'],
		},
	},
});
