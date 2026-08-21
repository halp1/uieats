/**
 * The entire surface the rest of the app is allowed to use to talk to SQLite.
 *
 * Keeping this to five methods is deliberate: `node:sqlite` is young, and if it
 * disappoints, swapping in better-sqlite3 means rewriting this file and nothing
 * else. Nothing outside `db/` may import `node:sqlite` directly.
 */
import { DatabaseSync } from 'node:sqlite';

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RunResult {
	changes: number;
	lastInsertRowid: number;
}

export interface Statement<Row = Record<string, unknown>> {
	run(...params: SqlParam[]): RunResult;
	get(...params: SqlParam[]): Row | undefined;
	all(...params: SqlParam[]): Row[];
}

export interface Db {
	prepare<Row = Record<string, unknown>>(sql: string): Statement<Row>;
	exec(sql: string): void;
	/** Runs `fn` in a transaction. Nested calls use SAVEPOINTs, so they compose. */
	transaction<T>(fn: () => T): T;
	/** Reads a single-value PRAGMA, e.g. `pragma('user_version')`. */
	pragma<T = number>(name: string): T;
	close(): void;
}

/** Statements are prepared once and reused; SQLite parses are not free. */
export function openDatabase(filename: string): Db {
	const raw = new DatabaseSync(filename);

	// WAL is required, not a nicety: the scraper process writes while the web
	// process reads. Without it they block each other.
	raw.exec('PRAGMA journal_mode = WAL');
	raw.exec('PRAGMA busy_timeout = 5000');
	raw.exec('PRAGMA foreign_keys = ON');
	raw.exec('PRAGMA synchronous = NORMAL');

	const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
	let depth = 0;

	function prepared(sql: string) {
		let stmt = cache.get(sql);
		if (!stmt) {
			stmt = raw.prepare(sql);
			cache.set(sql, stmt);
		}
		return stmt;
	}

	return {
		prepare<Row>(sql: string): Statement<Row> {
			return {
				run(...params) {
					const r = prepared(sql).run(...params);
					return {
						changes: Number(r.changes),
						lastInsertRowid: Number(r.lastInsertRowid)
					};
				},
				get: (...params) => prepared(sql).get(...params) as Row | undefined,
				all: (...params) => prepared(sql).all(...params) as Row[]
			};
		},

		exec(sql) {
			// Cached statements can be invalidated by DDL, so drop the cache.
			cache.clear();
			raw.exec(sql);
		},

		transaction<T>(fn: () => T): T {
			const nested = depth > 0;
			const name = `sp_${depth}`;
			raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
			depth++;
			try {
				const result = fn();
				depth--;
				raw.exec(nested ? `RELEASE ${name}` : 'COMMIT');
				return result;
			} catch (err) {
				depth--;
				raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
				throw err;
			}
		},

		pragma<T>(name: string): T {
			const row = raw.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
			if (!row) throw new Error(`PRAGMA ${name} returned no rows`);
			return Object.values(row)[0] as T;
		},

		close() {
			cache.clear();
			raw.close();
		}
	};
}
