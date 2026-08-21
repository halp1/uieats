import { dev } from '$app/environment';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SESSION_COOKIE, createSession } from '$lib/server/auth/session';
import { finishAuthentication, relyingPartyFor } from '$lib/server/auth/webauthn';
import { getDb } from '$lib/server/db';
import { safeNextPath } from '$lib/server/auth/flow';

export const POST: RequestHandler = async ({ request, cookies, url, getClientAddress }) => {
	const body = (await request.json()) as {
		challengeId?: string;
		response?: unknown;
		next?: string;
	};
	if (!body.challengeId || !body.response) error(400, 'Malformed request.');

	const db = getDb();
	const result = await finishAuthentication(
		db,
		body.challengeId,
		body.response as never,
		relyingPartyFor(url)
	);

	if (!result.ok) return json({ ok: false, message: result.reason }, { status: 400 });

	const { token, expiresAt } = createSession(db, result.userId, {
		userAgent: request.headers.get('user-agent'),
		ip: getClientAddress()
	});

	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		expires: new Date(expiresAt * 1000)
	});

	return json({ ok: true, next: safeNextPath(body.next ?? null) ?? '/' });
};
