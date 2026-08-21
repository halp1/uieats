/**
 * HTTP transport for NetNutrition.
 *
 * Everything odd in here is a real, verified upstream behaviour rather than
 * defensive guesswork:
 *
 *   * Accept-Language MUST be a real language tag. undici defaults it to "*",
 *     which this ASP.NET app tries to parse as a culture; it throws and serves
 *     its "NetNutrition Start-up Error" page with HTTP 200, so the failure
 *     reads as a site outage rather than a client bug. curl works only because
 *     it sends no Accept-Language at all.
 *
 *   * The landing URL 302s back to itself and sets the session cookies on the
 *     redirect response. fetch() follows redirects but will not replay cookies
 *     it picked up along the way, so an automatic follow arrives session-less.
 *     Redirects are followed by hand, carrying the jar.
 *
 *   * A POST with no body returns HTTP 411, so an empty body is sent as `_=1`.
 *
 *   * Content-Type is misreported; JSON and raw HTML are distinguished by
 *     attempting JSON.parse (see panels.ts), not by the header.
 *
 *   * An expired session makes POSTs redirect indefinitely rather than
 *     returning an error body, so a redirect on a POST means "re-bootstrap".
 */
import type { ScraperConfig } from '../config.ts';
import { CookieJar } from './cookies.ts';
import { HttpStatusError, RequestBudgetExceeded, TransportError } from './errors.ts';
import { RateLimiter } from './limiter.ts';

export interface Transport {
	/** Establishes a session and returns the landing HTML (it holds the unit list). */
	bootstrap(): Promise<string>;
	post(controller: string, action: string, body?: Record<string, string | number>): Promise<string>;
	readonly requestCount: number;
}

const SESSION_COOKIE = 'ASP.NET_SessionId';
const MAX_REDIRECTS = 5;
/** Bounded so a persistently broken session cannot loop for the whole run. */
const MAX_REBOOTSTRAPS = 3;

export class NetNutritionClient implements Transport {
	readonly #jar = new CookieJar();
	readonly #limiter: RateLimiter;
	#requests = 0;
	#rebootstraps = 0;

	constructor(
		private readonly config: ScraperConfig,
		private readonly fetchImpl: typeof fetch = fetch
	) {
		this.#limiter = new RateLimiter(config.concurrency, config.minIntervalMs);
	}

	get requestCount(): number {
		return this.#requests;
	}

	#headers(extra: Record<string, string> = {}): Record<string, string> {
		const cookie = this.#jar.header();
		return {
			'User-Agent': this.config.userAgent,
			// See the note at the top of this file. Do not remove.
			'Accept-Language': 'en-US,en;q=0.9',
			Accept: '*/*',
			...(cookie ? { Cookie: cookie } : {}),
			...extra
		};
	}

	#budgetCheck(): void {
		if (this.config.maxRequests !== undefined && this.#requests >= this.config.maxRequests) {
			throw new RequestBudgetExceeded(this.config.maxRequests);
		}
	}

	async #send(url: string, init: RequestInit): Promise<Response> {
		this.#budgetCheck();
		this.#requests++;
		try {
			return await this.fetchImpl(url, {
				...init,
				redirect: 'manual',
				signal: AbortSignal.timeout(this.config.timeoutMs)
			});
		} catch (err) {
			throw new TransportError(`Request to ${url} failed`, err);
		}
	}

	async bootstrap(): Promise<string> {
		this.#jar.clear();
		let url = this.config.baseUrl;

		for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
			const res = await this.#limiter.run(() => this.#send(url, { headers: this.#headers() }));
			this.#jar.absorb(res.headers);

			if (res.status >= 300 && res.status < 400) {
				url = new URL(res.headers.get('location') ?? url, url).toString();
				continue;
			}
			if (res.status !== 200) {
				throw new HttpStatusError(res.status, url, await res.text());
			}

			const body = await res.text();
			if (!this.#jar.has(SESSION_COOKIE)) {
				throw new TransportError(`Bootstrap did not yield a ${SESSION_COOKIE} cookie`);
			}
			return body;
		}

		throw new TransportError(`Bootstrap exceeded ${MAX_REDIRECTS} redirects`);
	}

	async post(
		controller: string,
		action: string,
		body: Record<string, string | number> = {}
	): Promise<string> {
		if (!this.#jar.has(SESSION_COOKIE)) await this.bootstrap();

		const url = `${this.config.baseUrl}/${controller}/${action}`;
		const entries = Object.entries(body).map(([k, v]) => [k, String(v)] as [string, string]);
		// A bodyless POST returns HTTP 411 from IIS.
		const payload = new URLSearchParams(entries.length ? entries : [['_', '1']]).toString();

		let lastError: unknown;

		for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
			try {
				const res = await this.#limiter.run(() =>
					this.#send(url, {
						method: 'POST',
						headers: this.#headers({
							'X-Requested-With': 'XMLHttpRequest',
							'Content-Type': 'application/x-www-form-urlencoded'
						}),
						body: payload
					})
				);
				this.#jar.absorb(res.headers);

				// A redirect on an XHR endpoint means the session is gone.
				if (res.status >= 300 && res.status < 400) {
					await this.#recoverSession();
					continue;
				}
				if (res.status !== 200) {
					const error = new HttpStatusError(res.status, url, await res.text());
					if (!error.retryable) throw error;
					lastError = error;
					await this.#backoff(attempt);
					continue;
				}

				return await res.text();
			} catch (err) {
				if (err instanceof RequestBudgetExceeded) throw err;
				if (err instanceof HttpStatusError && !err.retryable) throw err;
				lastError = err;
				await this.#backoff(attempt);
			}
		}

		throw new TransportError(
			`POST ${controller}/${action} failed after ${this.config.maxAttempts} attempts`,
			lastError
		);
	}

	async #recoverSession(): Promise<void> {
		if (++this.#rebootstraps > MAX_REBOOTSTRAPS) {
			throw new TransportError(
				`Session kept expiring; re-bootstrapped ${MAX_REBOOTSTRAPS} times without success`
			);
		}
		await this.bootstrap();
	}

	async #backoff(attempt: number): Promise<void> {
		if (attempt >= this.config.maxAttempts) return;
		// 500ms, 1.5s, 4.5s, jittered so parallel workers do not resynchronise.
		const base = 500 * 3 ** (attempt - 1);
		const jitter = base * 0.25 * Math.random();
		await new Promise((r) => setTimeout(r, base + jitter));
	}
}
