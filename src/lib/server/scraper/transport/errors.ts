export class TransportError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'TransportError';
	}
}

export class HttpStatusError extends TransportError {
	constructor(
		readonly status: number,
		readonly url: string,
		readonly bodyExcerpt: string
	) {
		super(`HTTP ${status} from ${url}: ${bodyExcerpt.slice(0, 200)}`);
		this.name = 'HttpStatusError';
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
