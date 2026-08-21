/**
 * Migrations are numbered .sql files applied in filename order, tracked with
 * PRAGMA user_version. No framework: the whole contract is "file N has run iff
 * user_version >= N", which makes re-running a no-op and makes the state
 * inspectable with a single pragma.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './driver.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	return files.map((name) => {
		const match = /^(\d+)_/.exec(name);
		if (!match) {
			throw new Error(`Migration "${name}" must start with a number, e.g. 0001_init.sql`);
		}
		return {
			version: Number(match[1]),
			name,
			sql: readFileSync(join(dir, name), 'utf8')
		};
	});
}

export interface MigrateResult {
	from: number;
	to: number;
	applied: string[];
}

export function migrate(db: Db, migrations: Migration[] = loadMigrations()): MigrateResult {
	const from = db.pragma<number>('user_version');
	const applied: string[] = [];

	for (const [i, m] of migrations.entries()) {
		const expected = i + 1;
		if (m.version !== expected) {
			throw new Error(
				`Migration versions must be contiguous from 1; expected ${expected}, got ${m.version} (${m.name})`
			);
		}
		if (m.version <= from) continue;

		// A migration is all-or-nothing. user_version is bumped inside the same
		// transaction so a crash mid-file can never leave a half-applied schema.
		db.transaction(() => {
			db.exec(m.sql);
			db.exec(`PRAGMA user_version = ${m.version}`);
		});
		applied.push(m.name);
	}

	return { from, to: db.pragma<number>('user_version'), applied };
}
