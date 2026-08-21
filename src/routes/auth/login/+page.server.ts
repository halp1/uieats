import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { issueLoginCode } from '$lib/server/auth/codes';
import { isEligibleEmail, normalizeEmail } from '$lib/server/auth/email';
import { safeNextPath, setNext, setPendingEmail } from '$lib/server/auth/flow';
import { getMailer } from '$lib/server/auth/mailer';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeNextPath(url.searchParams.get('next')) ?? '/');
	return { next: safeNextPath(url.searchParams.get('next')) };
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const form = await request.formData();
		const email = normalizeEmail(String(form.get('email') ?? ''));
		const next = safeNextPath(String(form.get('next') ?? ''));

		if (email === '') {
			return fail(400, { message: 'Enter your university email address.' });
		}

		const db = getDb();
		const result = issueLoginCode(db, email, { ip: getClientAddress() });

		if (result.status === 'sent') {
			try {
				await getMailer().sendLoginCode(email, result.issued.code);
			} catch (err) {
				// A failed send must be visible. Silently continuing would leave
				// someone waiting for a code that is never coming.
				console.error('[auth] could not send login code:', err);
				return fail(502, {
					email,
					message: 'The email could not be sent just now. Try again in a moment.'
				});
			}
		}

		// Identical response whether the code was sent, the address is not an
		// @illinois.edu one, or the address has asked too often. Anything else
		// turns this form into a lookup for which addresses exist.
		//
		// Eligibility is still stated up front on the form itself, so an ineligible
		// address is told the rule before typing rather than after.
		setPendingEmail(cookies, email, { secure: !dev });
		if (next) setNext(cookies, next, { secure: !dev });
		redirect(303, '/auth/verify');
	}
};

/** Exported for the test that asserts the two branches are indistinguishable. */
export const _isEligible = isEligibleEmail;
