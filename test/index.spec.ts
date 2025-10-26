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

	describe('Full workflow with time mocking', () => {
		it('should process events and send Slack messages with time control', async () => {
			// Import our time utilities for mocking
			const { mockTime, resetTime } = await import('../src/time-utils');

			// Mock fetch to capture Slack API calls
			const slackCalls: any[] = [];
			vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: any) => {
				if (url.includes('slack.com/api/chat.postMessage')) {
					const body = JSON.parse(options.body);
					slackCalls.push(body);
					return Promise.resolve({
						json: () => Promise.resolve({ ok: true, ts: '1234567890.123' }),
						ok: true
					});
				}
				return Promise.resolve({ ok: true });
			}));

			try {
				// Start at a specific time (e.g., 10:00:00)
				const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
				let currentMockTime = baseTime;

				mockTime(() => currentMockTime);

				// 1. Add events at time 10:00:00
				const events = [
					{
						eventType: 'provider_verification_published',
						providerName: 'UserService',
						consumerName: 'WebApp',
						verificationResultUrl: 'https://pact.example.com/results/success',
						pactUrl: 'https://pact.example.com/pacts/webapp-userservice',
						githubVerificationStatus: 'success',
						consumerVersionBranch: 'main',
						providerVersionBranch: 'main',
						consumerVersionNumber: 'v1.2.0',
						providerVersionNumber: 'v2.1.0'
					},
					{
						eventType: 'provider_verification_published',
						providerName: 'PaymentService',
						consumerName: 'MobileApp',
						verificationResultUrl: 'https://pact.example.com/results/failure',
						pactUrl: 'https://pact.example.com/pacts/mobileapp-paymentservice',
						githubVerificationStatus: 'failure',
						consumerVersionBranch: 'feature/payment-update',
						providerVersionBranch: 'main',
						consumerVersionNumber: 'v2.0.0-beta',
						providerVersionNumber: 'v1.5.0'
					},
					{
						eventType: 'contract_content_changed',
						providerName: 'NotificationService',
						consumerName: 'AdminPanel',
						pactUrl: 'https://pact.example.com/pacts/adminpanel-notificationservice',
						consumerVersionBranch: 'feature/new-notifications',
						consumerVersionNumber: 'v3.1.0-alpha'
					}
				];

				// Add all events at 10:00:00
				for (const event of events) {
					const response = await SELF.fetch('https://example.com', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(event)
					});
					expect(response.status).toBe(200);
				}

				// 2. Move time forward to 10:01:30 (past the minute bucket)
				currentMockTime = baseTime + (90 * 1000); // 90 seconds later

				// 3. Trigger batch processing
				const triggerResponse = await SELF.fetch(`https://example.com/trigger?key=${env.DEBUG_KEY}`);
				expect(triggerResponse.status).toBe(200);

				// 4. Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// 5. Verify Slack messages were sent
				expect(slackCalls.length).toBeGreaterThan(0);

				// Check that we have messages for different pacticipants
				const messages = slackCalls.map(call => call.text || call.blocks?.[0]?.text?.text || '');
				const allMessagesText = messages.join(' ');

				// Verify messages contain our test data
				const userServiceSummary =
					`*UserService* <${env.GITHUB_BASE_URL}/userservice/tree/main|main> ${env.GITHUB_BASE_URL}/userservice/commit/v2.1.0|v2.1.0>
Pact verifications: ✅1`;
				const userServiceThread =
					`Verified consumer *WebApp* <${env.GITHUB_BASE_URL}/webapp/tree/main|main> ${env.GITHUB_BASE_URL}/webapp/commit/v1.2.0|v1.2.0>: ✅ <https://pact.example.com/results/success|Details>`;
				const paymentServiceSummary =
					`*PaymentService* <${env.GITHUB_BASE_URL}/paymentservice/tree/main|main> ${env.GITHUB_BASE_URL}/paymentservice/commit/v1.5.0|v1.5.0>
Pact verifications: 💥1`;
				const paymentServiceThread =
					`Verified consumer *MobileApp* <${env.GITHUB_BASE_URL}/mobileapp/tree/feature/payment-update|feature/payment-update> ${env.GITHUB_BASE_URL}/mobileapp/commit/v2.0.0-beta|v2.0.0->: 💥 <https://pact.example.com/results/failure|Details>`;
				const adminPanelSummary =
					`*AdminPanel* <${env.GITHUB_BASE_URL}/adminpanel/tree/feature/new-notifications|feature/new-notifications> ${env.GITHUB_BASE_URL}/adminpanel/commit/v3.1.0-alpha|v3.1.0->
Pact publications: 1`;
				const adminPanelThread =
					`Published <https://pact.example.com/pacts/adminpanel-notificationservice|contract> to be verified from provider *NotificationService*`;

				expect(allMessagesText).toContain(userServiceSummary);
				expect(allMessagesText).toContain(userServiceThread);
				expect(allMessagesText).toContain(paymentServiceSummary);
				expect(allMessagesText).toContain(paymentServiceThread);
				expect(allMessagesText).toContain(adminPanelSummary);
				expect(allMessagesText).toContain(adminPanelThread);
			} finally {
				// Always reset time after test
				resetTime();
			}
		});
	});
});
