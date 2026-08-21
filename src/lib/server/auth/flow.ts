/**
 * Cookies that carry state between the two halves of the sign-in flow.
 *
 * The address goes in a short-lived HttpOnly cookie rather than the URL. In a
 * query string it would land in browser history, in any proxy or server log,
 * and in the `Referer` of every asset the verify page loads -- a lasting record
 * of who tried to sign in, in exchange for nothing.
 *
 * `next` is validated as a same-site path before it is stored: an unchecked
 * redirect target is an open redirect, and a sign-in page is exactly where one
 * is most useful to an attacker.
 */
import type { Cookies } from '@sveltejs/kit';
import { CODE_TTL_SECONDS } from './codes.ts';

export const PENDING_EMAIL_COOKIE = 'uieats_pending_email';
export const NEXT_COOKIE = 'uieats_next';

interface CookieOptions {
	secure: boolean;
}

export function setPendingEmail(cookies: Cookies, email: string, options: CookieOptions): void {
	cookies.set(PENDING_EMAIL_COOKIE, email, {
		path: '/auth',
		httpOnly: true,
		sameSite: 'lax',
		secure: options.secure,
		// Outlives the code by a minute, so an expiring code produces "that code
		// expired" rather than a confusing "start again".
		maxAge: CODE_TTL_SECONDS + 60
	});
}

export function getPendingEmail(cookies: Cookies): string | undefined {
	return cookies.get(PENDING_EMAIL_COOKIE);
}

export function clearPendingEmail(cookies: Cookies): void {
	cookies.delete(PENDING_EMAIL_COOKIE, { path: '/auth' });
}

/**
 * A redirect target is only accepted if it is a plain same-site path.
 *
 * Rejects anything absolute, protocol-relative (`//evil.test`), or carrying a
 * backslash, which some clients normalise into a slash.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
	if (!raw) return null;
	if (!raw.startsWith('/')) return null;
	if (raw.startsWith('//') || raw.includes('\\')) return null;
	if (raw.startsWith('/auth')) return null; // no loops back into sign-in
	return raw;
}

export function setNext(cookies: Cookies, next: string, options: CookieOptions): void {
	cookies.set(NEXT_COOKIE, next, {
		path: '/auth',
		httpOnly: true,
		sameSite: 'lax',
		secure: options.secure,
		maxAge: CODE_TTL_SECONDS + 60
	});
}

export function takeNext(cookies: Cookies): string {
	const stored = safeNextPath(cookies.get(NEXT_COOKIE));
	cookies.delete(NEXT_COOKIE, { path: '/auth' });
	return stored ?? '/';
}
