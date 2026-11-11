import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import {
	MAX_TOKENS,
	TOKEN_PREFIX,
	TokenError,
	createApiToken,
	listApiTokens,
	parseBearer,
	resolveApiToken,
	revokeApiToken
} from '../../src/lib/server/auth/tokens.ts';

const NOW = 1_760_000_000;
let db: Db;
let alice: number;
let bob: number;

function addUser(email: string): number {
	return db.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)').run(email, NOW)
		.lastInsertRowid;
}

beforeEach(() => {
	db = createMemoryDb();
	alice = addUser('alice@illinois.edu');
	bob = addUser('bob@illinois.edu');
});

describe('api tokens', () => {
	it('resolves a fresh token to its owner and never stores it raw', () => {
		const { token } = createApiToken(db, alice, 'Claude', NOW);
		expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
		expect(resolveApiToken(db, token, NOW)).toMatchObject({ id: alice });

		const dump = JSON.stringify(db.prepare('SELECT * FROM api_token').all());
		expect(dump).not.toContain(token);
		expect(dump).not.toContain(token.slice(TOKEN_PREFIX.length));
	});

	it.each([
		['empty', ''],
		['unprefixed', 'abc'],
		['wrong secret', `${TOKEN_PREFIX}nope`],
		['null', null]
	])('rejects a %s token', (_, raw) => {
		createApiToken(db, alice, 'Claude', NOW);
		expect(resolveApiToken(db, raw, NOW)).toBeNull();
	});

	it('revocation is scoped to the owner and takes effect immediately', () => {
		const { id, token } = createApiToken(db, alice, 'Claude', NOW);
		expect(revokeApiToken(db, bob, id)).toBe(false);
		expect(resolveApiToken(db, token, NOW)).not.toBeNull();

		expect(revokeApiToken(db, alice, id)).toBe(true);
		expect(resolveApiToken(db, token, NOW)).toBeNull();
	});

	it('dies with its user', () => {
		const { token } = createApiToken(db, alice, 'Claude', NOW);
		db.prepare('DELETE FROM user WHERE id = ?').run(alice);
		expect(resolveApiToken(db, token, NOW)).toBeNull();
	});

	it('enforces name and count limits', () => {
		expect(() => createApiToken(db, alice, '   ', NOW)).toThrow(TokenError);
		expect(() => createApiToken(db, alice, 'x'.repeat(41), NOW)).toThrow(TokenError);
		for (let i = 0; i < MAX_TOKENS; i++) createApiToken(db, alice, `t${i}`, NOW);
		expect(() => createApiToken(db, alice, 'one more', NOW)).toThrow(TokenError);
		// Another user's budget is separate.
		expect(() => createApiToken(db, bob, 'first', NOW)).not.toThrow();
	});

	it('throttles last_used_at writes', () => {
		const { token } = createApiToken(db, alice, 'Claude', NOW);
		const lastUsed = () => listApiTokens(db, alice)[0].lastUsedAt;

		resolveApiToken(db, token, NOW + 10);
		expect(lastUsed()).toBe(NOW + 10);
		resolveApiToken(db, token, NOW + 100);
		expect(lastUsed()).toBe(NOW + 10);
		resolveApiToken(db, token, NOW + 400);
		expect(lastUsed()).toBe(NOW + 400);
	});
});

describe('parseBearer', () => {
	it.each([
		[null, { kind: 'none' }],
		['', { kind: 'none' }],
		['Bearer abc', { kind: 'token', token: 'abc' }],
		['bearer  abc ', { kind: 'token', token: 'abc' }],
		['Basic abc', { kind: 'malformed' }],
		['Bearer', { kind: 'malformed' }],
		['Bearer a b', { kind: 'malformed' }]
	])('%j', (header, expected) => {
		expect(parseBearer(header)).toEqual(expected);
	});
});
