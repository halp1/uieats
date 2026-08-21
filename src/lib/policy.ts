/**
 * Who may hold an account.
 *
 * Shared rather than server-only because both sides need it, for different
 * reasons: the server enforces it, and the sign-in form has to STATE it before
 * anyone types. Those two must never disagree, so they read the same constant.
 *
 * Stating it up front is not a nicety. The server's response cannot say whether
 * an address was eligible -- that would make the form a lookup for which
 * addresses exist and which domain a person belongs to -- so the only honest
 * place to mention the rule is before submission.
 */

export const ELIGIBLE_DOMAINS = ['illinois.edu'] as const;

/** For UI copy. */
export const ELIGIBLE_DOMAIN_LABEL = `@${ELIGIBLE_DOMAINS[0]}`;

/** Shape only. Deliberately permissive: the emailed code is the real test. */
export function looksLikeEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) && email.length <= 254;
}

export function normalizeEmail(input: string): string {
	return input.trim().toLowerCase();
}

export function isEligibleEmail(email: string): boolean {
	const normalized = normalizeEmail(email);
	if (!looksLikeEmail(normalized)) return false;

	const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
	// Subdomains count: `@students.illinois.edu` is the same institution. A
	// domain that merely ENDS with the string is not -- hence the leading dot.
	return ELIGIBLE_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}
