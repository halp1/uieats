import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// Enforced in hooks.server.ts instead, with an exemption for the OAuth
			// token, registration and revocation endpoints. Those take form posts
			// from other origins by design (RFC 6749 says so) and authenticate by
			// client secret or PKCE, never by cookie, so there is nothing to forge.
			csrf: { trustedOrigins: ['*'] }
		})
	],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/lib/server/**/*.test.ts', 'tests/**/*.test.ts'],
					// The live smoke test is opt-in via LIVE_SCRAPE_TEST; it still needs to be
					// collected so `test:live` can run it, but it self-skips otherwise.
					exclude: ['tests/fixtures/**']
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			// Gate only the code where correctness is load-bearing, not the whole repo.
			include: ['src/lib/server/scraper/parse/**', 'src/lib/server/allergens/**'],
			thresholds: { lines: 90 }
		}
	}
});
