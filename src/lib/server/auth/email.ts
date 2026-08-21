/**
 * Server-side view of the eligibility rule.
 *
 * The rule itself lives in `$lib/policy` because the sign-in form has to state
 * it before submission, and a component cannot import from `$lib/server`. This
 * module exists so server code has one obvious place to reach for it.
 */
export {
	ELIGIBLE_DOMAINS,
	ELIGIBLE_DOMAIN_LABEL,
	isEligibleEmail,
	looksLikeEmail,
	normalizeEmail
} from '../../policy.ts';
