#!/usr/bin/env node
/** Deletes the database (and its WAL sidecars) and re-creates it from scratch. */
import { rmSync } from 'node:fs';
import { resolveDatabasePath } from '../src/lib/server/db/index.ts';

const path = resolveDatabasePath();
for (const suffix of ['', '-wal', '-shm']) {
	rmSync(path + suffix, { force: true });
}
console.log(`removed ${path}`);

await import('./migrate.ts');
