/**
 * SvelteKit's built-in cross-site form check, moved into the app so it can
 * have exceptions.
 *
 * The built-in check is all or nothing, and the OAuth token, registration and
 * revocation endpoints must accept form posts from other origins: that is how
 * an OAuth client talks to them. They authenticate by client secret or PKCE
 * and never read a cookie, so a forged cross-site post gains nothing there.
 * Every other route keeps exactly the protection it had before.
 */
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

/** Exact paths. Not prefixes: /oauth/authorize is a cookie-authenticated form. */
export const CROSS_SITE_FORM_PATHS = new Set(['/oauth/token', '/oauth/register', '/oauth/revoke']);

export function isForbiddenCrossSiteForm(request: Request, url: URL): boolean {
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
	const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!FORM_TYPES.includes(type)) return false;
	if (request.headers.get('origin') === url.origin) return false;
	return !CROSS_SITE_FORM_PATHS.has(url.pathname);
}
