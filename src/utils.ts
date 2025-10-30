export function pascalCaseToDash(str: string): string {
	return str
		.replace(/([A-Z])/g, (g) => `-${g[0].toLowerCase()}`) // Add dash before uppercase letters
		.replace(/^-/, '');                                   // Remove leading dash if present
}

/**
 * Extract verification ID from resultUrl (last number after last slash)
 * Example: "pacts/provider/LaravelBonusEngine/consumer/BoUI/pact-version/509273a340758df79e6d1596c8cf9ea594ca4306/verification-results/33421" => 33421
 */
export function getVerificationId(url?: string): number {
	if (!url) return 0;
	const regex = /\/(\d+)$/;
	const match = regex.exec(url);
	return match ? parseInt(match[1], 10) : 0;
}
