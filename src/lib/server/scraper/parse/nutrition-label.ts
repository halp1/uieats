/**
 * One item's nutrition label.
 *
 * Two things here are load-bearing for safety:
 *   * The "Contains:" line is the authoritative allergen declaration.
 *   * The ingredient text is the ONLY place a species appears. Upstream
 *     declares "Tree Nuts"; only the prose says MACADAMIA NUTS.
 *
 * And one for honesty: upstream writes "NA" or a bare nbsp for values it does
 * not have. Those become null, never 0.
 */
import { createHash } from 'node:crypto';
import { parse, type HTMLElement } from 'node-html-parser';
import { decodeEntities, normalizeWhitespace, parseNutrientNumber } from './text.ts';

export interface LabelNutrients {
	calories: number | null;
	calFromFat: number | null;
	totalFatG: number | null;
	satFatG: number | null;
	transFatG: number | null;
	polyFatG: number | null;
	monoFatG: number | null;
	cholesterolMg: number | null;
	sodiumMg: number | null;
	potassiumMg: number | null;
	totalCarbG: number | null;
	fiberG: number | null;
	fiberIsLessThan: boolean;
	sugarsG: number | null;
	proteinG: number | null;
	vitADv: number | null;
	vitCDv: number | null;
	calciumDv: number | null;
	ironDv: number | null;
}

export interface LabelComponent {
	componentName: string;
	ingredientText: string | null;
}

export interface ParsedLabel {
	name: string | null;
	servingSizeText: string | null;
	servingGrams: number | null;
	nutrients: LabelNutrients;
	/**
	 * Verbatim, cross-contact advisory included.
	 *
	 * Deliberately NOT pre-split. Callers that need the advisory separated call
	 * `splitIngredientAdvisory` themselves -- a second field here would be a
	 * field a hand-built label could forget to set, and forgetting it silently
	 * turns allergen matching back on over the advisory text. That is precisely
	 * the bug this machinery exists to prevent, so the shape makes it
	 * unrepresentable rather than merely discouraged.
	 */
	ingredientsText: string | null;
	components: LabelComponent[];
	/** Exactly as upstream spells them, e.g. ['Corn', 'Eggs', 'Tree Nuts']. */
	contains: string[];
	/** Identity for content-addressed storage; identical labels share a row. */
	contentHash: string;
}

/** Upstream's nutrient row labels, mapped onto our field names. */
const NUTRIENT_ROWS: Record<string, keyof LabelNutrients> = {
	'total fat': 'totalFatG',
	'saturated fat': 'satFatG',
	'trans fat': 'transFatG',
	'polyunsaturated fat': 'polyFatG',
	'monounsaturated fat': 'monoFatG',
	cholesterol: 'cholesterolMg',
	sodium: 'sodiumMg',
	potassium: 'potassiumMg',
	'total carbohydrate': 'totalCarbG',
	'dietary fiber': 'fiberG',
	sugars: 'sugarsG',
	protein: 'proteinG',
	'vitamin a': 'vitADv',
	'vitamin c': 'vitCDv',
	calcium: 'calciumDv',
	iron: 'ironDv'
};

const EMPTY_NUTRIENTS: LabelNutrients = {
	calories: null,
	calFromFat: null,
	totalFatG: null,
	satFatG: null,
	transFatG: null,
	polyFatG: null,
	monoFatG: null,
	cholesterolMg: null,
	sodiumMg: null,
	potassiumMg: null,
	totalCarbG: null,
	fiberG: null,
	fiberIsLessThan: false,
	sugarsG: null,
	proteinG: null,
	vitADv: null,
	vitCDv: null,
	calciumDv: null,
	ironDv: null
};

function textOf(node: HTMLElement | null | undefined): string {
	return node ? normalizeWhitespace(decodeEntities(node.text)) : '';
}

