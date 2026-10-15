/**
 * Serving sizes: reading them, sanity-checking them, and scaling them.
 *
 * Upstream's serving line is free text ("1/2 Cup", "Each", "1/12 Slice", "3oz
 * Serving", "Medium 3\" Diameter") with a gram weight beside it. Most of the
 * time the two agree with each other and with the nutrients. Sometimes they do
 * not, and a planner that multiplies a broken label does the most damage of
 * anything in the app: measured on a real Ikenberry day,
 *
 *   Black Beans                      1/2 Cup   17 g   15 cal
 *   Roasted Sweet Potato & Bean Salad 1/2 Cup  247 g  240 cal
 *
 * Half a cup of beans weighs about 90 g, and nothing edible packs 247 g into
 * half a cup. Asked to hit a protein target, a naive optimiser would happily
 * prescribe "six servings" of the first. So every label is checked before it
 * is allowed into a plan, and one that fails is set aside WITH ITS REASON,
 * shown to the user, rather than silently dropped or silently trusted.
 */
import type { Role } from './roles.ts';
import type { Candidate } from './types.ts';

export type PortionKind = 'count' | 'volume' | 'weight' | 'other';

export interface ParsedServing {
	kind: PortionKind;
	/** How many units one serving is: 0.5 for "1/2 Cup", 5 for "5 Each". */
	amount: number;
	/** 'cup' | 'tbsp' | 'tsp' | 'fl oz' | 'oz', or the noun for a count. */
	unit: string;
	/** Volume of one serving, for volume kinds only. */
	ml: number | null;
	/** The serving text as upstream wrote it, minus any gram weight. */
	label: string;
}

const ML: Record<string, number> = { cup: 236.6, tbsp: 14.79, tsp: 4.93, 'fl oz': 29.57 };

/** Nouns that mean "one of a thing", so a portion is counted, not measured. */
const COUNT_NOUNS =
	/\b(each|piece|pieces|slice|slices|bagel|patty|patties|link|links|bun|buns|roll|rolls|sausage|cookie|cookies|donut|muffin|danish|cone|packet|leaf|ring|rings|stick|sticks|fruit|banana|orange|pear|apple|egg|eggs|tortilla|fillet|breast|wing|wings|taco|burrito|wrap|sandwich|burger|biscuit|pancake|waffle|bar|square)\b/;

function parseQuantity(text: string): { amount: number; rest: string } | null {
	const match = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*(.*)$/.exec(text);
	if (!match) return null;
	const [, q, rest] = match;
	let amount: number;
	if (q.includes(' ')) {
		const [whole, frac] = q.split(/\s+/);
		const [n, d] = frac.split('/').map(Number);
		amount = Number(whole) + n / d;
	} else if (q.includes('/')) {
		const [n, d] = q.split('/').map(Number);
		amount = n / d;
	} else {
		amount = Number(q);
	}
	if (!Number.isFinite(amount) || amount <= 0) return null;
	return { amount, rest: rest.trim() };
}

export function parseServing(text: string | null): ParsedServing {
	// "Slice (1/96) (44g)" -> "Slice": the parentheticals are either a gram
	// weight, which is carried separately, or a fraction of a whole pan, which
	// says nothing about how much is on the plate.
	const label = (text ?? '')
		.replace(/\([^)]*\)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const lower = label.toLowerCase();

	if (lower === '' || lower === 'serving' || lower === '1 serving') {
		return { kind: 'other', amount: 1, unit: 'serving', ml: null, label: label || 'Serving' };
	}

	const q = parseQuantity(lower);
	const amount = q?.amount ?? 1;
	const rest = q?.rest ?? lower;

	// "1/12 Slice" is one slice of a pie cut twelve ways, not a twelfth of a slice.
	if (q && amount < 1 && /^slices?\b/.test(rest) && 1 / amount >= 4) {
		return { kind: 'count', amount: 1, unit: 'slice', ml: null, label };
	}

	const volume: [RegExp, string][] = [
		[/^(fl\.? ?oz|fluid ?oz|fluid ounces?)\b/, 'fl oz'],
		[/^cups?\b/, 'cup'],
		[/^(tablespoons?|tbsps?|tbs|tb)\b/, 'tbsp'],
		[/^(teaspoons?|tsps?)\b/, 'tsp']
	];
	for (const [pattern, unit] of volume) {
		if (pattern.test(rest)) return { kind: 'volume', amount, unit, ml: amount * ML[unit], label };
	}

	const oz = /^(oz|ounces?)\b\s*(.*)$/.exec(rest);
	if (oz) {
		// "1oz Slice" and "4oz Bagel" are counted things that happen to quote a
		// weight; "3oz Serving" and "6 Ounce" are weights.
		const noun = COUNT_NOUNS.exec(oz[2]);
		if (noun) return { kind: 'count', amount: 1, unit: noun[1], ml: null, label };
		return { kind: 'weight', amount, unit: 'oz', ml: null, label };
	}

	if (/^servings?\b/.test(rest)) return { kind: 'other', amount, unit: 'serving', ml: null, label };

	const noun = COUNT_NOUNS.exec(rest);
	return { kind: 'count', amount, unit: noun ? noun[1] : rest, ml: null, label };
}

