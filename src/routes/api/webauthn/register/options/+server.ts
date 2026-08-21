/** Registration options. Requires a session: a passkey is added to an account. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { relyingPartyFor, startRegistration } from '$lib/server/auth/webauthn';
import { getDb } from '$lib/server/db';

export const POST: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Sign in first.');

	const { options, challengeId } = await startRegistration(
		getDb(),
		locals.user,
		relyingPartyFor(url)
	);
	return json({ options, challengeId });
};
