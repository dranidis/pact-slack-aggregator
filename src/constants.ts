// Event type constants
export const PROVIDER_VERIFICATION_PUBLISHED = 'provider_verification_published' as const;
export const CONTRACT_REQUIRING_VERIFICATION_PUBLISHED = 'contract_requiring_verification_published' as const;
export const THREAD_REMOVAL_NOTICE: string = '🦕 *Old pact!*\nThis thread will stop receiving updates!' as const;
export const DEPRECATION_NOTICE: string = '🧹 *Deprecated pact!*\nThis thread will stop receiving updates!' as const;
export const THREAD_DISCONTINUED_DUE_TO_SIZE_NOTICE: string =
	'🧵 *Thread discontinued*\nThis thread will stop receiving updates due to many replies. A new thread has been opened for new updates for this contract.' as const;
export const DAY_MS = 24 * 60 * 60 * 1000;