// ---------------------------------------------------------------------------
// Plausibility
// ---------------------------------------------------------------------------

/**
 * Foods that really are lighter than water by volume: leaves, puffed cereal,
 * chips. A low gram weight for a cup of these is correct, not a broken label.
 */
const LIGHT_FOODS =
	/lettuce|spinach|greens|kale|arugula|cabbage|slaw|sprout|mushroom|cereal|flakes|puffs|crunch|cheerios|chex|krispies|loops|grahams|charms|chips|popcorn|crouton|cracker|onion|pepper|cucumber|herb|cilantro|parsley|broccoli|cauliflower|shredded|whipped|marshmallow|sprinkles|granola|green beans|salad/i;

export interface LabelCheck {
	ok: boolean;
	/** Why it was set aside, in words for the page. Null when ok. */
	reason: string | null;
}

const OK: LabelCheck = { ok: true, reason: null };
const fail = (reason: string): LabelCheck => ({ ok: false, reason });

/**
 * Does this label describe something a person could plausibly put on a plate?
 *
 * Each test is a physical impossibility or an internal contradiction, never a
 * judgement about whether the food is healthy. Thresholds are loose on
 * purpose: labels round to the nearest 5 or 10 calories and half-gram, fibre
 * is counted at 4 kcal/g in the carbohydrate line but yields about 2, and a
 * check that rejected honest rounding would throw away half the menu.
 */
