import { describe, expect, it } from 'vitest';
import { NetNutritionClient } from '../../src/lib/server/scraper/transport/client.ts';
import { RequestBudgetExceeded } from '../../src/lib/server/scraper/transport/errors.ts';
import { RateLimiter } from '../../src/lib/server/scraper/transport/limiter.ts';
import type { ScraperConfig } from '../../src/lib/server/scraper/config.ts';

const CONFIG: ScraperConfig = {
	baseUrl: 'https://example.test/NetNutrition/46',
	userAgent: 'uieats-test/0.1',
	daysBehind: 1,
	daysAhead: 21,
	concurrency: 3,
	minIntervalMs: 0,
	timeoutMs: 5000,
	maxAttempts: 3,
	recipeMode: 'full',
	dryRun: false,
	maxRequests: undefined
};

interface Recorded {
	url: string;
	headers: Record<string, string>;
	method: string;
	body: string | undefined;
}

/** Builds a fetch stub plus a log of what the client actually sent. */
function stubFetch(responses: (() => Response)[]) {
	const sent: Recorded[] = [];
	let i = 0;
	const impl = (async (url: string | URL, init?: RequestInit) => {
		sent.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			method: init?.method ?? 'GET',
			body: init?.body as string | undefined
		});
		const next = responses[Math.min(i++, responses.length - 1)];
		return next();
	}) as unknown as typeof fetch;
	return { impl, sent };
}

function html(body: string, status = 200, headers: Record<string, string> = {}) {
	return () => new Response(body, { status, headers });
}

function redirect(location: string, setCookie?: string) {
	const h = new Headers({ location });
	if (setCookie) h.append('set-cookie', setCookie);
	return () => new Response('', { status: 302, headers: h });
}

const SESSION = 'ASP.NET_SessionId=abc123; path=/; HttpOnly';
const LANDING = '<html><section id="cbo_nn_unitDataList">units</section></html>';

describe('bootstrap', () => {
	it('sends a real Accept-Language, never undici default of "*"', async () => {
		// This is THE bug that makes upstream look down. It parses the header as
		// a culture, throws, and returns its start-up error page with HTTP 200.
		const { impl, sent } = stubFetch([html(LANDING, 200, { 'set-cookie': SESSION })]);
		await new NetNutritionClient(CONFIG, impl).bootstrap();

		const lang = sent[0].headers['Accept-Language'];
		expect(lang).toBeDefined();
		expect(lang).not.toBe('*');
		expect(lang).toMatch(/^en/);
	});

	it('follows the self-redirect by hand, carrying the cookies it just got', async () => {
		// fetch() follows redirects but will not replay cookies picked up during
		// them, so an automatic follow arrives session-less.
		const { impl, sent } = stubFetch([redirect('/NetNutrition/46', SESSION), html(LANDING, 200)]);
		const body = await new NetNutritionClient(CONFIG, impl).bootstrap();

		expect(body).toBe(LANDING);
		expect(sent).toHaveLength(2);
		expect(sent[0].headers.Cookie).toBeUndefined();
		expect(sent[1].headers.Cookie).toContain('ASP.NET_SessionId=abc123');
	});

	it('refuses to continue if no session cookie was issued', async () => {
		const { impl } = stubFetch([html(LANDING, 200)]);
		await expect(new NetNutritionClient(CONFIG, impl).bootstrap()).rejects.toThrow(
			/ASP.NET_SessionId/
		);
	});

	it('gives up rather than looping forever on redirects', async () => {
		const { impl } = stubFetch([redirect('/NetNutrition/46', SESSION)]);
		await expect(new NetNutritionClient(CONFIG, impl).bootstrap()).rejects.toThrow(/redirects/);
	});
});

