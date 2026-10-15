/**
 * Turning a menu and a set of targets into a plate.
 *
 * The shape of the search, and why:
 *
 * 1. Every dish is classified (roles.ts) and its label checked (portions.ts).
 *    Anything whose label does not add up is set aside with a reason; it is
 *    never multiplied.
 *
 * 2. A plate is built from ROLES, not from totals: at most two proteins, two
 *    starches, two vegetables, one fruit, and so on. That is what stops the
 *    optimiser reaching a calorie number with four bowls of rice.
 *
 * 3. Each dish may only be scaled by steps that make sense for how it is
 *    served (whole cookies, half-cup scoops), capped by weight for its role and
 *    by a share of the meal's calories. No single dish the planner picks may
 *    be more than half the meal. "Eat 2 lbs of chicken" is unreachable by
 *    construction, not merely penalised.
 *
 * 4. Within those limits, a plain enumerate-and-improve search: every
 *    protein × starch × vegetable skeleton, portions tuned by coordinate
 *    descent, the best few then grown by a dish at a time while that helps.
 *    A hall's sitting is ~100 eligible dishes, which makes this a few hundred
 *    thousand cheap evaluations -- well under a request's budget, and exact
 *    enough that a cleverer solver would not change the answer.
 *
 * Dishes the user asked for (a dessert, the soft serve) are fixed in place
 * first, so everything else is planned around them. Their totals count against
 * the same targets: wanting a 300-calorie dessert is exactly what makes the
 * rest of the plate smaller.
 */
import type { NutrientTargets } from './targets.ts';
import type { Candidate, Nutrients } from './types.ts';
import {
	checkLabel,
	describePortion,
	parseServing,
	portionSteps,
	type ParsedServing
} from './portions.ts';
import { classify, type Role } from './roles.ts';

export interface Prepared extends Candidate {
	role: Role;
	serving: ParsedServing;
	/** Null when the label passed its checks. */
	problem: string | null;
}

export interface PlanLine {
	item: Prepared;
	multiplier: number;
	/** "1 cup", "2 slices": what to actually take. */
	portion: string;
	grams: number | null;
	nutrients: Nutrients;
	/** True when the user asked for it rather than the planner choosing it. */
	wanted: boolean;
}

export interface Totals {
	calories: number;
	proteinG: number;
	carbG: number;
	fatG: number;
	fiberG: number;
	sugarG: number;
	sodiumMg: number;
	satFatG: number;
	/** Nutrients where at least one line's label left the value blank. */
	blanks: ('fiberG' | 'sugarG' | 'sodiumMg' | 'satFatG')[];
}

export interface MealPlan {
	lines: PlanLine[];
	totals: Totals;
	score: number;
}

export interface Wanted {
	menuItemId: number;
	multiplier: number;
}

export interface PlanRequest {
	candidates: Candidate[];
	/** For ONE meal, after any calories saved for later. */
	targets: NutrientTargets;
	/** The sitting being planned, which decides whether cereal is in play. */
	meal: string;
	wanted?: Wanted[];
	/** Canonical dish ids the user removed. Every instance of the dish goes. */
	excludedItemIds?: readonly number[];
	/** Which of the alternative plans to return, 0-based; wraps around. */
	option?: number;
}

export interface PlanResult {
	plan: MealPlan | null;
	option: number;
	optionCount: number;
	/** Labels that failed a check, one per dish, with the reason. */
	skipped: { item: Prepared; reason: string }[];
	notes: string[];
	/** Everything prepared, for the "add something you want" picker. */
	prepared: Prepared[];
}

/** Roles the planner may choose by itself, and how many of each. */
const ROLE_CAPS: Partial<Record<Role, number>> = {
	protein: 2,
	// Two, but the second costs something in the score (see scorePlan): bread
	// AND rice AND fries is how a plate quietly becomes all starch, so a second
	// one only goes on when the first cannot reach the target by itself.
	starch: 2,
	veg: 2,
	fruit: 1,
	dairy: 1,
	soup: 1,
	side: 1,
	cereal: 1
};

