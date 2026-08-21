/**
 * Concurrency gate plus a minimum gap between request starts.
 *
 * Both halves matter. Concurrency alone still allows a burst when several
 * fast responses land together, and an interval alone lets slow requests pile
 * up. Together they hold a genuine ceiling on what we do to someone else's
 * server.
 */
export class RateLimiter {
	#active = 0;
	// -Infinity, not 0: the interval spaces requests from the PREVIOUS one, and
	// there is no previous one at start-up. Initialising to 0 makes the very
	// first request of every run sleep for no reason.
	#lastStart = Number.NEGATIVE_INFINITY;
	readonly #queue: (() => void)[] = [];

	readonly #concurrency: number;
	readonly #minIntervalMs: number;
	/** Injectable so tests need neither a real clock nor real sleeping. */
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;

	// Explicit fields rather than parameter properties: Node's strip-only type
	// removal cannot desugar those, and the scraper CLI runs under plain node.
	constructor(
		concurrency: number,
		minIntervalMs: number,
		now: () => number = () => Date.now(),
		sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
	) {
		this.#concurrency = concurrency;
		this.#minIntervalMs = minIntervalMs;
		this.#now = now;
		this.#sleep = sleep;
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		await this.#acquire();
		try {
			const wait = this.#lastStart + this.#minIntervalMs - this.#now();
			if (wait > 0) await this.#sleep(wait);
			this.#lastStart = this.#now();
			return await task();
		} finally {
			this.#release();
		}
	}

	async #acquire(): Promise<void> {
		if (this.#active < this.#concurrency) {
			this.#active++;
			return;
		}
		await new Promise<void>((resolve) => this.#queue.push(resolve));
		this.#active++;
	}

	#release(): void {
		this.#active--;
		this.#queue.shift()?.();
	}
}
