/**
 * Boot checks and housekeeping.
 *
 * The web process reports on the data it is serving; it never fixes it. An app
 * that quietly kicks off a scrape when it notices stale menus would run several
 * of them under a process manager, fight over one SQLite file, and take the web
 * server down with any hung request. Scraping is a cron job. This only tells
 * the truth loudly.
 */
import type { Db } from './db/driver.ts';
import { STALE_AFTER_SECONDS, describeAge, unixNow } from '../dates.ts';

export interface DataFreshness {
	lastSuccessAt: number | null;
	isStale: boolean;
}

export function getFreshness(db: Db, now: number = unixNow()): DataFreshness {
	const row = db
		.prepare<{ finished_at: number | null }>(
			`SELECT finished_at FROM scrape_run
			 WHERE status IN ('ok', 'partial') AND finished_at IS NOT NULL
			 ORDER BY finished_at DESC LIMIT 1`
		)
		.get();

	const lastSuccessAt = row?.finished_at ?? null;
	return {
		lastSuccessAt,
		isStale: lastSuccessAt === null || now - lastSuccessAt > STALE_AFTER_SECONDS
	};
}

/**
 * Logged once at boot, never on a request path.
 *
 * Stale menu data is the failure mode a user cannot see for themselves: the
 * pages render perfectly, they are just describing last Tuesday. So it goes to
 * the operator's log at startup as well as to the footer.
 */
export function logStartupHealth(db: Db, log: (message: string) => void = console.warn): void {
	const { lastSuccessAt, isStale } = getFreshness(db);

	if (lastSuccessAt === null) {
		log(
			'[health] no successful scrape has ever finished. Menus will be empty until ' +
				'`node scripts/scrape.ts` runs.'
		);
		return;
	}
	if (isStale) {
		log(
			`[health] the last successful scrape finished ${describeAge(lastSuccessAt)}, past the ` +
				`${Math.round(STALE_AFTER_SECONDS / 3600)}h threshold. Check the cron job; uieats will ` +
				'keep serving what it has and say so in the footer.'
		);
	}
}

export interface HousekeepingResult {
	sessions: number;
	loginCodes: number;
	challenges: number;
}

/**
 * Deletes rows that are dead by their own timestamps.
 *
 * Run from the scrape CLI rather than on a timer in the web process: it is a
 * write, and the same reasoning that keeps scraping out of the web process
 * applies to anything that takes the write lock.
 */
export function runHousekeeping(db: Db, now: number = unixNow()): HousekeepingResult {
	return db.transaction(() => ({
		sessions: db.prepare('DELETE FROM user_session WHERE expires_at <= ?').run(now).changes,
		// A day past expiry, not immediately: a recently-expired code is what
		// makes "that code has expired" possible instead of a bare "invalid".
		loginCodes: db.prepare('DELETE FROM login_code WHERE expires_at < ?').run(now - 86_400).changes,
		challenges: db.prepare('DELETE FROM webauthn_challenge WHERE expires_at <= ?').run(now).changes
	}));
}
