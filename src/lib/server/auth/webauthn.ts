/**
 * Passkeys.
 *
 * @simplewebauthn/server does the cryptography. Hand-rolling COSE key parsing,
 * attestation verification and signature counter handling would be the single
 * most likely place in this codebase to write a subtle, silent security bug,
 * and there is nothing to gain from it.
 *
 * What is ours to get right:
 *   * A challenge is single-use, short-lived, and consumed inside the same
 *     transaction that checks it -- a replayable challenge defeats the whole
 *     protocol.
 *   * The relying-party id must match the actual host. Guessing it wrong makes
 *     credentials silently unusable on the real domain.
 *   * Registration requires an existing session; a passkey is added to an
 *     account, never used to create one. Sign-up stays email-only, which keeps
 *     the @illinois.edu rule in one place.
 */
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import { unixNow } from '../../dates.ts';

const CHALLENGE_TTL_SECONDS = 5 * 60;
export const RP_NAME = 'uieats';

export interface RelyingParty {
	id: string;
	origin: string;
}

/**
 * The relying party, derived from the request's own URL.
 *
 * Deriving it rather than configuring it means localhost, a preview deploy and
 * production each work without a per-environment setting to get wrong -- and
 * getting it wrong is not a visible error, it is credentials that stop working.
 */
export function relyingPartyFor(url: URL): RelyingParty {
	return { id: url.hostname, origin: url.origin };
}

function storeChallenge(
	db: Db,
	challenge: string,
	kind: 'registration' | 'authentication',
	userId: number | null,
	now: number
): string {
	const id = randomBytes(16).toString('base64url');
	db.prepare(
		'INSERT INTO webauthn_challenge (id, user_id, challenge, kind, expires_at) VALUES (?, ?, ?, ?, ?)'
	).run(id, userId, challenge, kind, now + CHALLENGE_TTL_SECONDS);
	return id;
}

/** Reads and DELETES a challenge in one transaction, so it cannot be replayed. */
function consumeChallenge(
	db: Db,
	id: string,
	kind: 'registration' | 'authentication',
	now: number
): { challenge: string; userId: number | null } | null {
	return db.transaction(() => {
		const row = db
			.prepare<{ challenge: string; user_id: number | null; expires_at: number }>(
				'SELECT challenge, user_id, expires_at FROM webauthn_challenge WHERE id = ? AND kind = ?'
			)
			.get(id, kind);

		if (!row) return null;
		db.prepare('DELETE FROM webauthn_challenge WHERE id = ?').run(id);
		if (row.expires_at <= now) return null;

		return { challenge: row.challenge, userId: row.user_id };
	});
}

interface CredentialRow {
	id: string;
	public_key: Uint8Array;
	counter: number;
	transports: string | null;
	user_id: number;
}

export async function startRegistration(
	db: Db,
	user: { id: number; email: string },
	rp: RelyingParty,
	now: number = unixNow()
) {
	const existing = db
		.prepare<{ id: string; transports: string | null }>(
			'SELECT id, transports FROM webauthn_credential WHERE user_id = ?'
		)
		.all(user.id);

	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: rp.id,
		// The account id, not the email: a user handle is stored on the
		// authenticator forever and should not carry an address that may change.
		userID: new TextEncoder().encode(String(user.id)),
		userName: user.email,
		attestationType: 'none',
		// Stops a user registering the same authenticator twice and then
		// wondering which of two identical entries to delete.
		excludeCredentials: existing.map((c) => ({
			id: c.id,
			transports: c.transports ? (JSON.parse(c.transports) as never) : undefined
		})),
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'preferred'
		}
	});

	const challengeId = storeChallenge(db, options.challenge, 'registration', user.id, now);
	return { options, challengeId };
}

