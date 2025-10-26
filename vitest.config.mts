import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		globals: true,
		include: ['test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
		exclude: ['node_modules/**', 'dist/**', '.wrangler/**'],
		// Ensure test isolation
		isolate: true,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				// Force isolated storage for each test
				isolatedStorage: true,
			},
		},
		// Add timeout for VS Code compatibility
		testTimeout: 10000,
		hookTimeout: 10000,
	},
});
