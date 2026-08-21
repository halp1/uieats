import type { Db } from '../../src/lib/server/db/driver.ts';

/**
 * Columns that legitimately change between runs. Everything else must be
 * byte-identical when the same input is scraped twice.
 */
const VOLATILE = new Set([
	'first_seen_at',
	'last_seen_at',
	'last_scraped_at',
	'observed_at',
	'scraped_at',
	'fetched_at',
	'label_fetched_at',
	'created_at',
	'started_at',
	'finished_at',
	'at',
	'scrape_run_id'
]);

const SKIP_TABLES = new Set(['scrape_run', 'scrape_error', 'scrape_lock']);

/**
 * An ordered dump of every data table, minus volatile columns.
 *
 * Comparing two of these is how "scrape twice, get identical rows" is asserted
 * without hand-listing which tables to check -- a new table added later is
 * covered automatically.
 */
export interface SnapshotOptions {
	/**
	 * Drop surrogate `id` columns. Use when a row may legitimately be deleted
	 * and re-created (a dish leaving a menu and coming back), where identical
	 * content matters but the autoincrement key does not. Nothing outside the
	 * cascade references menu_item.id.
	 */
	ignoreIds?: boolean;
}

export function snapshotDb(db: Db, options: SnapshotOptions = {}): Record<string, unknown[]> {
	const tables = db
		.prepare<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all()
		.map((r) => r.name)
		.filter((name) => !SKIP_TABLES.has(name));

	const snapshot: Record<string, unknown[]> = {};

	for (const table of tables) {
		const columns = db
			.prepare<{ name: string }>(`PRAGMA table_info(${table})`)
			.all()
			.map((c) => c.name)
			.filter((c) => !VOLATILE.has(c))
			.filter((c) => !(options.ignoreIds && (c === 'id' || c.endsWith('_id'))));
		if (columns.length === 0) continue;

		const list = columns.map((c) => `"${c}"`).join(', ');
		snapshot[table] = db
			.prepare(`SELECT ${list} FROM ${table} ORDER BY ${list}`)
			.all()
			.map((row) => ({ ...row }));
	}

	return snapshot;
}
