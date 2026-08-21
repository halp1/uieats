import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { unixNow } from '$lib/dates';
import { getDb } from '$lib/server/db';
import { getAllergenTree, getCustomAllergens, getDietTags } from '$lib/server/queries/allergens';

/** Enough for a real set of allergies, few enough that the list stays usable. */
const MAX_CUSTOM = 20;
const MAX_LABEL = 40;
/**
 * Two-letter terms match inside half the words in an ingredient list, and a
 * false positive here is invisible to us and unexplainable to the user.
 */
const MIN_TERM = 3;

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, '/auth/login?next=/settings/allergens');

	const db = getDb();
	const selected = new Set(
		db
			.prepare<{ allergen_id: number }>('SELECT allergen_id FROM user_allergen WHERE user_id = ?')
			.all(locals.user.id)
			.map((r) => r.allergen_id)
	);

	return {
		welcome: url.searchParams.get('welcome') === '1',
		tree: getAllergenTree(db),
		dietTags: getDietTags(db),
		selected: [...selected],
		custom: getCustomAllergens(db, locals.user.id),
		limits: { maxCustom: MAX_CUSTOM, maxLabel: MAX_LABEL, minTerm: MIN_TERM }
	};
};

/** Splits what the user typed into search terms, and says what is wrong. */
function parseTerms(raw: string, label: string): { terms: string[] } | { error: string } {
	const source = raw.trim() === '' ? label : raw;
	const terms = [
		...new Set(
			source
				.split(',')
				.map((t) => t.trim().toLowerCase())
				.filter((t) => t !== '')
		)
	];

	if (terms.length === 0) return { error: 'Give at least one word to look for.' };

	const tooShort = terms.filter((t) => t.length < MIN_TERM);
	if (tooShort.length > 0) {
		return {
			error: `“${tooShort[0]}” is too short to search for — ${MIN_TERM} letters or more, or it will match half the ingredient list.`
		};
	}
	if (terms.some((t) => !/[a-z]/.test(t))) {
		return { error: 'Search words need at least one letter.' };
	}
	return { terms };
}

export const actions: Actions = {
	/** The seeded taxonomy. Replaces the whole set; an unticked box must remove. */
	save: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/allergens');

		const form = await request.formData();
		const chosen = form
			.getAll('allergen')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n) && n > 0);

		const db = getDb();
		db.transaction(() => {
			// Replace rather than diff. An unchecked box must actually remove the
			// allergen, and a form that only ever added would leave a stale warning
			// the user believed they had turned off.
			db.prepare('DELETE FROM user_allergen WHERE user_id = ?').run(locals.user!.id);

			const now = unixNow();
			for (const id of new Set(chosen)) {
				// The FK does the validating: an id that is not a real allergen throws
				// rather than silently storing rubbish.
				db.prepare(
					'INSERT OR IGNORE INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
				).run(locals.user!.id, id, 'avoid', now);
			}
		});

		return { saved: true, count: new Set(chosen).size };
	},

	/** Add or update one allergen of the user's own. */
	addCustom: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/allergens');

		const form = await request.formData();
		const label = String(form.get('label') ?? '')
			.replace(/\s+/g, ' ')
			.trim();

		if (label === '') return fail(400, { customError: 'Give it a name.' });
		if (label.length > MAX_LABEL) {
			return fail(400, { customError: `Keep the name under ${MAX_LABEL} characters.` });
		}

		const parsed = parseTerms(String(form.get('terms') ?? ''), label);
		if ('error' in parsed) return fail(400, { customError: parsed.error, label });

		const db = getDb();
		const existing = db
			.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user_custom_allergen WHERE user_id = ?')
			.get(locals.user.id)!.c;
		if (existing >= MAX_CUSTOM) {
			return fail(400, {
				customError: `That is the limit of ${MAX_CUSTOM}. Remove one first.`
			});
		}

		// Re-adding a name edits the existing entry rather than quietly creating a
		// second one that looks identical in the list.
		db.prepare(
			`INSERT INTO user_custom_allergen (user_id, label, terms, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, label COLLATE NOCASE)
			 DO UPDATE SET terms = excluded.terms`
		).run(locals.user.id, label, parsed.terms.join('|'), unixNow());

		return { customAdded: label, terms: parsed.terms };
	},

	removeCustom: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/allergens');

		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { customError: 'Unknown allergen.' });

		// Scoped to the user, so a guessed id cannot remove someone else's.
		const removed = getDb()
			.prepare('DELETE FROM user_custom_allergen WHERE id = ? AND user_id = ?')
			.run(id, locals.user.id).changes;
		if (removed === 0) return fail(404, { customError: 'That one is already gone.' });

		return { customRemoved: true };
	}
};