export async function finishRegistration(
	db: Db,
	userId: number,
	challengeId: string,
	response: RegistrationResponseJSON,
	rp: RelyingParty,
	name: string | null,
	now: number = unixNow()
): Promise<{ ok: true; credentialId: string } | { ok: false; reason: string }> {
	const pending = consumeChallenge(db, challengeId, 'registration', now);
	if (!pending) return { ok: false, reason: 'That request expired. Start again.' };
	// A challenge issued for one account must never register a key on another.
	if (pending.userId !== userId)
		return { ok: false, reason: 'That request was not for this account.' };

	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: pending.challenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id
		});
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'Could not verify the passkey.'
		};
	}

	if (!verification.verified || !verification.registrationInfo) {
		return { ok: false, reason: 'That passkey could not be verified.' };
	}

	const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

	db.prepare(
		`INSERT INTO webauthn_credential
		   (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		credential.id,
		userId,
		credential.publicKey,
		credential.counter,
		credential.transports ? JSON.stringify(credential.transports) : null,
		credentialDeviceType,
		credentialBackedUp ? 1 : 0,
		name?.trim() || null,
		now
	);

	return { ok: true, credentialId: credential.id };
}

export async function startAuthentication(db: Db, rp: RelyingParty, now: number = unixNow()) {
	const options = await generateAuthenticationOptions({
		rpID: rp.id,
		// No allowCredentials: this is a discoverable-credential login, so the
		// user picks their passkey and we learn who they are from it. Listing
		// credentials would first require knowing the account, which would mean
		// asking for an email before a flow whose whole point is not needing one.
		userVerification: 'preferred'
	});

	const challengeId = storeChallenge(db, options.challenge, 'authentication', null, now);
	return { options, challengeId };
}

export async function finishAuthentication(
	db: Db,
	challengeId: string,
	response: AuthenticationResponseJSON,
	rp: RelyingParty,
	now: number = unixNow()
): Promise<{ ok: true; userId: number } | { ok: false; reason: string }> {
	const pending = consumeChallenge(db, challengeId, 'authentication', now);
	if (!pending) return { ok: false, reason: 'That request expired. Start again.' };

	const row = db
		.prepare<CredentialRow>(
			'SELECT id, public_key, counter, transports, user_id FROM webauthn_credential WHERE id = ?'
		)
		.get(response.id);
	if (!row) return { ok: false, reason: 'That passkey is not registered here.' };

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: pending.challenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			credential: {
				id: row.id,
				// Copied into a fresh buffer: node:sqlite hands back a view whose
				// backing store the type system will not narrow to ArrayBuffer.
				publicKey: new Uint8Array(row.public_key),
				counter: row.counter,
				transports: row.transports ? (JSON.parse(row.transports) as never) : undefined
			}
		});
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'Could not verify the passkey.'
		};
	}

	if (!verification.verified) return { ok: false, reason: 'That passkey could not be verified.' };

	// The signature counter must move forward. A counter that goes backwards is
	// the documented signal of a cloned authenticator.
	db.prepare('UPDATE webauthn_credential SET counter = ?, last_used_at = ? WHERE id = ?').run(
		verification.authenticationInfo.newCounter,
		now,
		row.id
	);

	return { ok: true, userId: row.user_id };
}

export interface StoredCredential {
	id: string;
	name: string | null;
	deviceType: string | null;
	backedUp: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export function listCredentials(db: Db, userId: number): StoredCredential[] {
	return db
		.prepare<{
			id: string;
			name: string | null;
			device_type: string | null;
			backed_up: number;
			created_at: number;
			last_used_at: number | null;
		}>(
			`SELECT id, name, device_type, backed_up, created_at, last_used_at
			 FROM webauthn_credential WHERE user_id = ? ORDER BY created_at`
		)
		.all(userId)
		.map((row) => ({
			id: row.id,
			name: row.name,
			deviceType: row.device_type,
			backedUp: row.backed_up === 1,
			createdAt: row.created_at,
			lastUsedAt: row.last_used_at
		}));
}

export function deleteCredential(db: Db, userId: number, credentialId: string): boolean {
	// Scoped to the user, so a guessed credential id cannot remove someone
	// else's passkey.
	return (
		db
			.prepare('DELETE FROM webauthn_credential WHERE id = ? AND user_id = ?')
			.run(credentialId, userId).changes > 0
	);
}

export function deleteExpiredChallenges(db: Db, now: number = unixNow()): number {
	return db.prepare('DELETE FROM webauthn_challenge WHERE expires_at <= ?').run(now).changes;
}
