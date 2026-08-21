#!/usr/bin/env node
/** Applies pending migrations to the on-disk database. Safe to re-run. */
import { getDb, resolveDatabasePath } from '../src/lib/server/db/index.ts';
import { loadMigrations, migrate } from '../src/lib/server/db/migrate.ts';
import { openDatabase } from '../src/lib/server/db/driver.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = resolveDatabasePath();
mkdirSync(dirname(path), { recursive: true });

const db = openDatabase(path);
const result = migrate(db, loadMigrations());
db.close();

if (result.applied.length === 0) {
	console.log(`${path}: already at version ${result.to}, nothing to do`);
} else {
	console.log(`${path}: ${result.from} -> ${result.to}`);
	for (const name of result.applied) console.log(`  applied ${name}`);
}
void getDb;
