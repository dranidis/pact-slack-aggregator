import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Pact Slack Aggregator Worker', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Mock fetch for Slack API calls
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ ok: true, ts: '1234567890.123' }),
			ok: true
		}));
	});

	describe('Webhook endpoint', () => {
		it('should handle pact webhook correctly (unit style)', async () => {
			const webhookPayload = {
				eventType: 'provider_verification_published',
				providerName: 'TestProvider',
				consumerName: 'TestConsumer',
				verificationResultUrl: 'https://example.com/results',
				pactUrl: 'https://example.com/pact',
				githubVerificationStatus: 'success',
				consumerVersionBranch: 'main',
				providerVersionBranch: 'main',
				consumerVersionNumber: 'abc123',
				providerVersionNumber: 'def456'
			};

			const request = new IncomingRequest('http://example.com', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(webhookPayload)
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe('OK');
		});

		it('should handle pact webhook correctly (integration style)', async () => {
			const webhookPayload = {
				eventType: 'contract_content_changed',
				providerName: 'TestProvider',
				consumerName: 'TestConsumer',
				pactUrl: 'https://example.com/pact',
				consumerVersionBranch: 'feature/new-api',
				consumerVersionNumber: 'ghi345678'
			};

			const response = await SELF.fetch('https://example.com', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(webhookPayload)
			});

			expect(response.status).toBe(200);
			expect(await response.text()).toBe('OK');
		});

		it('should reject non-POST requests', async () => {
			const response = await SELF.fetch('https://example.com', {
				method: 'GET'
			});

			expect(response.status).toBe(405);
			expect(await response.text()).toBe('Method Not Allowed');
		});

		it('should handle malformed JSON', async () => {
			const response = await SELF.fetch('https://example.com', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'invalid json'
			});

			expect(response.status).toBe(500);
		});
	});

	describe('Debug endpoint', () => {
		it('should return debug info with correct key', async () => {
			const response = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
			expect(response.status).toBe(200);

			const debugData = await response.json();
			expect(debugData).toHaveProperty('lastEventTime');
			expect(debugData).toHaveProperty('eventBuckets');
			expect(debugData).toHaveProperty('totalEvents');
		});

		it('should reject debug request with wrong key', async () => {
			const response = await SELF.fetch('https://example.com/debug?key=wrong');
			expect(response.status).toBe(405);
		});
	});

	describe('Manual trigger endpoint', () => {
		it('should process batches when triggered', async () => {
			const response = await SELF.fetch(`https://example.com/trigger?key=${env.DEBUG_KEY}`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('Processing completed');
		});

		it('should reject trigger request with wrong key', async () => {
			const response = await SELF.fetch('https://example.com/trigger?key=wrong');
			expect(response.status).toBe(405);
		});
	});

	describe('Scheduled event', () => {
		it('should handle scheduled events correctly', async () => {
			const ctx = createExecutionContext();
			const scheduledEvent = {
				type: 'scheduled',
				scheduledTime: Date.now(),
				cron: '*/5 * * * *'
			} as ScheduledEvent;

			// This should not throw
			await expect(worker.scheduled(scheduledEvent, env, ctx)).resolves.not.toThrow();
			await waitOnExecutionContext(ctx);
		});
	});
});
