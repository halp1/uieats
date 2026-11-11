/**
 * Where the planner's body info lives: the database for a signed-in user, a
 * cookie for anyone else.
 *
 * The planner is useful without an account -- there is nothing about planning
 * a plate that needs one -- so refusing to remember a weight until someone
 * signs in would be friction for no reason. The cookie is httpOnly and holds
 * only what the form asked for; a signed-in user's copy is in `body_profile`
 * so it follows them between devices.
 *
 * A signed-in user with no stored row falls back to the cookie, so filling the
 * form before signing in is not lost the moment they do.
 */
import type { Cookies } from '@sveltejs/kit';
import { isBodyProfile, type BodyProfile } from '../planner/targets.ts';
import type { Db } from './db/driver.ts';
import { deleteBodyProfile, getBodyProfile, saveBodyProfile } from './queries/planner.ts';

const COOKIE = 'uieats_body';
const YEAR = 60 * 60 * 24 * 365;

function fromCookie(cookies: Cookies): BodyProfile | null {
	const raw = cookies.get(COOKIE);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isBodyProfile(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function loadBodyProfile(
	db: Db,
	user: { id: number } | null,
	cookies: Cookies
): BodyProfile | null {
	if (user) return getBodyProfile(db, user.id) ?? fromCookie(cookies);
	return fromCookie(cookies);
}

export function storeBodyProfile(
	db: Db,
	user: { id: number } | null,
	cookies: Cookies,
	profile: BodyProfile
): void {
	if (user) {
		saveBodyProfile(db, user.id, profile);
		// The database copy is now the one that counts; a stale cookie left
		// behind would resurface the old numbers after a sign-out.
		cookies.delete(COOKIE, { path: '/' });
		return;
	}
	cookies.set(COOKIE, JSON.stringify(profile), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: YEAR
	});
}

export function clearBodyProfile(db: Db, user: { id: number } | null, cookies: Cookies): void {
	if (user) deleteBodyProfile(db, user.id);
	cookies.delete(COOKIE, { path: '/' });
}
