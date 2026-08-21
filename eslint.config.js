import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// The scraper CLI runs under plain node, outside Vite's resolver.
		files: ['src/lib/server/scraper/**/*.ts', 'scripts/**/*.ts'],
		rules: {
			// Node's type-stripping is strip-only: it cannot desugar TypeScript
			// parameter properties (`constructor(private readonly x: T)`). vitest's
			// esbuild transform accepts them, so the tests pass while the CLI fails
			// to even load. Ban them in everything the CLI imports.
			'@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$app/*', '$env/*', '$lib/*'],
							message: 'Not resolvable outside Vite -- use a relative import.'
						}
					]
				}
			]
		}
	},
	{
		// Parsers must stay pure: string in, plain object out.
		//
		// Every parser test drives a real captured fixture through these modules
		// with no network and no database. That only keeps working if they cannot
		// reach for either -- or for the clock, which would make output depend on
		// when the test ran.
		files: ['src/lib/server/scraper/parse/**/*.ts'],
		ignores: ['src/lib/server/scraper/parse/**/*.test.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/transport/**', '**/persist/**', '**/crawl/**'],
							message: 'Parsers must not perform I/O.'
						},
						{
							group: ['**/db/**', 'node:fs', 'node:http*', 'node:net'],
							message: 'Parsers must not touch the database or filesystem.'
						},
						{
							group: ['$app/*', '$env/*'],
							message: 'The scraper runs outside Vite; $app and $env do not resolve there.'
						}
					]
				}
			],
			'no-restricted-globals': [
				'error',
				{ name: 'fetch', message: 'Parsers must not perform I/O.' },
				{
					name: 'Date',
					message: 'Parsers must be deterministic; pass timestamps in from the caller.'
				}
			],
			'no-restricted-properties': [
				'error',
				{
					object: 'process',
					property: 'env',
					message: 'Parsers must not read configuration; pass it in.'
				}
			]
		}
	}
);
