import type { SessionUser } from '$lib/server/auth/session';

declare global {
	namespace App {
		interface Locals {
			/** null for anonymous visitors, who see menus but no allergen chips. */
			user: SessionUser | null;
			/** The raw session cookie, so a sign-out can revoke exactly this one. */
			sessionToken: string | undefined;
		}
	}
}

export {};
