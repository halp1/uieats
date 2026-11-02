/**
 * The app's own copy of SvelteKit's cross-site form check. It replaced the
 * built-in one, so if it is wrong every form action on the site is exposed.
 */
import { describe, expect, it } from 'vitest';
import { isForbiddenCrossSiteForm } from '../src/lib/server/csrf.ts';

const ORIGIN = 'https://uieats.example';

function req(path: string, init: { method?: string; type?: string; origin?: string | null }) {
	const headers: Record<string, string> = {};
	if (init.type) headers['content-type'] = init.type;
	if (init.origin) headers.origin = init.origin;
	const url = new URL(path, ORIGIN);
	return [new Request(url, { method: init.method ?? 'POST', headers, body: 'x=1' }), url] as const;
}

describe('isForbiddenCrossSiteForm', () => {
	it.each([
		[
			'cross-site form to an action',
			'/settings/allergens?/save',
			'application/x-www-form-urlencoded',
			'https://evil.example',
			true
		],
		['form with no origin', '/settings/tokens?/create', 'multipart/form-data', null, true],
		[
			'cross-site form to the consent page',
			'/oauth/authorize?/approve',
			'application/x-www-form-urlencoded',
			'https://evil.example',
			true
		],
		[
			'text/plain with charset',
			'/auth/logout',
			'text/plain; charset=utf-8',
			'https://evil.example',
			true
		],
		[
			'same-origin form',
			'/settings/allergens?/save',
			'application/x-www-form-urlencoded',
			ORIGIN,
			false
		],
		['cross-site JSON (not a form)', '/mcp', 'application/json', 'https://evil.example', false],
		['OAuth token endpoint', '/oauth/token', 'application/x-www-form-urlencoded', null, false],
		[
			'OAuth revocation endpoint',
			'/oauth/revoke',
			'application/x-www-form-urlencoded',
			'https://gemini.google.com',
			false
		]
	])('%s', (_, path, type, origin, forbidden) => {
		const [request, url] = req(path, { type, origin });
		expect(isForbiddenCrossSiteForm(request, url)).toBe(forbidden);
	});
});
