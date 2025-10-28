import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';
import { createWebhookPayload, expectTimestampToBeRecent } from './test-utilities';
import { DebugInfo } from '../src/types';

describe('Pact Slack Aggregator Worker', () => {
	beforeEach(async () => {
		vi.clearAllMocks();

		// Mock fetch for Slack API calls
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ ok: true, ts: '1234567890.123' }),
			ok: true
		}));
	});

	describe('Webhook endpoint', () => {
		it('should handle pact webhook correctly (integration style)', async () => {
			const response = await SELF.fetch('https://example.com', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(createWebhookPayload())
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

			const debugData = await response.json() as DebugInfo;
			expect(debugData).toHaveProperty('lastEventTime');
			expect(debugData).toHaveProperty('eventBuckets');
			expect(debugData).toHaveProperty('totalEvents');
			expect(debugData).toHaveProperty('lastProcessTime');
			expect(debugData).toHaveProperty('totalProcessedEvents');
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
						consumerVersionNumber: '5d54920bee2bea8501d604185212aa7808195083',
						providerVersionNumber: '5d54920bee2bea8501d604185212aafds8081950'
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
						consumerVersionNumber: 'e2bea8501d604185212aa78081950835d54920be',
						providerVersionNumber: '50bee2bea8501d604185212aa7808195080d5492'
					},
					{
						eventType: 'contract_content_changed',
						providerName: 'NotificationService',
						consumerName: 'AdminPanel',
						pactUrl: 'https://pact.example.com/pacts/adminpanel-notificationservice',
						consumerVersionBranch: 'feature/new-notifications',
						consumerVersionNumber: '5d549e2bea185212aa78081950838501d60420be'
					}
				];

				// Add all events at 10:00:00 except last one at 10:01:00
				for (const event of events) {
					const response = await SELF.fetch('https://example.com', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(event)
					});
					expect(response.status).toBe(200);
				}

				// 2. Move time forward to 10:01:00 (exactly on the minute bucket)
				currentMockTime = baseTime + (60 * 1000); // 60 seconds later
				mockTime(() => currentMockTime);
				const expectedLastEventTime = currentMockTime;

				const extraEvent = {
					eventType: 'provider_verification_published',
					providerName: 'PaymentService2',
					consumerName: 'MobileApp2',
					verificationResultUrl: 'https://pact.example.com/results/failure',
					pactUrl: 'https://pact.example.com/pacts/mobileapp2-paymentservice2',
					githubVerificationStatus: 'failure',
					consumerVersionBranch: 'feature/payment-update2',
					providerVersionBranch: 'main',
					consumerVersionNumber: '4185212aa78081950835d54920bee2bea8501d60',
					providerVersionNumber: '50bee2bea8501d60808195080d54924185212aa7'
				}

				const extraResponse = await SELF.fetch('https://example.com', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(extraEvent)
				});
				expect(extraResponse.status).toBe(200);

				// 3. Move time forward to 10:01:30 (past the minute bucket)
				currentMockTime = baseTime + (90 * 1000); // 90 seconds later
				const expectedLastProcessTime = currentMockTime;

				// 4. Trigger batch processing
				const triggerResponse = await SELF.fetch(`https://example.com/trigger?key=${env.DEBUG_KEY}`);
				expect(triggerResponse.status).toBe(200);

				// 5. Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// 6. Verify all Slack summary and thread messages were sent
				expect(slackCalls.length).toBe(2 * events.length);

				// Check that we have messages for different pacticipants
				const messages = slackCalls.map(call => call.text || call.blocks?.[0]?.text?.text || '');
				const allMessagesText = messages.join(' ');

				// Verify messages contain our test data
				const userServiceSummary =
					`*UserService* <${env.GITHUB_BASE_URL}/user-service/tree/main|main> <${env.GITHUB_BASE_URL}/user-service/commit/5d54920bee2bea8501d604185212aafds8081950|5d54920>
Pact verifications: ✅1`;
				const userServiceThread =
					`✅ <https://pact.example.com/results/success|Details> *WebApp* <${env.GITHUB_BASE_URL}/web-app/tree/main|main> <${env.GITHUB_BASE_URL}/web-app/commit/5d54920bee2bea8501d604185212aa7808195083|5d54920>`;
				const paymentServiceSummary =
					`*PaymentService* <${env.GITHUB_BASE_URL}/payment-service/tree/main|main> <${env.GITHUB_BASE_URL}/payment-service/commit/50bee2bea8501d604185212aa7808195080d5492|50bee2b>
Pact verifications: 💥1`;
				const paymentServiceThread =
					`💥 <https://pact.example.com/results/failure|Details> *MobileApp* <${env.GITHUB_BASE_URL}/mobile-app/tree/feature/payment-update|feature/payment-update> <${env.GITHUB_BASE_URL}/mobile-app/commit/e2bea8501d604185212aa78081950835d54920be|e2bea85>`;
				const adminPanelSummary =
					`*AdminPanel* <${env.GITHUB_BASE_URL}/admin-panel/tree/feature/new-notifications|feature/new-notifications> <${env.GITHUB_BASE_URL}/admin-panel/commit/5d549e2bea185212aa78081950838501d60420be|5d549e2>
Pact publications: 1`;
				const adminPanelThread =
					`Published <https://pact.example.com/pacts/adminpanel-notificationservice|contract> to be verified from provider *NotificationService*`;

				expect(allMessagesText).toContain(userServiceSummary);
				expect(allMessagesText).toContain(userServiceThread);
				expect(allMessagesText).toContain(paymentServiceSummary);
				expect(allMessagesText).toContain(paymentServiceThread);
				expect(allMessagesText).toContain(adminPanelSummary);
				expect(allMessagesText).toContain(adminPanelThread);

				// assert that the extra event is also present with debug info
				const debugResponse = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
				expect(debugResponse.status).toBe(200);
				const debugData = await debugResponse.json() as DebugInfo;
				expect(debugData.totalEvents).toBe(1);
				// expect(debugData.eventBuckets['events:1001'][0]).toMatchObject(extraEvent);
				// expect(debugData.lastEventTime).toBe(currentMockTime);
				// expect(debugData.lastProcessTime).toBeGreaterThanOrEqual(currentMockTime);
				expectTimestampToBeRecent(debugData.lastEventTime, expectedLastEventTime);
				expectTimestampToBeRecent(debugData.lastProcessTime, expectedLastProcessTime);
				expect(debugData.totalProcessedEvents).toBe(events.length);

				// move time forward, trigger and verify last event is also sent
				currentMockTime = baseTime + (150 * 1000); // 150 seconds later

				// Trigger batch processing again
				const triggerResponse2 = await SELF.fetch(`https://example.com/trigger?key=${env.DEBUG_KEY}`);
				expect(triggerResponse2.status).toBe(200);

				// Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// Verify Slack message was sent for the last event
				expect(slackCalls.length).toBe(2 * events.length + 2); // +2 for summary and thread
			} finally {
				// Always reset time after test
				resetTime();
			}
		});
	});
});
