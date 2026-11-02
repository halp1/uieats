/**
 * Compact JSON views of the query results, for an agent to read.
 *
 * Every allergen answer goes through `verdictView`, so the only words an agent
 * ever sees for a verdict are the ones `verdict.ts` produced. Nothing here may
 * restate a verdict in its own vocabulary: the distance between "not declared"
 * and "safe" is the whole product, and a summary written for convenience is
 * exactly where that distance would quietly collapse.
 */
import type { ItemAllergenSummary, VerdictResult } from '../allergens/verdict.ts';
import type { NutritionFacts } from '../queries/items.ts';
import type { TraitView } from '../queries/menus.ts';

/**
 * Attached to every personalised answer. An agent relaying results must be
 * able to see the same caveat the site prints on every page.
 */
export const CROSS_CONTACT_NOTICE =
	'Allergen results come from university label data. They cannot account for cross-contact from ' +
	'shared fryers, grills or serving utensils, and a dish with no warning has not been confirmed to ' +
	'lack an allergen. Anyone with a severe allergy should confirm with dining staff.';

export function verdictView(v: VerdictResult) {
	return {
		allergen: v.allergen.slug,
		label: v.chipLabel,
		verdict: v.verdict,
		warning: v.isWarning,
		basis: v.basis,
		evidence: v.evidence.map((e) => `${e.source}: ${e.text}`),
		advisory: v.advisory
	};
}

export function summaryView(summary: ItemAllergenSummary | null | undefined) {
	if (!summary) return null;
	return {
		hasWarning: summary.hasWarning,
		hasUnknown: summary.hasUnknown,
		allChecked: summary.allChecked,
		worst: summary.worst?.verdict ?? null,
		verdicts: summary.verdicts.map(verdictView)
	};
}

export function traitSlugs(traits: TraitView[]): { diet: string[]; allergen: string[] } {
	return {
		diet: traits.filter((t) => t.isDiet).map((t) => t.slug),
		allergen: traits.filter((t) => !t.isDiet).map((t) => t.slug)
	};
}

export function nutritionView(n: NutritionFacts | null) {
	if (!n) return null;
	return {
		servingSize: n.servingSizeText,
		servingGrams: n.servingGrams,
		calories: n.calories,
		totalFatG: n.totalFatG,
		satFatG: n.satFatG,
		transFatG: n.transFatG,
		cholesterolMg: n.cholesterolMg,
		sodiumMg: n.sodiumMg,
		totalCarbG: n.totalCarbG,
		fiberG: n.fiberIsLessThan ? '<1' : n.fiberG,
		sugarsG: n.sugarsG,
		proteinG: n.proteinG,
		ingredients: n.ingredientsText,
		contains: n.containsText,
		mayContain: n.mayContainText,
		umbrellaTerms: n.hiddenSources
	};
}
