/**
 * Authentication options.
 *
 * Unauthenticated by design: this is how a signed-out user signs in. No email
 * is asked for, because a discoverable credential already identifies the
 * account -- and asking would leak which addresses have passkeys.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { relyingPartyFor, startAuthentication } from '$lib/server/auth/webauthn';
import { getDb } from '$lib/server/db';

export const POST: RequestHandler = async ({ url }) => {
	const { options, challengeId } = await startAuthentication(getDb(), relyingPartyFor(url));
	return json({ options, challengeId });
};