/** Heaviest single helping, by role, in grams. ~9 oz of meat, ~2 cups of soup. */
const GRAM_CAPS: Record<Role, number> = {
	protein: 260,
	starch: 320,
	veg: 320,
	fruit: 300,
	dairy: 490,
	soup: 500,
	side: 250,
	cereal: 90,
	dessert: 200,
	drink: 500,
	condiment: 60
};

/**
 * Biggest single helping by volume, for dishes served by the scoop. Weight
 * alone lets light food through -- green beans run 79 g a cup, so the gram cap
 * allowed four cups of them.
 */
const CUP = 236.6;
const VOLUME_CAPS: Record<Role, number> = {
	protein: 1.5 * CUP,
	starch: 1.5 * CUP,
	veg: 2 * CUP,
	fruit: 1.5 * CUP,
	dairy: 1.5 * CUP,
	soup: 2 * CUP,
	// Mixed sides: a scoop, not a bowl.
	side: 0.75 * CUP,
	cereal: 2 * CUP,
	dessert: 1.5 * CUP,
	drink: 2 * CUP,
	condiment: 0.25 * CUP
};

/** Most of one dish the planner will choose: half the meal's calories. */
const MAX_SHARE = 0.5;
/** Nouns where more than two on a plate starts to look silly. */
const PAIRED =
	/slice|bun|roll|bagel|tortilla|muffin|biscuit|pancake|waffle|burger|sandwich|breast|fillet/;
const MAX_AUTO_LINES = 5;

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export function prepare(candidates: Candidate[]): Prepared[] {
	return candidates.map((c) => {
		const role = classify(c);
		const serving = parseServing(c.servingText);
		const check = checkLabel(c, serving, role);
		return { ...c, role, serving, problem: check.reason };
	});
}

function zeroIfBlank(n: number | null): number {
	return n ?? 0;
}

function scale(n: Nutrients, m: number): Nutrients {
	const s = (v: number | null) => (v === null ? null : v * m);
	return {
		calories: n.calories * m,
		proteinG: n.proteinG * m,
		carbG: n.carbG * m,
		fatG: n.fatG * m,
		fiberG: s(n.fiberG),
		sugarG: s(n.sugarG),
		sodiumMg: s(n.sodiumMg),
		satFatG: s(n.satFatG)
	};
}

const EMPTY: Nutrients = {
	calories: 0,
	proteinG: 0,
	carbG: 0,
	fatG: 0,
	fiberG: 0,
	sugarG: 0,
	sodiumMg: 0,
	satFatG: 0
};

function line(item: Prepared, multiplier: number, wanted: boolean): PlanLine {
	return {
		item,
		multiplier,
		portion: describePortion(item.serving, multiplier),
		grams: item.servingGrams === null ? null : Math.round(item.servingGrams * multiplier),
		nutrients: item.nutrients ? scale(item.nutrients, multiplier) : EMPTY,
		wanted
	};
}

export function totalsOf(lines: PlanLine[]): Totals {
	const t: Totals = {
		calories: 0,
		proteinG: 0,
		carbG: 0,
		fatG: 0,
		fiberG: 0,
		sugarG: 0,
		sodiumMg: 0,
		satFatG: 0,
		blanks: []
	};
	const blanks = new Set<Totals['blanks'][number]>();
	for (const l of lines) {
		const n = l.nutrients;
		t.calories += n.calories;
		t.proteinG += n.proteinG;
		t.carbG += n.carbG;
		t.fatG += n.fatG;
		for (const key of ['fiberG', 'sugarG', 'sodiumMg', 'satFatG'] as const) {
			if (n[key] === null) blanks.add(key);
			t[key] += zeroIfBlank(n[key]);
		}
	}
	t.blanks = [...blanks];
	return t;
}

/**
 * The multiples of one dish the planner may choose.
 *
 * Empty means the dish cannot be part of this meal at any sensible size --
 * a 740-calorie burger against a 500-calorie meal, say.
 */
