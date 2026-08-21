/**
 * Email login codes.
 *
 * Signup and sign-in are one flow, so codes are keyed by EMAIL rather than by
 * user: when the code is issued the account may not exist yet, and it is the
 * code itself that decides whether it should.
 *
 * The properties that matter, each with a test:
 *   * 10-minute TTL, and an expired code is never accepted.
 *   * 5 attempts per code, then it is dead -- otherwise six digits is 10^6
 *     guesses against an endpoint that answers instantly.
 *   * Single use. A consumed code cannot be replayed, even inside its TTL.
 *   * Issuing a new code invalidates the previous one, so two live codes for
 *     one address never coexist.
 *   * The code is compared with `timingSafeEqual` on its hash, and only the
 *     hash is stored.
 *
 * `randomInt` rather than `Math.random`: this is a credential.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import { unixNow } from '../../dates.ts';
import { isEligibleEmail, normalizeEmail } from './email.ts';

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;
/** Codes issued per address per window, before we stop sending. */
const MAX_PER_WINDOW = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

function hashCode(id: number, code: string): string {
	// The row id is mixed in so two addresses issued the same six digits do not
	// share a hash, and so a stolen hash cannot be tested against other rows.
	return createHash('sha256').update(`${id}:${code}`).digest('hex');
}

function randomCode(): string {
	// randomInt is uniform over the range; a modulo of random bytes would not be.
	return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

export interface IssuedCode {
	/** The plaintext code. Exists only long enough to be emailed. */
	code: string;
	expiresAt: number;
}

export type IssueResult =
	| { status: 'sent'; issued: IssuedCode }
	/** Not eligible, or rate-limited. The CALLER must respond identically. */
	| { status: 'suppressed'; reason: 'ineligible' | 'rate-limited' };

export function issueLoginCode(
	db: Db,
	rawEmail: string,
	meta: { ip?: string | null } = {},
	now: number = unixNow()
): IssueResult {
	const email = normalizeEmail(rawEmail);
	if (!isEligibleEmail(email)) return { status: 'suppressed', reason: 'ineligible' };

	const recent = db
		.prepare<{ c: number }>(
			'SELECT COUNT(*) AS c FROM login_code WHERE email = ? AND created_at > ?'
		)
		.get(email, now - RATE_WINDOW_SECONDS);
	if ((recent?.c ?? 0) >= MAX_PER_WINDOW) {
		return { status: 'suppressed', reason: 'rate-limited' };
	}

	return db.transaction((): IssueResult => {
		// Retire any live code for this address first. Two valid codes at once
		// doubles the guessing surface and makes "the code I just got" ambiguous.
		db.prepare('UPDATE login_code SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL').run(
			now,
			email
		);

		const code = randomCode();
		const expiresAt = now + CODE_TTL_SECONDS;

		// Insert first to get the id the hash is bound to, then write the hash.
		const id = db
			.prepare(
				`INSERT INTO login_code (email, code_hash, created_at, expires_at, attempts, ip)
				 VALUES (?, '', ?, ?, 0, ?)`
			)
			.run(email, now, expiresAt, meta.ip ?? null).lastInsertRowid;

		db.prepare('UPDATE login_code SET code_hash = ? WHERE id = ?').run(hashCode(id, code), id);

		return { status: 'sent', issued: { code, expiresAt } };
	});
}

export type VerifyResult =
	| { status: 'ok'; userId: number; isNewAccount: boolean }
	| { status: 'invalid' }
	| { status: 'expired' }
	| { status: 'exhausted' };

/**
 * Checks a code and, on success, returns the user -- creating the account if
 * this is a first sign-in.
 *
 * Every failure mode is distinguished for the UI, because they need different
 * instructions ("that code has expired, get another" is actionable in a way
 * that "invalid" is not). None of them reveal whether the address has an
 * account: the code was mailed to it either way.
 */
export function verifyLoginCode(
	db: Db,
	rawEmail: string,
	submitted: string,
	now: number = unixNow()
): VerifyResult {
	const email = normalizeEmail(rawEmail);
	const code = submitted.replace(/\s+/g, '');

	return db.transaction((): VerifyResult => {
		const row = db
			.prepare<{ id: number; code_hash: string; expires_at: number; attempts: number }>(
				`SELECT id, code_hash, expires_at, attempts FROM login_code
				 WHERE email = ? AND consumed_at IS NULL
				 ORDER BY created_at DESC LIMIT 1`
			)
			.get(email);

		if (!row) return { status: 'invalid' };
		if (row.expires_at <= now) return { status: 'expired' };
		if (row.attempts >= MAX_ATTEMPTS) return { status: 'exhausted' };

		// Count the attempt BEFORE comparing. Doing it after would let a client
		// that disconnects mid-request retry for free.
		db.prepare('UPDATE login_code SET attempts = attempts + 1 WHERE id = ?').run(row.id);

		const expected = Buffer.from(row.code_hash, 'hex');
		const actual = Buffer.from(hashCode(row.id, code), 'hex');
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
			return row.attempts + 1 >= MAX_ATTEMPTS ? { status: 'exhausted' } : { status: 'invalid' };
		}

		db.prepare('UPDATE login_code SET consumed_at = ? WHERE id = ?').run(now, row.id);

		const existing = db.prepare<{ id: number }>('SELECT id FROM user WHERE email = ?').get(email);
		if (existing) {
			db.prepare('UPDATE user SET email_verified_at = ? WHERE id = ?').run(now, existing.id);
			return { status: 'ok', userId: existing.id, isNewAccount: false };
		}

		const userId = db
			.prepare('INSERT INTO user (email, email_verified_at, created_at) VALUES (?, ?, ?)')
			.run(email, now, now).lastInsertRowid;

		return { status: 'ok', userId, isNewAccount: true };
	});
}

/** Housekeeping, run from the scrape CLI rather than on a request path. */
export function deleteStaleCodes(db: Db, now: number = unixNow()): number {
	return db.prepare('DELETE FROM login_code WHERE expires_at < ?').run(now - 86_400).changes;
}
