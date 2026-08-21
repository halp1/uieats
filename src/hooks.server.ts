/**
 * Auth only.
 *
 * The database handle is deliberately NOT put on `event.locals`: it is a
 * synchronous module singleton, and handing each request its own would just
 * multiply prepared-statement caches for no benefit. Hooks resolve who the
 * visitor is and nothing else.
 */
import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, resolveSession } from '$lib/server/auth/session';
import { logStartupHealth } from '$lib/server/health';

// Once, at boot. Stale menu data is the failure mode a user cannot detect: the
// pages render perfectly, they are just describing last Tuesday.
logStartupHealth(getDb());

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const session = resolveSession(getDb(), token);

	event.locals.user = session?.user ?? null;
	event.locals.sessionToken = token;

	// Sliding expiry: the row was already extended, so re-issue the cookie to
	// match. Without this the cookie would expire while the session lived on.
	if (session?.refreshed) {
		event.cookies.set(SESSION_COOKIE, token!, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: !dev,
			expires: new Date(session.expiresAt * 1000)
		});
	}

	const response = await resolve(event);

	// uieats mirrors university menu data for students to use, not for search
	// engines to index. Upstream serves noindex; honouring that here is cheap
	// and it is the polite half of an unauthenticated scrape.
	response.headers.set('X-Robots-Tag', 'noindex, nofollow');
	return response;
};
