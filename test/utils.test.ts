import { describe, it, expect } from 'vitest';
import { pascalCaseToDash } from '../src/utils';

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
});
