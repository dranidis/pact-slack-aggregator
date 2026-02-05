import { runInDurableObject } from 'cloudflare:test';

type AnyDurableObjectStub = Parameters<typeof runInDurableObject>[0];

/**
 * Runs `callback` inside the Durable Object instance for `stub`, after applying
 * an (unsafe) env override onto the live instance.
 *
 * Notes:
 * - This does not create a new Durable Object. It mutates the existing instance.
 * - Use sparingly: prefer passing explicit override params (like the retention policy override).
 */
export async function runWithDurableObjectEnvOverride<R>(
	stub: AnyDurableObjectStub,
	envOverride: Record<string, unknown>,
	callback: (instance: unknown) => R | Promise<R>,
): Promise<R> {
	return await runInDurableObject(stub, async (instance) => {
		// Miniflare provides env as a plain object in tests; treat this as a test-only escape hatch.
		Object.assign((instance as unknown as { env: Env }).env as unknown as Record<string, unknown>, envOverride);
		return await callback(instance);
	});
}

/**
 * Temporarily overrides selected env keys for a Durable Object instance and restores the previous values.
 *
 * This keeps tests independent of wrangler config defaults without forcing production code to accept injected env.
 */
export async function withDurableObjectEnvOverride<R>(
	stub: AnyDurableObjectStub,
	envOverride: Record<string, unknown>,
	fn: () => R | Promise<R>,
): Promise<R> {
	const previous = await runInDurableObject(stub, (instance) => {
		const instanceEnv = (instance as unknown as { env: Env }).env as unknown as Record<string, unknown>;
		const snapshot: Record<string, unknown> = {};
		for (const key of Object.keys(envOverride)) {
			snapshot[key] = instanceEnv[key];
		}
		Object.assign(instanceEnv, envOverride);
		return snapshot;
	});

	try {
		return await fn();
	} finally {
		await runWithDurableObjectEnvOverride(stub, previous, () => undefined);
	}
}

export async function withRetentionPolicyForDurableObject<R>(
	stub: AnyDurableObjectStub,
	policy: { minPactVersions: number; recentDays: number },
	fn: () => R | Promise<R>,
): Promise<R> {
	return await withDurableObjectEnvOverride(
		stub,
		{
			RETENTION_MIN_PACT_VERSIONS: policy.minPactVersions,
			RETENTION_RECENT_DAYS: policy.recentDays,
		},
		fn,
	);
}
