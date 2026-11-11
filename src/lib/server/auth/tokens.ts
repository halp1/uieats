/**
 * Personal access tokens for the MCP endpoint.
 *
 * Shaped like `session.ts` on purpose: 32 random bytes, only the sha256 on
 * disk, a constant-time compare after the indexed lookup. The differences are
 * that a token has no expiry (it is revoked, not timed out) and carries a
 * fixed prefix, so a pasted session cookie or a typo can be rejected without
 * a database read, and a token found in a log is recognisable as one of ours.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import { unixNow } from '../../dates.ts';
import type { SessionUser } from './session.ts';

export const TOKEN_PREFIX = 'uieats_pat_';
export const MAX_TOKENS = 10;
export const MAX_TOKEN_NAME = 40;
/** `last_used_at` is a hint for the list UI, not an audit log. */
const TOUCH_AFTER_SECONDS = 300;

export class TokenError extends Error {}

export interface ApiTokenInfo {
	id: number;
	name: string;
	hint: string;
	createdAt: number;
	lastUsedAt: number | null;
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function createApiToken(
	db: Db,
	userId: number,
	rawName: string,
	now: number = unixNow()
): { id: number; token: string } {
	const name = rawName.replace(/\s+/g, ' ').trim();
	if (name === '') throw new TokenError('Give the token a name.');
	if (name.length > MAX_TOKEN_NAME) {
		throw new TokenError(`Keep the name under ${MAX_TOKEN_NAME} characters.`);
	}

	const count = db
		.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM api_token WHERE user_id = ?')
		.get(userId)!.c;
	if (count >= MAX_TOKENS) {
		throw new TokenError(`That is the limit of ${MAX_TOKENS}. Revoke one first.`);
	}

	const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
	const id = db
		.prepare(
			`INSERT INTO api_token (user_id, name, token_hash, hint, created_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(userId, name, hashToken(token), token.slice(-4), now).lastInsertRowid;

	return { id, token };
}

export function resolveApiToken(
	db: Db,
	raw: string | undefined | null,
	now: number = unixNow()
): SessionUser | null {
	if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;

	const hash = hashToken(raw);
	const row = db
		.prepare<{
			id: number;
			token_hash: string;
			last_used_at: number | null;
			user_id: number;
			email: string;
			display_name: string | null;
		}>(
			`SELECT t.id, t.token_hash, t.last_used_at, t.user_id, u.email, u.display_name
			 FROM api_token t JOIN user u ON u.id = t.user_id
			 WHERE t.token_hash = ?`
		)
		.get(hash);
	if (!row) return null;

	const a = Buffer.from(row.token_hash, 'hex');
	const b = Buffer.from(hash, 'hex');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	if (row.last_used_at === null || now - row.last_used_at >= TOUCH_AFTER_SECONDS) {
		db.prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(now, row.id);
	}

	return { id: row.user_id, email: row.email, displayName: row.display_name };
}

export function listApiTokens(db: Db, userId: number): ApiTokenInfo[] {
	return db
		.prepare<{
			id: number;
			name: string;
			hint: string;
			created_at: number;
			last_used_at: number | null;
		}>(
			`SELECT id, name, hint, created_at, last_used_at FROM api_token
			 WHERE user_id = ? ORDER BY created_at DESC, id DESC`
		)
		.all(userId)
		.map((r) => ({
			id: r.id,
			name: r.name,
			hint: r.hint,
			createdAt: r.created_at,
			lastUsedAt: r.last_used_at
		}));
}

/** Scoped to the user in SQL, so a guessed id cannot revoke anyone else's. */
export function revokeApiToken(db: Db, userId: number, id: number): boolean {
	return (
		db.prepare('DELETE FROM api_token WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
	);
}

export type BearerHeader =
	{ kind: 'none' } | { kind: 'token'; token: string } | { kind: 'malformed' };

export function parseBearer(header: string | null | undefined): BearerHeader {
	if (header === null || header === undefined || header.trim() === '') return { kind: 'none' };
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
	return match ? { kind: 'token', token: match[1] } : { kind: 'malformed' };
}
