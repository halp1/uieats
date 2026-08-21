/**
 * Sessions.
 *
 * The property that matters most: the raw token never reaches disk, so a
 * database leak does not hand over live sessions. The rest is expiry and
 * revocation behaving exactly as the cookie promises.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	SESSION_TTL_SECONDS,
	createSession,
	deleteExpiredSessions,
	destroyAllSessions,
	destroySession,
	resolveSession
} from '../../src/lib/server/auth/session.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';

const NOW = 1_760_000_000;

let db: Db;
let userId: number;

beforeEach(() => {
	db = createMemoryDb();
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', NOW).lastInsertRowid;
});

describe('createSession', () => {
	it('never stores the token itself', () => {
		const { token } = createSession(db, userId, {}, NOW);
		const row = db.prepare<{ id: string }>('SELECT id FROM user_session').get()!;

		expect(row.id).not.toBe(token);
		expect(row.id).not.toContain(token);
		expect(row.id).toHaveLength(64); // hex sha256
	});

	it('issues a token long enough to be unguessable', () => {
		const { token } = createSession(db, userId, {}, NOW);
		// 32 random bytes, base64url encoded.
		expect(token.length).toBeGreaterThanOrEqual(42);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('issues a distinct token every time', () => {
		const a = createSession(db, userId, {}, NOW).token;
		const b = createSession(db, userId, {}, NOW).token;
		expect(a).not.toBe(b);
	});

	it('records the sign-in on the user', () => {
		createSession(db, userId, {}, NOW);
		expect(
			db.prepare<{ last_login_at: number | null }>('SELECT last_login_at FROM user').get()!
				.last_login_at
		).toBe(NOW);
	});
});

describe('resolveSession', () => {
	it('resolves a live session to its user', () => {
		const { token } = createSession(db, userId, {}, NOW);
		const resolved = resolveSession(db, token, NOW + 60);

		expect(resolved?.user).toMatchObject({ id: userId, email: 'student@illinois.edu' });
		expect(resolved?.refreshed).toBe(false);
	});

	it('rejects an unknown token', () => {
		createSession(db, userId, {}, NOW);
		expect(resolveSession(db, 'not-a-real-token', NOW)).toBeNull();
	});

	it('rejects a missing cookie without touching the database', () => {
		expect(resolveSession(db, undefined, NOW)).toBeNull();
	});

	it('rejects an expired session and cleans the row up', () => {
		const { token } = createSession(db, userId, {}, NOW);
		expect(resolveSession(db, token, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user_session').get()!.c).toBe(0);
	});

	it('slides the expiry once past the halfway mark', () => {
		const { token } = createSession(db, userId, {}, NOW);
		const at = NOW + SESSION_TTL_SECONDS / 2 + 10;
		const resolved = resolveSession(db, token, at);

		expect(resolved?.refreshed).toBe(true);
		expect(resolved?.expiresAt).toBe(at + SESSION_TTL_SECONDS);
	});

	it('does not rewrite the row on every request', () => {
		// A busy session would otherwise mean a write per page view.
		const { token } = createSession(db, userId, {}, NOW);
		expect(resolveSession(db, token, NOW + 60)?.refreshed).toBe(false);
		expect(
			db.prepare<{ expires_at: number }>('SELECT expires_at FROM user_session').get()!.expires_at
		).toBe(NOW + SESSION_TTL_SECONDS);
	});
});

describe('revocation', () => {
	it('destroySession revokes the row, not just the cookie', () => {
		const { token } = createSession(db, userId, {}, NOW);
		destroySession(db, token);

		expect(resolveSession(db, token, NOW + 1)).toBeNull();
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user_session').get()!.c).toBe(0);
	});

	it('destroySession tolerates an absent cookie', () => {
		expect(() => destroySession(db, undefined)).not.toThrow();
	});

	it('destroyAllSessions signs out every device', () => {
		const a = createSession(db, userId, {}, NOW).token;
		const b = createSession(db, userId, {}, NOW).token;

		expect(destroyAllSessions(db, userId)).toBe(2);
		expect(resolveSession(db, a, NOW + 1)).toBeNull();
		expect(resolveSession(db, b, NOW + 1)).toBeNull();
	});

	it('deleting the user cascades their sessions away', () => {
		const { token } = createSession(db, userId, {}, NOW);
		db.prepare('DELETE FROM user WHERE id = ?').run(userId);
		expect(resolveSession(db, token, NOW + 1)).toBeNull();
	});

	it('deleteExpiredSessions only takes the dead ones', () => {
		createSession(db, userId, {}, NOW);
		createSession(db, userId, {}, NOW + SESSION_TTL_SECONDS);

		expect(deleteExpiredSessions(db, NOW + SESSION_TTL_SECONDS + 1)).toBe(1);
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user_session').get()!.c).toBe(1);
	});
});