describe('post', () => {
	it('bootstraps automatically before the first call', async () => {
		const { impl, sent } = stubFetch([html(LANDING, 200, { 'set-cookie': SESSION }), html('{}')]);
		await new NetNutritionClient(CONFIG, impl).post('Unit', 'SelectUnitFromUnitsList', {
			unitOid: 1
		});

		expect(sent[0].method).toBe('GET');
		expect(sent[1].method).toBe('POST');
		expect(sent[1].url).toBe('https://example.test/NetNutrition/46/Unit/SelectUnitFromUnitsList');
		expect(sent[1].body).toBe('unitOid=1');
	});

	it('never sends an empty body, because IIS answers 411', async () => {
		const { impl, sent } = stubFetch([html(LANDING, 200, { 'set-cookie': SESSION }), html('{}')]);
		await new NetNutritionClient(CONFIG, impl).post('Trait', 'TraitList');

		expect(sent[1].body).toBe('_=1');
	});

	it('marks itself as an XHR, which upstream requires for panel responses', async () => {
		const { impl, sent } = stubFetch([html(LANDING, 200, { 'set-cookie': SESSION }), html('{}')]);
		await new NetNutritionClient(CONFIG, impl).post('Unit', 'SelectUnitFromUnitsList', {
			unitOid: 1
		});

		expect(sent[1].headers['X-Requested-With']).toBe('XMLHttpRequest');
		expect(sent[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
	});

	it('treats a redirect on a POST as an expired session and re-bootstraps', async () => {
		// An expired session does not return an error body; it redirects forever.
		let call = 0;
		const impl = (async () => {
			call++;
			if (call === 1)
				return new Response(LANDING, { status: 200, headers: { 'set-cookie': SESSION } });
			if (call === 2)
				return new Response('', { status: 302, headers: { location: '/NetNutrition/46' } });
			if (call === 3)
				return new Response(LANDING, { status: 200, headers: { 'set-cookie': SESSION } });
			return new Response('{"success":true,"panels":[]}');
		}) as unknown as typeof fetch;

		const client = new NetNutritionClient(CONFIG, impl);
		const body = await client.post('Menu', 'SelecUnitAndtMenu', { unitOid: 2, menuOid: 1 });
		expect(body).toContain('success');
	});

	it('retries a 500 and succeeds', async () => {
		let call = 0;
		const impl = (async () => {
			call++;
			if (call === 1)
				return new Response(LANDING, { status: 200, headers: { 'set-cookie': SESSION } });
			if (call === 2) return new Response('boom', { status: 500 });
			return new Response('ok');
		}) as unknown as typeof fetch;

		const config = { ...CONFIG, maxAttempts: 3 };
		expect(await new NetNutritionClient(config, impl).post('Unit', 'X', { a: 1 })).toBe('ok');
	});

	it('does not retry a 404, which will never become a 200', async () => {
		const { impl, sent } = stubFetch([
			html(LANDING, 200, { 'set-cookie': SESSION }),
			html('nope', 404)
		]);
		await expect(new NetNutritionClient(CONFIG, impl).post('Unit', 'X', { a: 1 })).rejects.toThrow(
			/HTTP 404/
		);
		expect(sent).toHaveLength(2);
	});

	it('stops dead when the request budget is exhausted', async () => {
		const { impl } = stubFetch([html(LANDING, 200, { 'set-cookie': SESSION }), html('{}')]);
		const client = new NetNutritionClient({ ...CONFIG, maxRequests: 1 }, impl);

		await expect(client.post('Unit', 'X', { a: 1 })).rejects.toThrow(RequestBudgetExceeded);
	});

	it('counts every request it makes', async () => {
		const { impl } = stubFetch([html(LANDING, 200, { 'set-cookie': SESSION }), html('{}')]);
		const client = new NetNutritionClient(CONFIG, impl);
		await client.post('Unit', 'X', { a: 1 });
		expect(client.requestCount).toBe(2);
	});
});

describe('RateLimiter', () => {
	it('never exceeds the concurrency ceiling', async () => {
		const limiter = new RateLimiter(3, 0);
		let active = 0;
		let peak = 0;

		await Promise.all(
			Array.from({ length: 20 }, () =>
				limiter.run(async () => {
					peak = Math.max(peak, ++active);
					await new Promise((r) => setTimeout(r, 1));
					active--;
				})
			)
		);

		expect(peak).toBeLessThanOrEqual(3);
	});

	it('spaces request starts by the configured interval', async () => {
		let clock = 0;
		const starts: number[] = [];
		const limiter = new RateLimiter(
			1,
			150,
			() => clock,
			async (ms) => {
				clock += ms;
			}
		);

		for (let i = 0; i < 4; i++) {
			await limiter.run(async () => {
				starts.push(clock);
			});
		}

		expect(starts).toEqual([0, 150, 300, 450]);
	});
});