/**
 * Splits on commas at paren depth zero.
 *
 * Component bodies are comma-heavy and themselves contain nested parentheses
 * ("ENRICHED FLOUR BLEACHED (WHEAT FLOUR, NIACIN, ...)"), so a plain split on
 * "," shatters them.
 */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));

	return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * Phrases that introduce a cross-contact advisory rather than an ingredient.
 *
 * Measured across 830 labels: 64 carry a "may contain", and they are NOT all
 * advisories -- see `splitIngredientAdvisory`.
 */
const ADVISORY_PHRASES = [
	'may also contain',
	'may contain',
	'contains traces of',
	'manufactured in a facility',
	'manufactured on shared',
	'produced in a facility',
	'produced on shared',
	'processed in a facility',
	'processed on shared',
	'packaged in a facility',
	'made in a facility',
	'made on shared'
];

/**
 * The one phrasing that looks like an advisory and is not.
 *
 * "Vegetable Oil (May Contain One or More of the Following: Canola, Sunflower,
 * Cottonseed)" is a SUBSTITUTION: the oil genuinely is one of those, so every
 * name in the list is a real possible ingredient and must keep counting as one.
 */
const SUBSTITUTION_HINT = 'one or more of the following';

export interface SplitIngredients {
	/** Ingredients with advisory clauses removed. */
	body: string | null;
	/** The advisory clauses, joined, or null. */
	advisory: string | null;
}

/**
 * Separates cross-contact advisories from the ingredient list.
 *
 * This exists because "MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts." is not
 * a statement that the dish contains tree nuts. Reading it as one made Assorted
 * Dinner Rolls -- flour, water, yeast, salt -- warn for tree nuts, and an app
 * that over-warns teaches people to stop reading its warnings.
 *
 * TWO THINGS THE CORPUS FORCED, both learned the hard way:
 *
 * 1. Paren depth is NOT the discriminator. Most advisories are nested inside a
 *    component's own parenthetical and are entirely genuine there:
 *    `Chopped Peanuts (GFS: Dry Roasted Peanuts. MAY CONTAIN: Tree Nuts.)`.
 *    Only 13 of the 64 sit at depth zero.
 * 2. An advisory must not swallow the rest of the list. It ends at the first
 *    sentence stop OR at the close of the parenthetical it started inside,
 *    whichever comes first -- otherwise extracting the peanut component's
 *    advisory would delete every ingredient after it.
 *
 * Where the wording is genuinely ambiguous this errs toward calling it an
 * advisory, which is the cheaper mistake: an advisory still renders as a
 * warning, just a differently-shaped one, so nothing disappears either way.
 */
export function splitIngredientAdvisory(text: string): SplitIngredients {
	const lower = text.toLowerCase();
	const spans: [number, number][] = [];

	// Paren depth at each index, so a clause can be bounded by its own bracket.
	const depths: number[] = [];
	let depth = 0;
	for (const ch of text) {
		if (ch === '(' || ch === '[') depth++;
		depths.push(depth);
		if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
	}

	for (let i = 0; i < text.length; i++) {
		const phrase = ADVISORY_PHRASES.find((p) => lower.startsWith(p, i));
		if (!phrase) continue;
		if (i > 0 && /[a-z]/i.test(text[i - 1])) continue;

		const after = lower.slice(i + phrase.length, i + phrase.length + 40);
		if (after.includes(SUBSTITUTION_HINT)) {
			i += phrase.length;
			continue;
		}

		const openDepth = depths[i];
		let end = i + phrase.length;
		while (end < text.length) {
			const c = text[end];
			// The bracket that closes the clause's own parenthetical ends it, and is
			// NOT consumed -- swallowing it would unbalance the body and break the
			// component split that reads it.
			if ((c === ')' || c === ']') && depths[end] <= openDepth) break;
			if (c === '.' && depths[end] <= openDepth) {
				end++;
				break;
			}
			end++;
		}
		spans.push([i, end]);
		i = end - 1;
	}

	if (spans.length === 0) return { body: text.trim() || null, advisory: null };

	let body = '';
	let cursor = 0;
	const advisories: string[] = [];
	for (const [from, to] of spans) {
		body += text.slice(cursor, from);
		advisories.push(text.slice(from, to).trim());
		cursor = to;
	}
	body += text.slice(cursor);

	return {
		// Tidy the seam left where a clause was cut out mid-list.
		body:
			body
				.replace(/\s+/g, ' ')
				.replace(/([,;:])\s*([.)\]])/g, '$2')
				.trim() || null,
		advisory: advisories.join(' ') || null
	};
}

