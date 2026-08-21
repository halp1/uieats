import type { Transport } from '../../src/lib/server/scraper/transport/client.ts';
import { loadFixture } from '../helpers/fixtures.ts';

export interface RecordedCall {
	controller: string;
	action: string;
	body: Record<string, string | number>;
}

export interface FakeTransportOptions {
	/** Keyed 'Controller/Action' or 'Controller/Action?key=value' for specificity. */
	routes: Record<string, string>;
	landing?: string;
	/** 1-indexed POSTs that should throw, to exercise partial-failure handling. */
	failCalls?: number[];
}

/**
 * A Transport backed by fixtures.
 *
 * Records every call so tests can assert not just the resulting data but the
 * request pattern -- that the standalone branch skips a redundant call, that
 * an already-fetched label is not re-fetched, and so on.
 */
export class FakeTransport implements Transport {
	readonly calls: RecordedCall[] = [];
	bootstraps = 0;
	#posts = 0;

	constructor(private readonly options: FakeTransportOptions) {}

	get requestCount(): number {
		return this.calls.length + this.bootstraps;
	}

	async bootstrap(): Promise<string> {
		this.bootstraps++;
		return loadFixture(this.options.landing ?? 'landing.html');
	}

	async post(
		controller: string,
		action: string,
		body: Record<string, string | number> = {}
	): Promise<string> {
		this.calls.push({ controller, action, body });
		this.#posts++;

		if (this.options.failCalls?.includes(this.#posts)) {
			throw new Error(`FakeTransport: injected failure on call ${this.#posts}`);
		}

		// Most specific route first, so a test can special-case one oid while
		// letting the rest fall through to a generic fixture.
		for (const [key, value] of Object.entries(body)) {
			const specific = this.options.routes[`${controller}/${action}?${key}=${value}`];
			if (specific) return loadFixture(specific);
		}

		const generic = this.options.routes[`${controller}/${action}`];
		if (generic) return loadFixture(generic);

		throw new Error(
			`FakeTransport: no route for ${controller}/${action} ${JSON.stringify(body)}. ` +
				`Known routes: ${Object.keys(this.options.routes).join(', ')}`
		);
	}
}