export function allowedSteps(item: Prepared, mealCalories: number): number[] {
	const n = item.nutrients;
	if (!n) return [];
	const gramCap = GRAM_CAPS[item.role];
	const kcalCap = mealCalories * MAX_SHARE;

	return portionSteps(item.serving).filter((m) => {
		if (m > 3) {
			// Four of something only when each one is small: deli slices, eggs.
			if (n.calories > 80) return false;
		}
		if (
			item.serving.kind === 'count' &&
			PAIRED.test(item.serving.unit) &&
			item.serving.amount * m > 2
		) {
			return false;
		}
		if (item.servingGrams !== null && item.servingGrams * m > gramCap) {
			// Always allow one standard serving of something under the calorie cap,
			// even when upstream's portion is itself on the big side.
			if (m !== 1) return false;
			if (item.servingGrams > gramCap * 1.4) return false;
		}
		if (item.serving.ml !== null && item.serving.ml * m > VOLUME_CAPS[item.role] + 1) {
			if (m !== 1) return false;
		}
		if (item.servingGrams === null && m > 2) return false;
		// A quarter-scoop of beef is a garnish, not a protein. Vegetables and
		// fruit are exempt: they are meant to be light.
		if (
			item.role !== 'veg' &&
			item.role !== 'fruit' &&
			m < 1 &&
			n.calories * m < mealCalories * 0.12
		) {
			return false;
		}
		return n.calories * m <= kcalCap;
	});
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Context {
	targets: NutrientTargets;
	/** Lunch or dinner with a vegetable on offer: a plate without one is not balanced. */
	wantsVeg: boolean;
	hasGreenOption: boolean;
	hasProteinOption: boolean;
}

/** One dish at one multiple, as the search sees it. Cheaper than a PlanLine. */
interface Part {
	item: Prepared;
	m: number;
	wanted: boolean;
}

/**
 * Lower is better. Zero is a plate that hits every target exactly.
 *
 * Works on the raw numbers rather than on display lines: it runs a few hundred
 * thousand times per plan, and building portion strings each time was most of
 * the cost.
 */
function scoreParts(parts: Part[], ctx: Context): number {
	let kcal = 0;
	let protein = 0;
	let carb = 0;
	let fat = 0;
	let fiber = 0;
	let sodium = 0;
	let sat = 0;
	let sugar = 0;
	let hasVeg = false;
	let hasFruit = false;
	let hasProtein = false;
	let starches = 0;
	let rescaled = 0;
	for (const { item, m, wanted } of parts) {
		const n = item.nutrients;
		if (n) {
			kcal += n.calories * m;
			protein += n.proteinG * m;
			carb += n.carbG * m;
			fat += n.fatG * m;
			fiber += zeroIfBlank(n.fiberG) * m;
			sodium += zeroIfBlank(n.sodiumMg) * m;
			sat += zeroIfBlank(n.satFatG) * m;
			sugar += zeroIfBlank(n.sugarG) * m;
		}
		if (item.role === 'veg') hasVeg = true;
		else if (item.role === 'fruit') hasFruit = true;
		else if (item.role === 'protein' || item.role === 'dairy') hasProtein = true;
		if (!wanted && item.role === 'starch') starches++;
		if (!wanted && m !== 1) rescaled++;
	}

	const T = ctx.targets;
	const rel = (x: number, target: number) => (x - target) / Math.max(target, 1);

	let s = 0;
	const k = rel(kcal, T.calories);
	s += (k > 0 ? 8 : 6) * k * k;
	// Short on protein is the worst miss; over is barely one.
	const p = rel(protein, T.proteinG);
	s += (p < 0 ? 5 : 0.5) * p * p;
	const c = rel(carb, T.carbG);
	s += 1.5 * c * c;
	const f = rel(fat, T.fatG);
	s += (f > 0 ? 2.5 : 1) * f * f;

	if (fiber < T.fiberG) s += 1.2 * rel(fiber, T.fiberG) ** 2;
	// Limits: only going over counts.
	if (sodium > T.sodiumMg) s += 1.5 * rel(sodium, T.sodiumMg) ** 2;
	if (sat > T.satFatG) s += 1.5 * rel(sat, T.satFatG) ** 2;
	if (sugar > T.sugarG) s += 0.8 * rel(sugar, T.sugarG) ** 2;

	if (ctx.wantsVeg && !hasVeg) s += 0.4;
	else if (ctx.hasGreenOption && !hasVeg && !hasFruit) s += 0.25;
	if (ctx.hasProteinOption && !hasProtein) s += 0.3;

	// See ROLE_CAPS: a second starch has to earn its place.
	if (starches > 1) s += 0.08 * (starches - 1);

	// A shorter plate and standard portions, all else being nearly equal.
	s += 0.015 * Math.max(0, parts.length - 3);
	s += 0.01 * rescaled;
	return s;
}

/** Rough per-dish merit, only for trimming each role's pool before the search. */
function prior(item: Prepared): number {
	const n = item.nutrients!;
	const kcal = Math.max(n.calories, 1);
	const protein = (n.proteinG * 4) / kcal;
	const fiber = (zeroIfBlank(n.fiberG) * 100) / kcal;
	const sat = (zeroIfBlank(n.satFatG) * 9) / kcal;
	const sodium = zeroIfBlank(n.sodiumMg) / kcal;
	const weight = item.role === 'protein' ? 2 : 0.6;
	return weight * protein + 0.15 * fiber - 1.2 * sat - 0.15 * sodium;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface Slot {
	item: Prepared;
	steps: number[];
}

interface Draft {
	slots: { slot: Slot; m: number }[];
	score: number;
}

type Pick = { slot: Slot; m: number };

function partsOf(fixed: Part[], picks: Pick[]): Part[] {
	return [...fixed, ...picks.map((d) => ({ item: d.slot.item, m: d.m, wanted: false }))];
}

/** Tunes each dish's portion in turn until no single change helps. */
function tune(fixed: Part[], picks: Pick[], ctx: Context): Draft {
	let current = picks.map((s) => ({ ...s }));
	let best = scoreParts(partsOf(fixed, current), ctx);

	for (let pass = 0; pass < 3; pass++) {
		let improved = false;
		for (let i = 0; i < current.length; i++) {
			for (const m of current[i].slot.steps) {
				if (m === current[i].m) continue;
				const trial = current.map((s, j) => (j === i ? { ...s, m } : s));
				const score = scoreParts(partsOf(fixed, trial), ctx);
				if (score < best - 1e-9) {
					best = score;
					current = trial;
					improved = true;
				}
			}
		}
		if (!improved) break;
	}
	return { slots: current, score: best };
}

function startStep(steps: number[]): number {
	return steps.includes(1) ? 1 : steps[0];
}

function roleCount(draft: { slot: Slot }[], fixed: Part[], role: Role): number {
	return (
		draft.filter((d) => d.slot.item.role === role).length +
		fixed.filter((l) => l.item.role === role).length
	);
}

function signature(draft: Draft): string {
	return draft.slots
		.map((s) => s.slot.item.itemId)
		.sort((a, b) => a - b)
		.join(',');
}

export function planMeal(request: PlanRequest): PlanResult {
	const prepared = prepare(request.candidates);
	const excluded = new Set(request.excludedItemIds ?? []);
	const wantedReq = request.wanted ?? [];
	const notes: string[] = [];
	const T = request.targets;
	const isBreakfast = /breakfast|brunch/i.test(request.meal);

	// The user's own picks, fixed in place.
	const byInstance = new Map(prepared.map((p) => [p.menuItemId, p]));
	const fixedLines: PlanLine[] = [];
	for (const w of wantedReq) {
		const item = byInstance.get(w.menuItemId);
		if (!item) continue;
		fixedLines.push(line(item, w.multiplier, true));
		if (!item.nutrients) {
			notes.push(`${item.name} has no usable nutrition label, so it is not counted in the totals.`);
		} else if (item.problem) {
			notes.push(`${item.name}'s label looks off, so its numbers may be wrong: ${item.problem}`);
		}
	}
	const fixed: Part[] = fixedLines.map((l) => ({ item: l.item, m: l.multiplier, wanted: true }));
	const wantedItems = new Set(fixed.map((l) => l.item.itemId));

	// One entry per dish: the same green beans at three venues is one choice,
	// not three, and the first venue listed is as good as any.
	const seen = new Set<string>();
	const skipped: PlanResult['skipped'] = [];
	const eligible: Slot[] = [];
	for (const item of prepared) {
		const key = `${item.itemId}|${item.nutrients?.calories ?? 'x'}|${item.serving.label}`;
		if (seen.has(key)) continue;
		seen.add(key);

		if (!(item.role in ROLE_CAPS)) continue;
		if (excluded.has(item.itemId) || wantedItems.has(item.itemId)) continue;
		if (item.role === 'cereal' && !isBreakfast) continue;
		if (item.problem) {
			skipped.push({ item, reason: item.problem });
			continue;
		}
		const n = item.nutrients!;
		// Spinach at 0 cal and a 5-cal radish garnish add nothing a plan can use.
		const floor = item.role === 'veg' || item.role === 'fruit' ? 10 : 40;
		if (n.calories < floor) continue;

		const steps = allowedSteps(item, T.calories);
		if (steps.length === 0) continue;
		eligible.push({ item, steps });
	}

	const pool = (roles: Role[], size: number) =>
		eligible
			.filter((s) => roles.includes(s.item.role))
			.sort((a, b) => prior(b.item) - prior(a.item) || a.item.menuItemId - b.item.menuItemId)
			.slice(0, size);

	const proteins = pool(['protein'], 12);
	const starches = pool(['starch', 'cereal'], 10);
	const vegetables = pool(['veg'], 10);
	const fruit = pool(['fruit'], 6);
	const extras = [
		...proteins,
		...starches,
		...vegetables,
		...fruit,
		...pool(['dairy', 'soup', 'side'], 8)
	];

	const fixedRoles = new Set(fixed.map((l) => l.item.role));
	const ctx: Context = {
		targets: T,
		wantsVeg: !isBreakfast && vegetables.length > 0,
		hasGreenOption: vegetables.length + fruit.length > 0,
		hasProteinOption: proteins.length > 0
	};

	// The green slot of every skeleton. At lunch and dinner it is a vegetable --
	// fruit can still join in the growing step below -- and it is only optional
	// when there is nothing green to have, or the user already picked some.
	const greens = ctx.wantsVeg ? vegetables : [...vegetables, ...fruit];
	const greensDone = fixedRoles.has('veg') || (!ctx.wantsVeg && fixedRoles.has('fruit'));

	const fixedCalories = totalsOf(fixedLines).calories;
	if (fixed.length > 0 && fixedCalories > T.calories * 0.9) {
		notes.push(
			`What you picked already comes to ${Math.round(fixedCalories)} cal of this meal's ${Math.round(T.calories)}, so the planner has kept everything else light.`
		);
	}

	if (eligible.length === 0 && fixed.length === 0) {
		return { plan: null, option: 0, optionCount: 0, skipped, notes, prepared };
	}

	// Skeletons: one of each core role, or none of it.
	const drafts: Draft[] = [];
	const options = <T>(xs: T[]) => [null, ...xs];
	const greenOptions = greens.length > 0 && !greensDone ? greens : options(greens);
	for (const p of options(proteins)) {
		for (const s of options(starches)) {
			for (const g of greenOptions) {
				const chosen = [p, s, g].filter((x): x is Slot => x !== null);
				if (chosen.length === 0) continue;
				const draft = tune(
					fixed,
					chosen.map((slot) => ({ slot, m: startStep(slot.steps) })),
					ctx
				);
				drafts.push(draft);
			}
		}
	}
	drafts.sort((a, b) => a.score - b.score);

	// Grow the best skeletons a dish at a time while it helps.
	const grown: Draft[] = [];
	const seenSig = new Set<string>();
	for (const start of drafts.slice(0, 60)) {
		let draft = start;
		while (draft.slots.length < MAX_AUTO_LINES) {
			let bestNext: Draft | null = null;
			for (const slot of extras) {
				if (draft.slots.some((d) => d.slot.item.itemId === slot.item.itemId)) continue;
				const cap = ROLE_CAPS[slot.item.role] ?? 0;
				if (roleCount(draft.slots, fixed, slot.item.role) >= cap) continue;
				const trial = tune(fixed, [...draft.slots, { slot, m: startStep(slot.steps) }], ctx);
				if (trial.score < (bestNext?.score ?? draft.score - 0.003)) bestNext = trial;
			}
			if (!bestNext) break;
			draft = bestNext;
		}
		const sig = signature(draft);
		if (seenSig.has(sig)) continue;
		seenSig.add(sig);
		grown.push(draft);
	}
	// A plate of only the user's own picks is a valid answer too.
	if (fixed.length > 0) grown.push({ slots: [], score: scoreParts(fixed, ctx) });
	grown.sort((a, b) => a.score - b.score);

	// Growing a dish at a time is short-sighted: the biggest single step (a
	// scoop of fries) can block a better plate two steps away. So the best few
	// are then polished by trying every swap and every removal until neither
	// helps.
	const fits = (picks: Pick[], slot: Slot) =>
		!picks.some((d) => d.slot.item.itemId === slot.item.itemId) &&
		roleCount(picks, fixed, slot.item.role) < (ROLE_CAPS[slot.item.role] ?? 0);

	const improve = (draft: Draft): Draft => {
		let current = draft;
		for (let round = 0; round < 4; round++) {
			let best = current;
			for (let i = 0; i < current.slots.length; i++) {
				const rest = current.slots.filter((_, j) => j !== i);
				if (rest.length + fixed.length > 0) {
					const removed = tune(fixed, rest, ctx);
					if (removed.score < best.score - 1e-6) best = removed;
				}
				for (const slot of extras) {
					if (
						!fits(current.slots, slot) &&
						!(slot.item.role === current.slots[i].slot.item.role && fits(rest, slot))
					) {
						continue;
					}
					if (!fits(rest, slot)) continue;
					const swapped = tune(fixed, [...rest, { slot, m: startStep(slot.steps) }], ctx);
					if (swapped.score < best.score - 1e-6) best = swapped;
				}
			}
			if (best === current) break;
			current = best;
		}
		return current;
	};

	const polished: Draft[] = [];
	const polishedSig = new Set<string>();
	for (const draft of [...grown.slice(0, 8).map(improve), ...grown]) {
		const sig = signature(draft);
		if (polishedSig.has(sig)) continue;
		polishedSig.add(sig);
		polished.push(draft);
	}
	polished.sort((a, b) => a.score - b.score);

	// Alternatives must actually differ: two dishes changed at least, so "show
	// another" is not the same plate with a different vegetable.
	const alternatives: Draft[] = [];
	for (const draft of polished) {
		const ids = new Set(draft.slots.map((s) => s.slot.item.itemId));
		const distinct = alternatives.every((a) => {
			const other = new Set(a.slots.map((s) => s.slot.item.itemId));
			const shared = [...ids].filter((id) => other.has(id)).length;
			return Math.max(ids.size, other.size) - shared >= 2;
		});
		if (distinct) alternatives.push(draft);
		if (alternatives.length >= 6) break;
	}

	if (alternatives.length === 0) {
		return { plan: null, option: 0, optionCount: 0, skipped, notes, prepared };
	}

	const option =
		(((request.option ?? 0) % alternatives.length) + alternatives.length) % alternatives.length;
	const chosen = alternatives[option];
	const lines = [...fixedLines, ...chosen.slots.map((d) => line(d.slot.item, d.m, false))];
	return {
		plan: { lines, totals: totalsOf(lines), score: chosen.score },
		option,
		optionCount: alternatives.length,
		skipped,
		notes,
		prepared
	};
}
