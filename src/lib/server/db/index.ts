/**
 * Process-wide database handle.
 *
 * This is a module singleton rather than something hung off `event.locals`
 * because the handle is synchronous, cheap, and shared: giving each request its
 * own would just multiply prepared-statement caches. `hooks.server.ts` stays
 * concerned with auth only.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Db, openDatabase } from './driver.ts';
import { migrate } from './migrate.ts';

export type { Db, Statement } from './driver.ts';

export function resolveDatabasePath(): string {
	const configured = process.env.DATABASE_PATH?.trim();
	return configured ? resolve(configured) : join(process.cwd(), 'data', 'uieats.db');
}

let handle: Db | undefined;

export function getDb(): Db {
	if (!handle) {
		const path = resolveDatabasePath();
		mkdirSync(dirname(path), { recursive: true });
		handle = openDatabase(path);
		migrate(handle);
	}
	return handle;
}

/** Test/CLI helper: a fully migrated in-memory database. */
export function createMemoryDb(): Db {
	const db = openDatabase(':memory:');
	migrate(db);
	return db;
}

export function closeDb(): void {
	handle?.close();
	handle = undefined;
}
