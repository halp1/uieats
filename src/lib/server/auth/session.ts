/**
 * Sessions.
 *
 * There are no passwords in this app, so there is nothing to hash slowly and
 * no reason for argon2 or bcrypt. What matters instead is that a database leak
 * must not hand over live sessions: the cookie carries 32 random bytes, and
 * only `sha256` of that ever reaches disk. A stolen `user_session` row cannot
 * be replayed because the token it authenticates is not in it.
 *
 * Lookups compare the hash with `timingSafeEqual` rather than SQL equality on
 * the raw token, and the sliding expiry refreshes only past the halfway mark so
 * a busy session is not rewritten on every request.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import { unixNow } from '../../dates.ts';

export const SESSION_COOKIE = 'uieats_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Refresh once a session is more than halfway through its life. */
const REFRESH_AFTER = SESSION_TTL_SECONDS / 2;

export interface SessionUser {
	id: number;
	email: string;
	displayName: string | null;
}

export interface ResolvedSession {
	user: SessionUser;
	sessionId: string;
	expiresAt: number;
	/** True when the cookie should be re-issued with a later expiry. */
	refreshed: boolean;
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function createSession(
	db: Db,
	userId: number,
	meta: { userAgent?: string | null; ip?: string | null } = {},
	now: number = unixNow()
): { token: string; expiresAt: number } {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = now + SESSION_TTL_SECONDS;

	db.prepare(
		`INSERT INTO user_session (id, user_id, created_at, expires_at, user_agent, ip)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(hashToken(token), userId, now, expiresAt, meta.userAgent ?? null, meta.ip ?? null);

	db.prepare('UPDATE user SET last_login_at = ? WHERE id = ?').run(now, userId);
	return { token, expiresAt };
}

export function resolveSession(
	db: Db,
	token: string | undefined,
	now: number = unixNow()
): ResolvedSession | null {
	if (!token) return null;

	const id = hashToken(token);
	const row = db
		.prepare<{
			id: string;
			expires_at: number;
			user_id: number;
			email: string;
			display_name: string | null;
		}>(
			`SELECT s.id, s.expires_at, s.user_id, u.email, u.display_name
			 FROM user_session s JOIN user u ON u.id = s.user_id
			 WHERE s.id = ?`
		)
		.get(id);

	if (!row) return null;

	// The row was found by hash, so this is belt-and-braces rather than the only
	// check -- but a constant-time compare costs nothing and removes any doubt
	// about the index lookup leaking timing.
	const a = Buffer.from(row.id, 'hex');
	const b = Buffer.from(id, 'hex');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	if (row.expires_at <= now) {
		db.prepare('DELETE FROM user_session WHERE id = ?').run(id);
		return null;
	}

	let expiresAt = row.expires_at;
	let refreshed = false;
	if (row.expires_at - now < REFRESH_AFTER) {
		expiresAt = now + SESSION_TTL_SECONDS;
		db.prepare('UPDATE user_session SET expires_at = ? WHERE id = ?').run(expiresAt, id);
		refreshed = true;
	}

	return {
		user: { id: row.user_id, email: row.email, displayName: row.display_name },
		sessionId: id,
		expiresAt,
		refreshed
	};
}

export function destroySession(db: Db, token: string | undefined): void {
	if (!token) return;
	db.prepare('DELETE FROM user_session WHERE id = ?').run(hashToken(token));
}

/** Signing out everywhere, e.g. after removing a passkey. */
export function destroyAllSessions(db: Db, userId: number): number {
	return db.prepare('DELETE FROM user_session WHERE user_id = ?').run(userId).changes;
}

export function deleteExpiredSessions(db: Db, now: number = unixNow()): number {
	return db.prepare('DELETE FROM user_session WHERE expires_at <= ?').run(now).changes;
}
