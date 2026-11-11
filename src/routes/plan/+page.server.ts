/**
 * The meal planner: pick a hall and a sitting, get a balanced plate.
 *
 * Everything that shapes the plan is in the query string (see
 * $lib/planner/state.ts) except body info, which is read server-side so a
 * shared link never carries someone's weight. With no body info at all the
 * page still plans, against the 2,000-calorie reference day the nutrition
 * label itself uses, and says so.
 */
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { loadBodyProfile } from '$lib/server/body-profile';
import { getAllergenProfile, getDietTags, isEmptyProfile } from '$lib/server/queries/allergens';
import { getUnitsServingOn } from '$lib/server/queries/menus';
import { getPlannerMenu } from '$lib/server/queries/planner';
import { getUnitBySlug, getUnitTree } from '$lib/server/queries/units';
import { campusToday, defaultMeal } from '$lib/dates';
import { planMeal } from '$lib/planner/optimize';
import { readPlannerState } from '$lib/planner/state';
import { computeTargets, referenceTargets, reserveCalories } from '$lib/planner/targets';

const HALL_COOKIE = 'uieats_plan_hall';

export const load: PageServerLoad = ({ url, locals, cookies }) => {
	const db = getDb();
	const today = campusToday();
	const state = readPlannerState(url.searchParams);
	const date = state.date ?? today;

	// Only places with something on the menu that day are worth offering.
	const served = getUnitsServingOn(db, date);
	const halls = getUnitTree(db)
		.map((h) => ({
			slug: h.slug,
			name: h.name,
			shortName: h.shortName,
			items: (served.get(h.id) ?? 0) + h.venues.reduce((n, v) => n + (served.get(v.id) ?? 0), 0)
		}))
		.filter((h) => h.items > 0);

	// Remembering the hall is a convenience for the common case -- the same
	// student eats in the same building most days -- so it is a cookie, and an
	// explicit ?hall= always wins.
	const hallSlug = state.hall ?? cookies.get(HALL_COOKIE) ?? null;
	const root = hallSlug ? getUnitBySlug(db, hallSlug) : null;
	if (root && state.hall) {
		cookies.set(HALL_COOKIE, root.slug, {
			path: '/plan',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 180
		});
	}

	const body = loadBodyProfile(db, locals.user, cookies);
	const targets = body ? computeTargets(body) : referenceTargets();
	const reserve = Math.min(state.reserve, Math.round(targets.meal.calories * 0.6));
	const mealTargets = reserveCalories(targets.meal, reserve);

	const userId = locals.user?.id ?? null;
	const allergenProfile = getAllergenProfile(db, userId);

	const base = {
		state: { ...state, date, hall: root?.slug ?? null },
		today,
		halls,
		hall: root ? { slug: root.slug, name: root.name } : null,
		dietTags: getDietTags(db),
		hasBody: body !== null,
		units: body?.units ?? 'imperial',
		targets,
		mealTargets,
		reserve,
		checkingAllergens: !isEmptyProfile(allergenProfile),
		signedIn: locals.user !== null
	};

	if (!root) return { ...base, menu: null, result: null };

	const menu = getPlannerMenu(db, {
		date,
		root,
		meal: state.meal,
		defaultMeal: (sittings) => defaultMeal(sittings, { date, today }),
		profile: allergenProfile,
		diets: state.diets,
		skipSaladBar: state.skipSaladBar
	});

	const result = planMeal({
		candidates: menu.candidates,
		targets: mealTargets,
		meal: menu.meal ?? '',
		wanted: state.wanted,
		excludedItemIds: state.excluded,
		option: state.option
	});

	// What the page needs, not the whole prepared list: the picker shows names
	// and calories, and the removed list needs names for the dishes it names.
	const excludedNames = new Map<number, string>();
	for (const p of result.prepared) {
		if (state.excluded.includes(p.itemId)) excludedNames.set(p.itemId, p.name);
	}

	return {
		...base,
		state: { ...base.state, meal: menu.meal },
		menu: {
			sittings: menu.sittings,
			stations: menu.stations,
			meal: menu.meal,
			allergenHeld: menu.allergenHeld,
			saladBarHeld: menu.saladBarHeld,
			dietHeld: menu.dietHeld
		},
		result: {
			plan: result.plan,
			option: result.option,
			optionCount: result.optionCount,
			skipped: result.skipped.map((s) => ({
				name: s.item.name,
				venue: s.item.venue,
				slug: s.item.slug,
				serving: s.item.servingText,
				reason: s.reason
			})),
			notes: result.notes,
			removed: state.excluded.map((id) => ({ itemId: id, name: excludedNames.get(id) ?? null })),
			choices: result.prepared
				.filter((p) => p.role !== 'condiment' && p.nutrients !== null)
				.map((p) => ({
					menuItemId: p.menuItemId,
					name: p.name,
					venue: p.venue,
					station: p.station,
					role: p.role,
					serving: p.servingText,
					calories: p.nutrients!.calories
				}))
		}
	};
};
