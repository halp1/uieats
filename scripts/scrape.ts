#!/usr/bin/env node
/**
 * Scraper CLI.
 *
 * Runs under plain `node` (Node 26 strips the types), outside Vite. That is
 * why nothing it imports may use $lib/$app/$env aliases -- enforced by eslint.
 *
 *   node scripts/scrape.ts
 *   node scripts/scrape.ts --unit=1 --days=2 --no-labels
 *   node scripts/scrape.ts --label-budget=50
 *   node scripts/scrape.ts --no-hours          # hours are a weekly grid
 */
import { hostname } from 'node:os';
import { getDb, resolveDatabasePath } from '../src/lib/server/db/index.ts';
import { runHousekeeping } from '../src/lib/server/health.ts';
import { loadConfig } from '../src/lib/server/scraper/config.ts';
import { runScrape } from '../src/lib/server/scraper/crawl/run.ts';
import { NetNutritionClient } from '../src/lib/server/scraper/transport/client.ts';
import { unixNow } from '../src/lib/dates.ts';

function flag(name: string): string | undefined {
	const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) return undefined;
	return hit.includes('=') ? hit.split('=').slice(1).join('=') : 'true';
}

const config = loadConfig();
const db = getDb();

/**
 * One writer at a time. adapter-node under a process manager can run several
 * instances, and two scrapers on one SQLite file would fight. A stale lock
 * older than an hour is assumed dead.
 */
const claimed = db
	.prepare(
		`INSERT INTO scrape_lock (id, acquired_at, pid, host) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET acquired_at = excluded.acquired_at, pid = excluded.pid, host = excluded.host
		 WHERE scrape_lock.acquired_at < ?`
	)
	.run(unixNow(), process.pid, hostname(), unixNow() - 3600).changes;

if (claimed === 0) {
	const held = db
		.prepare<{ pid: number; host: string }>('SELECT pid, host FROM scrape_lock WHERE id = 1')
		.get();
	console.log(`another scrape is running (pid ${held?.pid} on ${held?.host}); exiting`);
	process.exit(0);
}

const unitArg = flag('unit');
const daysArg = flag('days');
const budgetArg = flag('label-budget');

console.log(`database   ${resolveDatabasePath()}`);
console.log(`upstream   ${config.baseUrl}`);
console.log(`mode       ${config.recipeMode}${flag('no-labels') ? ' (labels skipped)' : ''}`);

const started = Date.now();
try {
	const summary = await runScrape(db, new NetNutritionClient(config), config, {
		onlyUnits: unitArg ? unitArg.split(',').map(Number) : undefined,
		daysAhead: daysArg ? Number(daysArg) : undefined,
		skipLabels: flag('no-labels') !== undefined,
		labelBudget: budgetArg ? Number(budgetArg) : undefined,
		skipHours: flag('no-hours') !== undefined,
		log: (m) => console.log(m)
	});

	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`\n${summary.status.toUpperCase()} in ${elapsed}s -- ` +
			`${summary.menusScraped} menus, ${summary.itemsUpserted} items, ` +
			`${summary.labelsFetched} labels, ${summary.httpRequests} requests, ${summary.errorCount} errors`
	);
	// Expired sessions, dead login codes and spent WebAuthn challenges. Done
	// here rather than on a timer in the web process: it is a write, and the same
	// reasoning that keeps scraping out of the web process applies to anything
	// that takes the write lock.
	const swept = runHousekeeping(db);
	if (swept.sessions + swept.loginCodes + swept.challenges > 0) {
		console.log(
			`swept      ${swept.sessions} sessions, ${swept.loginCodes} login codes, ${swept.challenges} challenges`
		);
	}

	process.exitCode = summary.status === 'failed' ? 1 : 0;
} finally {
	db.prepare('DELETE FROM scrape_lock WHERE id = 1').run();
}
