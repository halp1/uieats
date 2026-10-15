/**
 * The planner's state, as a query string.
 *
 * Same reasoning as the browse pages' meal tabs and diet filter: in the URL it
 * survives a reload, it can be sent to someone ("this is what I'm having at
 * Ike"), and every control on the page -- remove a dish, keep one, try another
 * option -- is a plain link that needs no client JavaScript.
 *
 * Body info is NOT in here. A weight in a link that gets pasted into a group
 * chat is a leak; it lives server-side (see server/body-profile.ts).
 */
import type { Wanted } from './optimize.ts';

export interface PlannerState {
	date: string | null;
	hall: string | null;
	meal: string | null;
	skipSaladBar: boolean;
	diets: string[];
	/** Calories saved for something off this menu. */
	reserve: number;
	/** Canonical dish ids removed from consideration. */
	excluded: number[];
	/** Dishes the user wants, by menu-item instance, with how much of each. */
	wanted: Wanted[];
	/** Which alternative plan, 0-based. */
	option: number;
}

/** How much of a wanted dish can be chosen, in servings. */
export const WANT_STEPS = [0.5, 1, 1.5, 2, 3] as const;
export const MAX_RESERVE = 1500;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function positiveInts(values: string[]): number[] {
	return [...new Set(values.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

export function readPlannerState(params: URLSearchParams): PlannerState {
	const date = params.get('date');
	const reserve = Number(params.get('reserve') ?? 0);
	const option = Number(params.get('opt') ?? 0);

	const wanted: Wanted[] = [];
	for (const raw of params.getAll('want')) {
		const [idText, multText] = raw.split(':');
		const id = Number(idText);
		if (!Number.isInteger(id) || id <= 0 || wanted.some((w) => w.menuItemId === id)) continue;
		const mult = multText === undefined ? 1 : Number(multText);
		wanted.push({
			menuItemId: id,
			multiplier: (WANT_STEPS as readonly number[]).includes(mult) ? mult : 1
		});
	}

	return {
		date: date && DATE.test(date) ? date : null,
		hall: params.get('hall') || null,
		meal: params.get('meal') || null,
		skipSaladBar: params.get('nosalad') === '1',
		diets: [...new Set(params.getAll('diet').filter((d) => /^[a-z-]+$/.test(d)))],
		reserve:
			Number.isFinite(reserve) && reserve > 0 ? Math.min(Math.round(reserve), MAX_RESERVE) : 0,
		excluded: positiveInts(params.getAll('x')),
		wanted: wanted.slice(0, 8),
		option: Number.isInteger(option) && option > 0 ? option : 0
	};
}

export function plannerQuery(state: PlannerState): string {
	const params = new URLSearchParams();
	if (state.date) params.set('date', state.date);
	if (state.hall) params.set('hall', state.hall);
	if (state.meal) params.set('meal', state.meal);
	if (state.skipSaladBar) params.set('nosalad', '1');
	for (const d of state.diets) params.append('diet', d);
	if (state.reserve > 0) params.set('reserve', String(state.reserve));
	for (const x of state.excluded) params.append('x', String(x));
	for (const w of state.wanted) {
		params.append(
			'want',
			w.multiplier === 1 ? String(w.menuItemId) : `${w.menuItemId}:${w.multiplier}`
		);
	}
	if (state.option > 0) params.set('opt', String(state.option));
	return params.toString();
}

export function plannerHref(state: PlannerState, changes: Partial<PlannerState> = {}): string {
	const query = plannerQuery({ ...state, ...changes });
	return query ? `/plan?${query}` : '/plan';
}

/**
 * Anything that changes what is being planned resets to the best option.
 * "Option 3 of 6" means nothing once the menu under it has changed.
 */
export function replan(state: PlannerState, changes: Partial<PlannerState>): string {
	return plannerHref(state, { option: 0, ...changes });
}
