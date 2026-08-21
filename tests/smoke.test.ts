import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('toolchain', () => {
	it('runs vitest with node:sqlite and STRICT tables available', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT NOT NULL) STRICT');
		db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(1, 'ok');
		expect(db.prepare('SELECT b FROM t WHERE a = ?').get(1)).toMatchObject({ b: 'ok' });
		db.close();
	});
});
