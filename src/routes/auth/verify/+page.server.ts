import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { MAX_ATTEMPTS, verifyLoginCode } from '$lib/server/auth/codes';
import { clearPendingEmail, getPendingEmail, takeNext } from '$lib/server/auth/flow';
import { SESSION_COOKIE, createSession } from '$lib/server/auth/session';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = ({ cookies, locals }) => {
	if (locals.user) redirect(303, '/');

	const email = getPendingEmail(cookies);
	// No pending address means someone opened this page directly, or the cookie
	// aged out. Sending them back to the start is the only useful move.
	if (!email) redirect(303, '/auth/login');

	return { email, maxAttempts: MAX_ATTEMPTS };
};

export const actions: Actions = {
	default: async ({ request, cookies, locals, getClientAddress }) => {
		const email = getPendingEmail(cookies);
		if (!email) redirect(303, '/auth/login');

		const form = await request.formData();
		const code = String(form.get('code') ?? '');

		const db = getDb();
		const result = verifyLoginCode(db, email, code);

		if (result.status === 'invalid') {
			return fail(400, { message: 'That code does not match. Check it and try again.' });
		}
		if (result.status === 'expired') {
			clearPendingEmail(cookies);
			return fail(400, {
				restart: true,
				message: 'That code has expired. Codes last ten minutes — request a new one.'
			});
		}
		if (result.status === 'exhausted') {
			clearPendingEmail(cookies);
			return fail(429, {
				restart: true,
				message: 'Too many wrong attempts on that code. Request a new one to try again.'
			});
		}

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

		clearPendingEmail(cookies);
		locals.user = { id: result.userId, email, displayName: null };

		// A brand-new account has no allergens yet, and the app does nothing
		// useful until it does -- so land there rather than on a menu with no
		// chips on it.
		const next = takeNext(cookies);
		redirect(303, result.isNewAccount ? '/settings/allergens?welcome=1' : next);
	}
};
