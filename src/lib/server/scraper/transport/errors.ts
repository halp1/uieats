export class TransportError extends Error {
	// Explicit fields, not parameter properties: Node's type-stripping is
	// strip-only and cannot desugar `constructor(private readonly x: T)`. The
	// scraper CLI runs under plain node, so that syntax fails at load time even
	// though vitest's transform accepts it.
	readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = 'TransportError';
		this.cause = cause;
	}
}

export class HttpStatusError extends TransportError {
	readonly status: number;
	readonly url: string;
	readonly bodyExcerpt: string;

	constructor(status: number, url: string, bodyExcerpt: string) {
		super(`HTTP ${status} from ${url}: ${bodyExcerpt.slice(0, 200)}`);
		this.name = 'HttpStatusError';
		this.status = status;
		this.url = url;
		this.bodyExcerpt = bodyExcerpt;
	}

	/** 5xx and the two "come back later" 4xx are worth another attempt. */
	get retryable(): boolean {
		return this.status >= 500 || this.status === 408 || this.status === 429;
	}
}

export class RequestBudgetExceeded extends TransportError {
	constructor(limit: number) {
		super(`SCRAPER_MAX_REQUESTS budget of ${limit} exhausted`);
		this.name = 'RequestBudgetExceeded';
	}
}
