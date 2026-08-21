/**
 * Who may hold an account.
 *
 * Signup is restricted to `@illinois.edu`, which is a decision about scope
 * rather than security: this app mirrors one university's dining data and has
 * nothing to offer anyone else.
 *
 * The restriction is enforced at request-code time, but the RESPONSE never says
 * so. A form that answers "that address is not eligible" for one input and
 * "check your inbox" for another is an oracle for which addresses exist and
 * which domain a person belongs to. Both answers here are identical.
 */

const ALLOWED_DOMAINS = ['illinois.edu'];

export function normalizeEmail(input: string): string {
	return input.trim().toLowerCase();
}

/** Shape only. Deliberately permissive: the confirmation code is the real test. */
export function looksLikeEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) && email.length <= 254;
}

export function isEligibleEmail(email: string): boolean {
	const normalized = normalizeEmail(email);
	if (!looksLikeEmail(normalized)) return false;

	const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
	// Subdomains count: `@ad.uillinois.edu` is not in scope, but
	// `@students.illinois.edu` is the same institution.
	return ALLOWED_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

/** For UI copy, so the requirement is stated before someone types. */
export const ELIGIBLE_DOMAIN_LABEL = '@illinois.edu';
