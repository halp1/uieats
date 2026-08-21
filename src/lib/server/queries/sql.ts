/**
 * Small helpers for hand-written SQL.
 *
 * The pattern every query in here follows: fetch a whole scope with a handful
 * of set-based statements and group the rows in TypeScript, rather than
 * iterating and querying per row. A hall-day is ~150 items; doing it per item
 * would be 150 round trips through the driver for data one statement can
 * return.
 */
import type { Db, SqlParam } from '../db/driver.ts';

/** `?, ?, ?` for an IN clause of `n` values. */
export function placeholders(n: number): string {
	return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * SQLite caps bound parameters (32,766 by default). Scopes are far below that,
 * but the search and favorites paths can take an unbounded id list, so batch.
 */
const CHUNK = 500;

export function selectByIds<Row>(
	db: Db,
	sql: (list: string) => string,
	ids: readonly number[],
	extraParams: SqlParam[] = []
): Row[] {
	if (ids.length === 0) return [];

	const rows: Row[] = [];
	for (let i = 0; i < ids.length; i += CHUNK) {
		const batch = ids.slice(i, i + CHUNK);
		rows.push(...db.prepare<Row>(sql(placeholders(batch.length))).all(...extraParams, ...batch));
	}
	return rows;
}

/** Groups rows by a key, preserving the order they arrived in. */
export function groupBy<Row, Key>(rows: Row[], key: (row: Row) => Key): Map<Key, Row[]> {
	const out = new Map<Key, Row[]>();
	for (const row of rows) {
		const k = key(row);
		const bucket = out.get(k);
		if (bucket) bucket.push(row);
		else out.set(k, [row]);
	}
	return out;
}
