import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { SESSION_COOKIE, destroySession } from '$lib/server/auth/session';
import { getDb } from '$lib/server/db';

/**
 * Signing out is a POST, always.
 *
 * A GET /auth/logout can be triggered by any image tag on any page, so a
 * link-shaped sign-out is a one-click denial of service on someone else's
 * session. Landing here without a POST just shows the button.
 */
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/');
	return { email: locals.user.email };
};

export const actions: Actions = {
	default: async ({ cookies, locals }) => {
		// Revoke the row as well as the cookie: clearing only the cookie leaves a
		// live session for anyone who already copied the token.
		destroySession(getDb(), locals.sessionToken);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		locals.user = null;
		redirect(303, '/');
	}
};
