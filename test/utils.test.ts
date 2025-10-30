import { describe, it, expect } from 'vitest';
import { pascalCaseToDash, getVerificationId } from '../src/utils';

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
			const url = 'pacts/provider/LaravelBonusEngine/consumer/BoUI/pact-version/509273a340758df79e6d1596c8cf9ea594ca4306/verification-results/33421';
			expect(getVerificationId(url)).toBe(33421);
		});

		it('should return 0 when URL has no trailing number', () => {
			const url = 'pacts/provider/LaravelBonusEngine/consumer/BoUI/verification-results/';
			expect(getVerificationId(url)).toBe(0);
		});

		it('should return 0 when URL does not end with number', () => {
			const url = 'pacts/provider/LaravelBonusEngine/consumer/BoUI/verification-results/abc';
			expect(getVerificationId(url)).toBe(0);
		});

		it('should return 0 when string is undefined', () => {
			expect(getVerificationId(undefined)).toBe(0);
		});

		it('should return 0 when string is empty', () => {
			expect(getVerificationId('')).toBe(0);
		});
	});
});
