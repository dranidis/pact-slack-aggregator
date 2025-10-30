import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { createWebhookPayload, expectTimestampToBeRecent } from './test-utilities';
import { DebugInfo, WebhookPayload } from '../src/types';
import { mockTime, resetTime } from '../src/time-utils';


const SUCCESS_EMOJI = "✅";
const FAILURE_EMOJI = "😢";

interface SlackCallMock {
	text?: string;
	blocks?: {
		text?: {
			text?: string;
		};
	}[];
}

describe('Pact Slack Aggregator Worker', () => {
	const slackCalls: SlackCallMock[] = [];

	beforeEach(() => {
		vi.clearAllMocks();

		// Mock fetch for Slack API calls
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ ok: true, ts: '1234567890.123' }),
			ok: true
		}));

		vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: { body: string }) => {
			if (url.includes('slack.com/api/chat.postMessage')) {
				slackCalls.push(JSON.parse(options.body) as SlackCallMock);
				return Promise.resolve({
					json: () => Promise.resolve({ ok: true, ts: '1234567890.123' }),
					ok: true
				});
			}
			return Promise.resolve({ ok: true });
		}));
	});

	afterEach(() => {
		vi.resetAllMocks();
		slackCalls.length = 0; // Clear captured Slack calls
	});

	describe('Webhook endpoint', () => {
		it('should handle pact webhook correctly (integration style)', async () => {
			const response = await sendEvent();

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
			const response = await trigger();
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
			expect(() => worker.scheduled(scheduledEvent, env, ctx)).not.toThrow();
			await waitOnExecutionContext(ctx);
		});
	});

	describe('Full workflow with time mocking', () => {
		it('should process events and send Slack messages with time control', async () => {
			// Mock fetch to capture Slack API calls

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
						verificationResultUrl: 'https://pact.example.com/results/1',
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
						verificationResultUrl: 'https://pact.example.com/results/2',
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
					const response = await sendEvent(event);
					expect(response.status).toBe(200);
				}

				// 2. Move time forward to 10:01:00 (exactly on the minute bucket)
				currentMockTime = baseTime + (60 * 1000); // 60 seconds later
				mockTime(() => currentMockTime);
				const expectedLastEventTime = currentMockTime;

				const extraEvent = {
					eventType: 'provider_verification_published',
					providerName: 'PaymentService2',
					consumerName: 'FrontEnd',
					verificationResultUrl: 'https://pact.example.com/results/failure',
					pactUrl: 'https://pact.example.com/pacts/mobileapp2-paymentservice2',
					githubVerificationStatus: 'failure',
					consumerVersionBranch: 'feature/payment-update2',
					providerVersionBranch: 'main',
					consumerVersionNumber: '4185212aa78081950835d54920bee2bea8501d60',
					providerVersionNumber: '50bee2bea8501d60808195080d54924185212aa7'
				}

				const extraResponse = await sendEvent(extraEvent);
				expect(extraResponse.status).toBe(200);

				// 3. Move time forward to 10:01:30 (past the minute bucket)
				currentMockTime = baseTime + (90 * 1000); // 90 seconds later
				const expectedLastProcessTime = currentMockTime;

				// 4. Trigger batch processing
				const triggerResponse = await trigger();
				expect(triggerResponse.status).toBe(200);

				// 5. Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// 6. Verify all Slack summary and thread messages were sent
				expect(slackCalls.length).toBe(2 * events.length);

				// Check that we have messages for different pacticipants
				const messages = slackCalls.map(call => (call.text ?? call.blocks?.[0]?.text?.text) ?? '');
				const allMessagesText = messages.join(' ');

				// Verify messages contain our test data
				const userServiceSummary =
					`*UserService* <${env.GITHUB_BASE_URL}/user-service/tree/main|main> <${env.GITHUB_BASE_URL}/user-service/commit/5d54920bee2bea8501d604185212aafds8081950|5d54920>
Pact verifications: ${SUCCESS_EMOJI}1`;
				const userServiceThread =
					`${SUCCESS_EMOJI} <https://pact.example.com/results/1|Details> *WebApp* <${env.GITHUB_BASE_URL}/web-app/tree/main|main> <${env.GITHUB_BASE_URL}/web-app/commit/5d54920bee2bea8501d604185212aa7808195083|5d54920>`;
				const paymentServiceSummary =
					`*PaymentService* <${env.GITHUB_BASE_URL}/payment-service/tree/main|main> <${env.GITHUB_BASE_URL}/payment-service/commit/50bee2bea8501d604185212aa7808195080d5492|50bee2b>
Pact verifications: ${FAILURE_EMOJI}1`;
				const paymentServiceThread =
					`${FAILURE_EMOJI} <https://pact.example.com/results/2|Details> *MobileApp* <${env.GITHUB_BASE_URL}/mobile-app/tree/feature/payment-update|feature/payment-update> <${env.GITHUB_BASE_URL}/mobile-app/commit/e2bea8501d604185212aa78081950835d54920be|e2bea85>`;
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
				const debugData: DebugInfo = await debugResponse.json();
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
				const triggerResponse2 = await trigger();
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

		it('should consolidate events with same pacticipantVersionNumber from different buckets', async () => {
			try {
				let currentMockTime = 1000000000000; // Fixed timestamp
				mockTime(() => currentMockTime);

				// Send event with different provider version "differentVersion456"
				const eventDifferent = createWebhookPayload();
				eventDifferent.providerVersionNumber = 'differentVersion456';
				eventDifferent.providerName = 'ServiceB';
				eventDifferent.consumerName = 'ConsumerZ';
				await sendEvent(eventDifferent);

				// Move time forward a bit so eventDifferent will be aged before event1
				currentMockTime += 2 * 60 * 1000; // 2 minutes later
				mockTime(() => currentMockTime);

				// Send first event with provider version "version123"
				const event1 = createWebhookPayload();
				event1.providerVersionNumber = 'version123';
				event1.providerName = 'ServiceA';
				event1.consumerName = 'ConsumerX';
				await sendEvent(event1);

				// Move to next bucket (1 minute later)
				currentMockTime += env.MINUTE_BUCKET_MS + 1;
				mockTime(() => currentMockTime);

				// Send second event with same provider version in different bucket
				const event2 = createWebhookPayload();
				event2.providerVersionNumber = 'version123'; // Same version
				event2.providerName = 'ServiceA'; // Same provider
				event2.consumerName = 'ConsumerY'; // Different consumer
				await sendEvent(event2);

				// Move time forward so eventDifferent is aged (> 1 min) but event1 and event2 are not aged (< 1 min)
				// Timeline: eventDifferent at 0, event1 at 2min, event2 at ~3min, trigger at ~2.5min
				// eventDifferent: 2.5min old > 1min → aged, should be processed
				// event1: 0.5min old < 1min → not aged, should be consolidated
				// event2: ~0min old < 1min → not aged, should be consolidated
				const startTime = 1000000000000;
				currentMockTime = startTime + 2 * 60 * 1000 + 30 * 1000; // 2.5 minutes from start
				mockTime(() => currentMockTime);

				// Trigger processing
				await trigger();

				// Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// With consolidation logic:
				// - eventDifferent (differentVersion456) stays in bucket1 and gets processed -> 2 Slack messages
				// - event1 should move to bucket2 (same version as event2) -> no Slack messages for these
				expect(slackCalls.length).toBe(2); // 1 summary + 1 thread for eventDifferent

				// Verify the Slack message is for the different version event
				const summaryMessage = slackCalls.find(call => call.text?.startsWith('*'));
				expect(summaryMessage?.text).toContain('ServiceB');
				expect(summaryMessage?.text).toContain('Pact verifications: ✅1');

				const threadMessage = slackCalls.find(call => !call.text?.startsWith('*'));
				expect(threadMessage?.text).toContain('ConsumerZ');

				// Verify events are consolidated in storage by checking debug info
				const debugResponse = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
				expect(debugResponse.status).toBe(200);
				const debugData: DebugInfo = await debugResponse.json();

				// Should have 2 events in the most recent bucket (event1 and event2 consolidated)
				expect(debugData.totalEvents).toBe(2);
			} finally {
				resetTime();
			}
		});

		it('should flush old events even when newer events have same pacticipantVersionNumber', async () => {
			try {
				const startTime = 1000000000000; // Fixed timestamp
				let currentMockTime = startTime;
				mockTime(() => currentMockTime);

				// send initially two events to check sorting of messages as well
				// Send first event with provider version "version123" at minute 0
				const event0 = createWebhookPayload();
				event0.providerVersionNumber = 'version123';
				event0.providerName = 'ServiceA';
				event0.consumerName = 'Consumer';

				await sendEvent(event0);
				const event1 = createWebhookPayload();
				event1.providerVersionNumber = 'version123';
				event1.providerName = 'ServiceA';
				event1.consumerName = 'Consumer';
				await sendEvent(event1);

				const expectedUrl = event1.verificationResultUrl;

				currentMockTime += env.MINUTE_BUCKET_MS; // +1 minute
				mockTime(() => currentMockTime);

				const event2 = createWebhookPayload();
				event2.providerVersionNumber = 'version123'; // Same version
				event2.providerName = 'ServiceA';
				event2.consumerName = 'Consumer';
				await sendEvent(event2);

				await trigger();
				await new Promise(resolve => setTimeout(resolve, 100));

				expect(slackCalls.length).toBe(0);

				currentMockTime += env.MINUTE_BUCKET_MS; // +1 minute (total +2 minutes)
				mockTime(() => currentMockTime);

				const event3 = createWebhookPayload();
				event3.providerVersionNumber = 'version123'; // Same version
				event3.providerName = 'ServiceA';
				event3.consumerName = 'Consumer';
				await sendEvent(event3);

				currentMockTime += env.MINUTE_BUCKET_MS; // +1 minute (total +3 minutes)
				mockTime(() => currentMockTime);

				const event4 = createWebhookPayload();
				event4.providerVersionNumber = 'version123'; // Same version
				event4.providerName = 'ServiceA';
				event4.consumerName = 'Consumer';
				await sendEvent(event4);

				await trigger();
				await new Promise(resolve => setTimeout(resolve, 100));

				expect(slackCalls.length).toBe(0);

				currentMockTime += env.MINUTE_BUCKET_MS; // +1 minute (total +4 minutes)
				mockTime(() => currentMockTime);

				const event5 = createWebhookPayload();
				event5.providerVersionNumber = 'version123'; // Same version
				event5.providerName = 'ServiceA';
				event5.consumerName = 'Consumer';
				await sendEvent(event5);

				currentMockTime += env.MINUTE_BUCKET_MS; // +1 minute (total +5 minutes)
				mockTime(() => currentMockTime);

				const event6 = createWebhookPayload();
				event6.providerVersionNumber = 'version123'; // Same version
				event6.providerName = 'ServiceA';
				event6.consumerName = 'Consumer';
				await sendEvent(event6);

				await trigger();
				await new Promise(resolve => setTimeout(resolve, 100));

				expect(slackCalls.length).toBe(2); // first event is published here

				console.log('Slack calls:', slackCalls.length, slackCalls.map(call => call.text));

				const summaryMessages = slackCalls.filter(call => call.text?.startsWith('*'));
				expect(summaryMessages.length).toBe(1);

				// Each summary should show 1 verification (not consolidated)
				summaryMessages.forEach(summary => {
					expect(summary.text).toContain('Pact verifications: ✅2');
					expect(summary.text).toContain('ServiceA');
				});

				const threadMessages = slackCalls.filter(call => !call.text?.startsWith('*'));

				console.log('Thread messages:', threadMessages);
				expect(threadMessages.length).toBe(1);
				expect(threadMessages[0].text).toContain(expectedUrl);

				// Verify debug info shows remaining events
				const debugResponse = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
				expect(debugResponse.status).toBe(200);
				const debugData: DebugInfo = await debugResponse.json();

				// Should have 2 events remaining (events 3-4 not old enough to be processed yet)
				expect(debugData.totalEvents).toBe(5);
			} finally {
				resetTime();
			}
		});

		it('should not publish any events (except old) with pacticipant version number for which messages were sent just before trigger at the next minute', async () => {
			try {
				const currentMockTime = 0; // Fixed timestamp
				mockTime(() => currentMockTime);

				// Send event with provider version "version123"
				const event1 = createWebhookPayload();
				event1.providerVersionNumber = 'version123';
				event1.providerName = 'ServiceA';
				event1.consumerName = 'Consumer1';
				await sendEvent(event1);

				mockTime(() => currentMockTime + env.MINUTE_BUCKET_MS - env.QUIET_PERIOD_MS + 1);

				// Send event with provider version "version123"
				const event2 = createWebhookPayload();
				event2.providerVersionNumber = 'version123';
				event2.providerName = 'ServiceA';
				event2.consumerName = 'Consumer2';
				await sendEvent(event2);

				mockTime(() => currentMockTime + env.MINUTE_BUCKET_MS);
				// Trigger processing
				await trigger();

				// Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// Verify NO Slack message was sent as the event is too recent
				expect(slackCalls.length).toBe(0);
			} finally {
				resetTime();
			}
		});

		it('should publish events with pacticipant version number for which messages were sent before the quiet', async () => {
			try {
				const currentMockTime = 0; // Fixed timestamp
				mockTime(() => currentMockTime);

				// Send event with provider version "version123"
				const event1 = createWebhookPayload();
				event1.providerVersionNumber = 'version123';
				event1.providerName = 'ServiceA';
				event1.consumerName = 'Consumer1';
				await sendEvent(event1);

				mockTime(() => currentMockTime + env.MINUTE_BUCKET_MS - env.QUIET_PERIOD_MS);

				// Send event with provider version "version123"
				const event2 = createWebhookPayload();
				event2.providerVersionNumber = 'version123';
				event2.providerName = 'ServiceA';
				event2.consumerName = 'Consumer2';
				await sendEvent(event2);

				mockTime(() => currentMockTime + env.MINUTE_BUCKET_MS);
				// Trigger processing
				await trigger();

				// Wait for processing to complete
				await new Promise(resolve => setTimeout(resolve, 100));

				// Verify NO Slack message was sent as the event is too recent
				expect(slackCalls.length).toBe(2);
			} finally {
				resetTime();
			}
		});
	});

	describe('Summary message grouping', () => {
		it('should group summary messages by pacticipant version number', async () => {
			const events = [
				{
					eventType: 'provider_verification_published',
					providerName: 'ServiceA',
					consumerName: 'ClientX',
					verificationResultUrl: 'https://pact.example.com/results/1',
					pactUrl: 'https://pact.example.com/pacts/clientx-servicea',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'main',
					consumerVersionNumber: 'version1',
					providerVersionNumber: 'A1providerVersion'
				},
				{
					eventType: 'provider_verification_published',
					providerName: 'ServiceA',
					consumerName: 'ClientY',
					verificationResultUrl: 'https://pact.example.com/results/2',
					pactUrl: 'https://pact.example.com/pacts/clienty-servicea',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'develop',
					providerVersionBranch: 'main',
					consumerVersionNumber: 'version2',
					providerVersionNumber: 'A1providerVersion'
				},
				{
					eventType: 'provider_verification_published',
					providerName: 'ServiceA',
					consumerName: 'ClientZ',
					verificationResultUrl: 'https://pact.example.com/results/3',
					pactUrl: 'https://pact.example.com/pacts/clientz-serviceb',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'main',
					consumerVersionNumber: 'version3',
					providerVersionNumber: 'A2providerVersion'
				}
			];

			const currentMockTime = 1000000000000; // Fixed timestamp
			mockTime(() => currentMockTime);

			// Send all events
			for (const event of events) {
				const response = await sendEvent(event);
				expect(response.status).toBe(200);
			}

			mockTime(() => currentMockTime + env.MAX_TIME_BEFORE_FLUSHING + 30 * 1000);

			// Trigger batch processing
			const triggerResponse = await trigger();
			expect(triggerResponse.status).toBe(200);

			// Wait for processing to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			// Verify Slack summary messages
			const summaryMessages = slackCalls.filter(call => call.text?.startsWith('*'));
			expect(summaryMessages.length).toBe(2); // Two summaries expected

			// first summary for ServiceA version A1providerVersion
			const summary1 = summaryMessages.find(msg => msg.text?.includes('A1providerVersion'));
			expect(summary1).toBeDefined();
			expect(summary1?.text).toContain('Pact verifications: ✅2');

			// second summary for ServiceA version A2providerVersion
			const summary2 = summaryMessages.find(msg => msg.text?.includes('A2providerVersion'));
			expect(summary2).toBeDefined();
			expect(summary2?.text).toContain('Pact verifications: ✅1');
		});
	});

	describe('Clear All functionality', () => {
		it('should clear all stored data when clearAll is called', async () => {
			// First, add some events and trigger processing to populate storage
			const event1 = createWebhookPayload();
			event1.consumerVersionNumber = 'version123';
			event1.providerVersionNumber = 'providerVersion1';
			event1.providerName = 'ServiceA';
			event1.consumerName = 'ConsumerX';
			await sendEvent(event1);

			const event2 = createWebhookPayload();
			event2.consumerVersionNumber = 'version456';
			event2.providerVersionNumber = 'providerVersion2';
			event2.providerName = 'ServiceB';
			event2.consumerName = 'ConsumerY';
			await sendEvent(event2);

			// Trigger processing to create some processing stats
			await trigger();

			// Verify data exists
			const debugResponseBefore = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
			expect(debugResponseBefore.status).toBe(200);
			const debugDataBefore: DebugInfo = await debugResponseBefore.json();

			// Should have some data
			expect(debugDataBefore.totalEvents).toBeGreaterThan(0);
			expect(debugDataBefore.lastEventTime).toBeGreaterThan(0);

			// Call clearAll via the debug endpoint with clear=true
			const clearResponse = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}&clear=true`);
			expect(clearResponse.status).toBe(200);

			// Verify all data is cleared
			const debugResponseAfter = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
			expect(debugResponseAfter.status).toBe(200);
			const debugDataAfter: DebugInfo = await debugResponseAfter.json();

			// All data should be reset to initial state
			expect(debugDataAfter.totalEvents).toBe(0);
			expect(debugDataAfter.lastEventTime).toBe(0);
			expect(debugDataAfter.lastProcessTime).toBe(0);
			expect(debugDataAfter.totalProcessedEvents).toBe(0);
			expect(debugDataAfter.lastProcessedCount).toBe(0);
			expect(Object.keys(debugDataAfter.eventBuckets)).toHaveLength(0);
		});

		it('should handle clearAll when no data exists', async () => {
			// Call clearAll on empty storage
			const clearResponse = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}&clear=true`);
			expect(clearResponse.status).toBe(200);

			// Verify debug endpoint still works and returns empty state
			const debugResponse = await SELF.fetch(`https://example.com/debug?key=${env.DEBUG_KEY}`);
			expect(debugResponse.status).toBe(200);
			const debugData: DebugInfo = await debugResponse.json();

			expect(debugData.totalEvents).toBe(0);
			expect(debugData.lastEventTime).toBe(0);
			expect(debugData.lastProcessTime).toBe(0);
		});

		it('should require debug key for clearAll', async () => {
			// Call clearAll without debug key
			const clearResponse = await SELF.fetch('https://example.com/debug?clear=true');
			expect(clearResponse.status).toBe(405); // No debug key, so it won't match debug endpoint
		});
	});
});

async function sendEvent(event?: WebhookPayload) {
	return await SELF.fetch('https://example.com', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(event ?? createWebhookPayload())
	});
}

async function trigger() {
	return await SELF.fetch(`https://example.com/trigger?key=${env.DEBUG_KEY}`);
}

