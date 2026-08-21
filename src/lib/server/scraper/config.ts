/**
 * Scraper configuration.
 *
 * Reads process.env directly and never $env/*: the scraper runs from a plain
 * `node scripts/scrape.ts`, outside Vite, where those aliases do not resolve.
 */

export interface ScraperConfig {
	baseUrl: string;
	userAgent: string;
	/** Days before today to keep scraping (upstream publishes ~1 week back). */
	daysBehind: number;
	/** Days ahead to scrape. Upstream offers ~28; each day costs ~110 menus. */
	daysAhead: number;
	concurrency: number;
	minIntervalMs: number;
	timeoutMs: number;
	maxAttempts: number;
	/**
	 * 'full'   -- one nutrition label per item instance (the default).
	 * 'dedupe' -- one per normalized (name, serving size); ~10x cheaper, but
	 *             assumes a dish is identical wherever it appears.
	 */
	recipeMode: 'full' | 'dedupe';
	dryRun: boolean;
	/** Hard stop on HTTP requests per run; undefined means no cap. */
	maxRequests: number | undefined;
}

function int(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
	}
	return n;
}

export function loadConfig(): ScraperConfig {
	const mode = process.env.RECIPE_MODE ?? 'full';
	if (mode !== 'full' && mode !== 'dedupe') {
		throw new Error(`RECIPE_MODE must be 'full' or 'dedupe', got ${JSON.stringify(mode)}`);
	}

	return {
		baseUrl: (
			process.env.NETNUTRITION_BASE_URL ?? 'https://eatsmart.housing.illinois.edu/NetNutrition/46'
		).replace(/\/+$/, ''),
		// Identifies the project with a contact URL. This is an unauthenticated
		// scrape of a university server with no API contract; being reachable is
		// the least we owe them.
		userAgent: process.env.SCRAPER_USER_AGENT ?? 'uieats/0.1 (+https://github.com/yourname/uieats)',
		daysBehind: int('SCRAPE_DAYS_BEHIND', 1),
		daysAhead: int('SCRAPE_DAYS_AHEAD', 21),
		concurrency: int('SCRAPER_CONCURRENCY', 3),
		minIntervalMs: int('SCRAPER_MIN_INTERVAL_MS', 150),
		timeoutMs: int('SCRAPER_TIMEOUT_MS', 20_000),
		maxAttempts: int('SCRAPER_MAX_ATTEMPTS', 3),
		recipeMode: mode,
		dryRun: process.env.SCRAPER_DRY_RUN === '1',
		maxRequests: process.env.SCRAPER_MAX_REQUESTS ? int('SCRAPER_MAX_REQUESTS', 0) : undefined
	};
}
