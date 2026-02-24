export function pascalCaseToDash(str: string): string {
	return str
		.replace(/([A-Z])/g, (g) => `-${g[0].toLowerCase()}`) // Add dash before uppercase letters
		.replace(/^-/, ''); // Remove leading dash if present
}

/**
 * Extract verification ID from resultUrl (last number after last slash)
 * Example: "pacts/provider/LaravelBonusEngine/consumer/BoUI/pact-version/509273a340758df79e6d1596c8cf9ea594ca4306/verification-results/33421" => 33421
 */
export function getVerificationId(url: string): number {
	const regex = /\/(\d+)$/;
	const match = regex.exec(url);
	if (!match) console.error('Invalid verification result URL format: ' + url);
	return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extract pact URL from verification results URL by removing the verification-results part
 * Example: "https://pactbrokerurl.com/pacts/provider/SomeAPI/consumer/LaravelBonusEngine/pact-version/838c2580b272637dd1a071a2c04c2a21f82a0e33/verification-results/33687"
 * Returns: "https://pactbrokerurl.com/pacts/provider/SomeAPI/consumer/LaravelBonusEngine/pact-version/838c2580b272637dd1a071a2c04c2a21f82a0e33"
 */
export function extractPactUrlFromVerificationUrl(verificationResultUrl: string): string {
	// Remove /verification-results/xxxxx from the end
	const regex = /(.+)\/verification-results\/\d+$/;
	const match = regex.exec(verificationResultUrl);
	if (!match) console.error('Invalid verification result URL format: ' + verificationResultUrl);
	return match ? match[1] : '';
}

/**
 * Returns a coerced integer value based on the input, with a fallback and minimum value constraint.
 *
 * @param value
 * @param fallback
 * @param opts
 * @returns
 */
export function coerceInt(value: unknown, fallback: number, opts: { min: number }): number {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	const i = Math.floor(n);
	if (i < opts.min) return Math.max(opts.min, fallback);
	return i;
}

interface MasterBranchEnv {
	DEFAULT_MASTER_BRANCH?: string;
	PACTICIPANT_MASTER_BRANCH_EXCEPTIONS?: Record<string, string>;
}

/**
 * Returns the configured "master" (default) branch name for a given pacticipant.
 *
 * Resolution order:
 * 1) env.PACTICIPANT_MASTER_BRANCH_EXCEPTIONS[pacticipant]
 * 2) env.DEFAULT_MASTER_BRANCH
 * 3) 'master'
 */
function getPacticipantMasterBranch(env: MasterBranchEnv, pacticipant: string): string {
	const defaultBranch = (env.DEFAULT_MASTER_BRANCH ?? 'master').trim();
	const exceptions = env.PACTICIPANT_MASTER_BRANCH_EXCEPTIONS;
	const exception = exceptions?.[pacticipant];
	if (exception) return exception;
	return defaultBranch;
}

export function isMasterBranch(env: MasterBranchEnv, pacticipant: string, branch: string): boolean {
	return branch === getPacticipantMasterBranch(env, pacticipant);
}
