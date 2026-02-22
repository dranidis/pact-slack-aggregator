import { describe, it, expect } from 'vitest';
import { pascalCaseToDash, getVerificationId, extractPactUrlFromVerificationUrl, isMasterBranch, coerceInt } from '../src/utils';

describe('Utils', () => {
	describe('pascalCaseToDash', () => {
		it('should convert PascalCase strings to dash-separated', () => {
			expect(pascalCaseToDash('HelloWorld')).toBe('hello-world');
			expect(pascalCaseToDash('FooBarBaz')).toBe('foo-bar-baz');
			expect(pascalCaseToDash('TestCaseConversion')).toBe('test-case-conversion');
		});

		it('should handle single words without dashes', () => {
			expect(pascalCaseToDash('hello')).toBe('hello');
			expect(pascalCaseToDash('test')).toBe('test');
			expect(pascalCaseToDash('foo')).toBe('foo');
		});

		it('should handle empty strings', () => {
			expect(pascalCaseToDash('')).toBe('');
		});
	});

	describe('getVerificationId', () => {
		it('should extract verification ID from valid URL', () => {
			const url = 'pacts/provider/Engine/consumer/UI/pact-version/509273a340758df79e6d1596c8cf9ea594ca4306/verification-results/33421';
			expect(getVerificationId(url)).toBe(33421);
		});

		it('should return 0 when URL has no trailing number', () => {
			const url = 'pacts/provider/Engine/consumer/UI/verification-results/';
			expect(getVerificationId(url)).toBe(0);
		});

		it('should return 0 when URL does not end with number', () => {
			const url = 'pacts/provider/Engine/consumer/UI/verification-results/abc';
			expect(getVerificationId(url)).toBe(0);
		});

		it('should return 0 when string is empty', () => {
			expect(getVerificationId('')).toBe(0);
		});
	});

	describe('extractPactUrlFromVerificationUrl', () => {
		it('should extract pact URL from a valid verification result URL', () => {
			const url = 'https://pactbroker.com/pacts/provider/API/consumer/Engine/pact-version/abc123/verification-results/33687';
			expect(extractPactUrlFromVerificationUrl(url)).toBe('https://pactbroker.com/pacts/provider/API/consumer/Engine/pact-version/abc123');
		});

		it('should return empty string for a URL missing verification-results', () => {
			const url = 'https://pactbroker.com/pacts/provider/API/consumer/Engine/pact-version/abc123';
			expect(extractPactUrlFromVerificationUrl(url)).toBe('');
		});

		it('should handle URLs with extra path segments after verification-results', () => {
			const url = 'https://pactbroker.com/pacts/provider/API/consumer/Engine/pact-version/abc123/verification-results/33687/extra';
			expect(extractPactUrlFromVerificationUrl(url)).toBe('');
		});

		it('should handle URLs with no trailing number after verification-results', () => {
			const url = 'https://pactbroker.com/pacts/provider/API/consumer/Engine/pact-version/abc123/verification-results/';
			expect(extractPactUrlFromVerificationUrl(url)).toBe('');
		});
	});

	describe('coerceInt', () => {
		it('should coerce valid number strings to integers', () => {
			expect(coerceInt('42', 0, { min: 0 })).toBe(42);
			expect(coerceInt('3.14', 0, { min: 0 })).toBe(3);
		});

		it('should return fallback for non-numeric strings', () => {
			expect(coerceInt('abc', 10, { min: 0 })).toBe(10);
			expect(coerceInt('', 5, { min: 0 })).toBe(5);
		});

		it('should return fallback for non-string, non-number inputs', () => {
			expect(coerceInt({}, 7, { min: 0 })).toBe(7);
			expect(coerceInt([], 8, { min: 0 })).toBe(8);
		});

		it('should enforce minimum value constraint', () => {
			expect(coerceInt('-5', 0, { min: 0 })).toBe(0);
			expect(coerceInt('2', 0, { min: 3 })).toBe(3);
			expect(coerceInt('10', 0, { min: 5 })).toBe(10);
		});
	});

	describe('isMasterBranch', () => {
		// This function is simple and relies on environment variables, so we can test it with different env setups
		it('should return true for master branch', () => {
			const env = { DEFAULT_MASTER_BRANCH: 'master' };
			expect(isMasterBranch(env, 'AnyPacticipant', 'master')).toBe(true);
		});
		it('should return false for non-master branch', () => {
			const env = { DEFAULT_MASTER_BRANCH: 'master' };
			expect(isMasterBranch(env, 'AnyPacticipant', 'develop')).toBe(false);
		});
		it('should return false when branch is empty', () => {
			const env = { DEFAULT_MASTER_BRANCH: 'master' };
			expect(isMasterBranch(env, 'AnyPacticipant', '')).toBe(false);
		});
		it('should return true for "master"when DEFAULT_MASTER_BRANCH is not set', () => {
			const env = {};
			expect(isMasterBranch(env, 'AnyPacticipant', 'master')).toBe(true);
		});
		it('should return true for custom master branch defined in PACTICIPANT_MASTER_BRANCH_EXCEPTIONS', () => {
			const env = {
				DEFAULT_MASTER_BRANCH: 'master',
				PACTICIPANT_MASTER_BRANCH_EXCEPTIONS: { SpecialPacticipant: 'main' },
			};
			expect(isMasterBranch(env, 'SpecialPacticipant', 'main')).toBe(true);
			expect(isMasterBranch(env, 'SpecialPacticipant', 'master')).toBe(false);
		});
	});
});
