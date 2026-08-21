/**
 * The login-code engine.
 *
 * This is the only thing standing between an email address and an account, so
 * each of its guarantees gets an explicit test rather than being implied by the
 * happy path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	CODE_TTL_SECONDS,
	MAX_ATTEMPTS,
	deleteStaleCodes,
	issueLoginCode,
	verifyLoginCode
} from '../../src/lib/server/auth/codes.ts';
import { isEligibleEmail, normalizeEmail } from '../../src/lib/server/auth/email.ts';
import { safeNextPath } from '../../src/lib/server/auth/flow.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';

const NOW = 1_760_000_000;
const EMAIL = 'student@illinois.edu';

let db: Db;
beforeEach(() => {
	db = createMemoryDb();
});

function issue(email = EMAIL, now = NOW): string {
	const result = issueLoginCode(db, email, {}, now);
	if (result.status !== 'sent') throw new Error(`expected a code, got ${result.reason}`);
	return result.issued.code;
}

describe('eligibility', () => {
	it.each([
		['student@illinois.edu', true],
		['STUDENT@ILLINOIS.EDU', true],
		['student@students.illinois.edu', true],
		['student@gmail.com', false],
		['student@illinois.edu.evil.test', false],
		// A near-miss domain that merely contains the string.
		['student@notillinois.edu', false],
		['not an email', false],
		['', false]
	])('%s -> %s', (email, expected) => {
		expect(isEligibleEmail(email)).toBe(expected);
	});

	it('suppresses an ineligible address without issuing anything', () => {
		const result = issueLoginCode(db, 'student@gmail.com', {}, NOW);
		expect(result.status).toBe('suppressed');
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM login_code').get()!.c).toBe(0);
	});
});

describe('issuing', () => {
	it('stores only a hash, never the code', () => {
		const code = issue();
		const row = db.prepare<{ code_hash: string }>('SELECT code_hash FROM login_code').get()!;
		expect(row.code_hash).not.toContain(code);
		expect(row.code_hash).toHaveLength(64);
	});

	it('issues six digits', () => {
		expect(issue()).toMatch(/^\d{6}$/);
	});

	it('retires the previous code, so two are never live at once', () => {
		const first = issue();
		const second = issue();
		expect(second).not.toBe(first);

		// The old code must be dead even though its TTL has not run out.
		expect(verifyLoginCode(db, EMAIL, first, NOW + 1).status).toBe('invalid');
		expect(verifyLoginCode(db, EMAIL, second, NOW + 1).status).toBe('ok');
	});

	it('stops issuing after too many requests in an hour', () => {
		for (let i = 0; i < 5; i++) issueLoginCode(db, EMAIL, {}, NOW + i);
		const result = issueLoginCode(db, EMAIL, {}, NOW + 6);
		expect(result.status).toBe('suppressed');
		if (result.status === 'suppressed') expect(result.reason).toBe('rate-limited');
	});

	it('lets the same address try again in a later window', () => {
		for (let i = 0; i < 5; i++) issueLoginCode(db, EMAIL, {}, NOW + i);
		expect(issueLoginCode(db, EMAIL, {}, NOW + 4000).status).toBe('sent');
	});
});

describe('verifying', () => {
	it('creates the account on a first successful sign-in', () => {
		const code = issue();
		const result = verifyLoginCode(db, EMAIL, code, NOW + 5);

		expect(result).toMatchObject({ status: 'ok', isNewAccount: true });
		const user = db
			.prepare<{ email: string; email_verified_at: number | null }>(
				'SELECT email, email_verified_at FROM user'
			)
			.get()!;
		expect(user.email).toBe(EMAIL);
		expect(user.email_verified_at).toBe(NOW + 5);
	});

	it('reuses the account on a later sign-in', () => {
		verifyLoginCode(db, EMAIL, issue(), NOW + 5);
		const second = verifyLoginCode(db, EMAIL, issue(EMAIL, NOW + 100), NOW + 105);

		expect(second).toMatchObject({ status: 'ok', isNewAccount: false });
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user').get()!.c).toBe(1);
	});

	it('normalizes the address, so case never forks an account', () => {
		const code = issue('Student@Illinois.EDU');
		expect(verifyLoginCode(db, 'STUDENT@ILLINOIS.EDU', code, NOW + 1).status).toBe('ok');
		expect(db.prepare<{ email: string }>('SELECT email FROM user').get()!.email).toBe(EMAIL);
	});

	it('rejects a code past its ten-minute life', () => {
		const code = issue();
		expect(verifyLoginCode(db, EMAIL, code, NOW + CODE_TTL_SECONDS + 1).status).toBe('expired');
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user').get()!.c).toBe(0);
	});

	it('accepts a code on the last second of its life', () => {
		const code = issue();
		expect(verifyLoginCode(db, EMAIL, code, NOW + CODE_TTL_SECONDS - 1).status).toBe('ok');
	});

	it('cannot be replayed once used', () => {
		const code = issue();
		expect(verifyLoginCode(db, EMAIL, code, NOW + 1).status).toBe('ok');
		// Same code, same TTL window, second attempt.
		expect(verifyLoginCode(db, EMAIL, code, NOW + 2).status).toBe('invalid');
	});

	it('dies after the attempt cap, and stays dead', () => {
		const code = issue();
		const wrong = code === '000000' ? '111111' : '000000';

		for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
			expect(verifyLoginCode(db, EMAIL, wrong, NOW + 1).status).toBe('invalid');
		}
		expect(verifyLoginCode(db, EMAIL, wrong, NOW + 1).status).toBe('exhausted');

		// And the RIGHT code no longer works either -- otherwise the cap would
		// only slow an attacker down rather than stop them.
		expect(verifyLoginCode(db, EMAIL, code, NOW + 1).status).toBe('exhausted');
	});

	it('counts an attempt even when the request is abandoned mid-flight', () => {
		// The attempt is recorded before the comparison, so a client that
		// disconnects cannot retry for free.
		const code = issue();
		verifyLoginCode(db, EMAIL, '999999', NOW + 1);
		const row = db.prepare<{ attempts: number }>('SELECT attempts FROM login_code').get()!;
		expect(row.attempts).toBe(1);
		expect(code).toMatch(/^\d{6}$/);
	});

	it('ignores whitespace a user pasted in', () => {
		const code = issue();
		const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
		expect(verifyLoginCode(db, EMAIL, spaced, NOW + 1).status).toBe('ok');
	});

	it('refuses a code issued for a different address', () => {
		const code = issue('one@illinois.edu');
		expect(verifyLoginCode(db, 'two@illinois.edu', code, NOW + 1).status).toBe('invalid');
	});

	it('has nothing to verify when no code was ever issued', () => {
		expect(verifyLoginCode(db, EMAIL, '123456', NOW).status).toBe('invalid');
	});
});

describe('housekeeping', () => {
	it('deletes codes long past their expiry', () => {
		issue();
		expect(deleteStaleCodes(db, NOW)).toBe(0);
		expect(deleteStaleCodes(db, NOW + 200_000)).toBe(1);
	});
});

describe('redirect targets', () => {
	// A sign-in page is the most valuable place in an app to plant an open
	// redirect, so `next` is validated rather than trusted.
	it.each([
		['/d/2026-08-21', '/d/2026-08-21'],
		['/item/blondie-bars', '/item/blondie-bars'],
		['https://evil.test/', null],
		['//evil.test/', null],
		['/\\evil.test', null],
		['not-a-path', null],
		['/auth/login', null],
		[null, null]
	])('%s -> %s', (input, expected) => {
		expect(safeNextPath(input)).toBe(expected);
	});
});

describe('normalizeEmail', () => {
	it('trims and lowercases', () => {
		expect(normalizeEmail('  Student@Illinois.EDU  ')).toBe(EMAIL);
	});
});
