import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { finishRegistration, relyingPartyFor } from '$lib/server/auth/webauthn';
import { getDb } from '$lib/server/db';

export const POST: RequestHandler = async ({ locals, request, url }) => {
	if (!locals.user) error(401, 'Sign in first.');

	const body = (await request.json()) as {
		challengeId?: string;
		name?: string;
		response?: unknown;
	};
	if (!body.challengeId || !body.response) error(400, 'Malformed request.');

	const result = await finishRegistration(
		getDb(),
		locals.user.id,
		body.challengeId,
		// The library validates the shape; this cast only satisfies the compiler.
		body.response as never,
		relyingPartyFor(url),
		body.name ?? null
	);

	if (!result.ok) return json({ ok: false, message: result.reason }, { status: 400 });
	return json({ ok: true });
};
