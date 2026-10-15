/**
 * Body info for the planner: height, weight, age, activity, goal.
 *
 * Works signed in or out (see server/body-profile.ts). The unit system is a
 * query param while editing, so switching between pounds and kilograms is a
 * link rather than client JavaScript, and is saved with the profile so the
 * form opens the way it was last filled in.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { clearBodyProfile, loadBodyProfile, storeBodyProfile } from '$lib/server/body-profile';
import { computeTargets, displayMeasurements, parseProfileForm } from '$lib/planner/targets';

/** Only ever back into the planner: an open redirect is not a feature. */
function safeNext(raw: string | null): string {
	return raw && raw.startsWith('/plan') && !raw.startsWith('//') ? raw : '/plan';
}

export const load: PageServerLoad = ({ locals, cookies, url }) => {
	const profile = loadBodyProfile(getDb(), locals.user, cookies);
	const requested = url.searchParams.get('units');
	const units =
		requested === 'metric' || requested === 'imperial' ? requested : (profile?.units ?? 'imperial');

	return {
		profile,
		units,
		measurements: profile ? displayMeasurements(profile) : null,
		targets: profile ? computeTargets(profile) : null,
		next: safeNext(url.searchParams.get('next')),
		signedIn: locals.user !== null
	};
};

export const actions: Actions = {
	save: async ({ request, locals, cookies, url }) => {
		const form = await request.formData();
		const parsed = parseProfileForm(form);
		if ('errors' in parsed) {
			return fail(400, { errors: parsed.errors, values: Object.fromEntries(form) });
		}
		storeBodyProfile(getDb(), locals.user, cookies, parsed.profile);
		redirect(303, safeNext(url.searchParams.get('next')));
	},

	clear: ({ locals, cookies }) => {
		clearBodyProfile(getDb(), locals.user, cookies);
		return { cleared: true };
	}
};
