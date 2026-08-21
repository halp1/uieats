/**
 * A cookie jar just large enough for one NetNutrition session.
 *
 * Not a general implementation: this talks to exactly one host over one path,
 * so domain/path/expiry matching would be dead weight. It exists because
 * fetch() has no jar at all and the session cookies arrive on a redirect.
 */
export class CookieJar {
	readonly #jar = new Map<string, string>();

	/** Absorbs Set-Cookie headers from a response. */
	absorb(headers: Headers): void {
		for (const raw of headers.getSetCookie?.() ?? []) {
			const [pair] = raw.split(';');
			const idx = pair.indexOf('=');
			if (idx <= 0) continue;
			this.#jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
		}
	}

	/** Value for a `Cookie` request header, or '' when the jar is empty. */
	header(): string {
		return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	has(name: string): boolean {
		return this.#jar.has(name);
	}

	clear(): void {
		this.#jar.clear();
	}
}