function parseComponents(ingredients: string): LabelComponent[] {
	return splitTopLevel(ingredients).map((chunk) => {
		const open = chunk.indexOf('(');
		if (open === -1 || !chunk.trimEnd().endsWith(')')) {
			return { componentName: chunk.replace(/[.,\s]+$/, ''), ingredientText: null };
		}
		const close = chunk.lastIndexOf(')');
		return {
			componentName: chunk
				.slice(0, open)
				.trim()
				.replace(/[.,\s]+$/, ''),
			ingredientText: chunk.slice(open + 1, close).trim() || null
		};
	});
}

export function parseNutritionLabel(html: string): ParsedLabel {
	const root = parse(html);
	const nutrients: LabelNutrients = { ...EMPTY_NUTRIENTS };

	const name = textOf(root.querySelector('.cbo_nn_LabelHeader')) || null;

	// "Serving Size:&nbsp;Slice (1/96)&nbsp;(42g)"
	const servingRaw = textOf(root.querySelector('.cbo_nn_LabelBottomBorderLabel'));
	const servingSizeText = servingRaw.replace(/^serving size:\s*/i, '').trim() || null;
	const gramsMatch = servingSizeText ? /\((\d+(?:\.\d+)?)\s*g\)\s*$/.exec(servingSizeText) : null;
	const servingGrams = gramsMatch ? Number(gramsMatch[1]) : null;

	// Calories sits in its own two-column row rather than the nutrient table.
	for (const cell of root.querySelectorAll('.cbo_nn_LabelDetail, .cbo_nn_LabelDetailRight')) {
		const text = textOf(cell);
		const value = parseNutrientNumber(textOf(cell.querySelector('.cbo_nn_SecondaryNutrient')));
		if (/calories from fat/i.test(text)) nutrients.calFromFat = value.value;
		else if (/calories/i.test(text)) nutrients.calories = value.value;
	}

	// Every other nutrient is a row of [name, amount, %DV]. Matching on the row
	// label rather than on position keeps this working when upstream reorders
	// or omits a row.
	for (const row of root.querySelectorAll('tr')) {
		const cells = row.querySelectorAll('td');
		if (cells.length < 2) continue;

		const label = textOf(cells[0]).toLowerCase().replace(/[:*]/g, '').trim();
		const field = NUTRIENT_ROWS[label];
		if (!field) continue;
		// A row whose first cell nests more cells is a container, not a data row.
		if (cells[0].querySelector('td')) continue;

		const parsed = parseNutrientNumber(textOf(cells[1]));
		(nutrients[field] as number | null) = parsed.value;
		if (field === 'fiberG') nutrients.fiberIsLessThan = parsed.isLessThan;
	}

	const ingredientsText = textOf(root.querySelector('.cbo_nn_LabelIngredients')) || null;
	// Components are split from the BODY, so an advisory clause does not become a
	// phantom recipe component on the item page.
	const split = ingredientsText
		? splitIngredientAdvisory(ingredientsText)
		: { body: null, advisory: null };
	const components = split.body ? parseComponents(split.body) : [];

	const containsText = textOf(root.querySelector('.cbo_nn_LabelAllergens'));
	const contains = containsText
		.split(',')
		.map((a) => a.trim())
		.filter((a) => a !== '');

	// Hash the meaning, not the markup: upstream regenerates whitespace and
	// element ids per request, so hashing raw HTML would defeat the dedupe.
	const contentHash = createHash('sha256')
		.update(
			JSON.stringify([name, servingSizeText, servingGrams, nutrients, ingredientsText, contains])
		)
		.digest('hex');

	return {
		name,
		servingSizeText,
		servingGrams,
		nutrients,
		ingredientsText,
		components,
		contains,
		contentHash
	};
}