export function checkLabel(c: Candidate, serving: ParsedServing, role: Role): LabelCheck {
	const n = c.nutrients;
	if (!n) return fail('The label is missing calories, protein, carbs or fat.');

	if (/^mix\b/i.test(c.name)) {
		return fail('This is listed as a raw mix, not a served portion.');
	}

	if (n.calories > 1000) {
		return fail(
			`One serving is listed at ${Math.round(n.calories)} cal, which reads like a whole batch rather than a portion.`
		);
	}

	const fromMacros = n.proteinG * 4 + n.carbG * 4 + n.fatG * 9;
	const larger = Math.max(n.calories, fromMacros);
	if (Math.abs(fromMacros - n.calories) > Math.max(30, larger * 0.3)) {
		return fail(
			`The calories do not match the macros: the label says ${Math.round(n.calories)} cal, but its protein, carbs and fat add up to about ${Math.round(fromMacros)}.`
		);
	}

	const g = c.servingGrams;
	if (g !== null && g > 0) {
		if (n.calories / g > 9.2) {
			return fail(
				`${Math.round(n.calories)} cal in ${Math.round(g)} g is more energy than pure fat carries, so the weight or the calories are wrong.`
			);
		}
		if (n.proteinG + n.carbG + n.fatG > g * 1.05) {
			return fail(
				`The label lists more protein, carbs and fat (${Math.round(n.proteinG + n.carbG + n.fatG)} g) than the serving weighs (${Math.round(g)} g).`
			);
		}

		if (serving.kind === 'volume' && serving.ml !== null) {
			const density = g / serving.ml;
			// Syrup and honey are about 1.4 g/ml, and nothing on a menu is denser.
			if (density > 1.5) {
				return fail(
					`${Math.round(g)} g does not fit in ${serving.label.toLowerCase()}, so the serving size on the label is probably wrong.`
				);
			}
			const light =
				role === 'veg' ||
				role === 'fruit' ||
				role === 'cereal' ||
				role === 'condiment' ||
				LIGHT_FOODS.test(c.name);
			if (density < 0.3 && !light) {
				return fail(
					`${serving.label} weighing only ${Math.round(g)} g is far too light for this dish, so the serving size on the label is probably wrong.`
				);
			}
		}
	}

	return OK;
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

/**
 * The multiples of a serving it makes sense to take, before any cap.
 *
 * Counted things come in whole numbers -- nobody takes half a cookie off a
 * line -- and measured things in half-serving steps. The planner caps these
 * further by role and by the meal's own size; see `maxMultiplier` in
 * optimize.ts.
 */
export function portionSteps(s: ParsedServing): number[] {
	switch (s.kind) {
		case 'count':
			if (s.amount === 1) return [1, 2, 3, 4];
			// "6 Each" meatballs: 3, 6, 9 or 12 of them, but never 4.5.
			return [0.5, 1, 1.5, 2].filter((m) => Number.isInteger(s.amount * m) && s.amount * m >= 1);
		case 'volume':
			// Never under a quarter cup: smaller than that is a garnish.
			return [0.5, 1, 1.5, 2, 3].filter((m) => m >= 1 || (s.ml ?? 0) * m >= 59);
		case 'weight':
			return [0.5, 1, 1.5, 2, 3].filter((m) => m >= 1 || s.amount * m >= 1.5);
		case 'other':
			return [1, 2];
	}
}

const FRACTIONS: [number, string][] = [
	[0, ''],
	[0.25, '1/4'],
	[1 / 3, '1/3'],
	[0.5, '1/2'],
	[2 / 3, '2/3'],
	[0.75, '3/4'],
	[1, '']
];

/** 1.5 -> "1 1/2", 0.75 -> "3/4", 2 -> "2". Falls back to one decimal. */
export function formatAmount(n: number): string {
	const whole = Math.floor(n + 1e-9);
	const part = n - whole;
	for (const [value, text] of FRACTIONS) {
		if (Math.abs(part - value) < 0.02) {
			if (value === 1) return String(whole + 1);
			if (text === '') return String(whole);
			return whole === 0 ? text : `${whole} ${text}`;
		}
	}
	return String(Math.round(n * 10) / 10);
}

const PLURALS: Record<string, string> = {
	patty: 'patties',
	leaf: 'leaves',
	each: 'each',
	sandwich: 'sandwiches',
	peach: 'peaches',
	burrito: 'burritos',
	taco: 'tacos'
};

function pluralize(noun: string, n: number): string {
	if (n <= 1 || noun.endsWith('s')) return noun;
	return PLURALS[noun] ?? `${noun}s`;
}

/**
 * How much to take, in the units a person serving themselves would think in.
 *
 * "2 × 1/2 Cup" is correct and unhelpful; "1 cup" is what to actually scoop.
 * Anything this cannot turn into a clean phrase falls back to the multiple and
 * upstream's own words, which is never wrong, only less friendly.
 */
export function describePortion(s: ParsedServing, multiplier: number): string {
	const total = s.amount * multiplier;
	switch (s.kind) {
		case 'count': {
			if (!COUNT_NOUNS.test(s.unit)) {
				return multiplier === 1 ? s.label : `${formatAmount(multiplier)} × ${s.label}`;
			}
			return `${formatAmount(total)} ${pluralize(s.unit, total)}`;
		}
		case 'volume': {
			const unit = s.unit === 'cup' ? (total > 1 ? 'cups' : 'cup') : s.unit;
			return `${formatAmount(total)} ${unit}`;
		}
		case 'weight':
			return `${formatAmount(total)} oz`;
		case 'other':
			return multiplier === 1 ? s.label : `${formatAmount(multiplier)} servings`;
	}
}
