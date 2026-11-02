/**
 * The OAuth consent page.
 *
 * Signing in reuses the site's own login: an anonymous visitor goes to
 * /auth/login with this exact URL as `next`, and comes back here afterwards.
 *
 * The approve and deny actions re-validate every parameter from the form
 * rather than trusting what the page was rendered with. They are ordinary
 * same-origin form posts, so the CSRF check in hooks.server.ts covers them: a
 * cross-site page cannot approve on a signed-in visitor's behalf.
 */
import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import {
	checkAuthorizeRequest,
	issueCode,
	readAuthorizeParams,
	withQuery,
	type AuthorizeCheck
} from '$lib/server/auth/oauth';

function resolve(check: AuthorizeCheck, state: string | null) {
	if (check.kind === 'fatal') error(400, check.message);
	if (check.kind === 'redirect-error') {
		redirect(
			303,
			withQuery(check.redirectUri, {
				error: check.error,
				error_description: check.description,
				state
			})
		);
	}
	return check;
}

export const load: PageServerLoad = ({ url, locals }) => {
	const params = readAuthorizeParams(url.searchParams);
	const check = resolve(checkAuthorizeRequest(getDb(), params), params.state);

	if (!locals.user) {
		redirect(303, `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}

	return {
		user: locals.user,
		app: {
			name: check.client.name,
			returnsTo: new URL(check.redirectUri).host
		},
		// Echoed into hidden fields so the actions can re-validate them.
		params: {
			response_type: params.responseType,
			client_id: params.clientId,
			redirect_uri: check.redirectUri,
			code_challenge: params.codeChallenge,
			code_challenge_method: params.codeChallengeMethod,
			scope: params.scope,
			state: params.state
		}
	};
};

async function decide(request: Request, approve: boolean, userId: number | undefined) {
	const params = readAuthorizeParams(await request.formData());
	const check = resolve(checkAuthorizeRequest(getDb(), params), params.state);
	if (userId === undefined) error(401, 'Sign in first.');

	if (!approve) {
		redirect(
			303,
			withQuery(check.redirectUri, {
				error: 'access_denied',
				error_description: 'The user declined.',
				state: params.state
			})
		);
	}

	const code = issueCode(getDb(), {
		clientId: check.client.id,
		userId,
		redirectUri: check.redirectUri,
		codeChallenge: check.codeChallenge,
		scope: check.scope
	});
	redirect(303, withQuery(check.redirectUri, { code, state: params.state }));
}

export const actions: Actions = {
	approve: ({ request, locals }) => decide(request, true, locals.user?.id),
	deny: ({ request, locals }) => decide(request, false, locals.user?.id)
};
