/**
 * The safety model's test suite.
 *
 * Everything visual in this app reads its severity from `verdictFor`. A bug
 * here is not a data bug -- it is a person eating something they told us they
 * cannot eat. So this file is exhaustive over the input space rather than
 * illustrative, and it ends with a property test asserting that no reachable
 * output ever reads as reassurance.
 */
import { describe, expect, it } from 'vitest';
import {
	NEVER_SAFE_PATTERN,
	type AllergenRef,
	type EvidenceItem,
	type VerdictInput,
	summarizeItem,
	verdictFor,
	worstVerdict
} from '../../src/lib/server/allergens/verdict.ts';

/** Milk: one of the 18 upstream tags on every item row. */
const MILK: AllergenRef = {
	id: 1,
	slug: 'milk',
	label: 'Milk',
	coveredByTraitVocabulary: true
};

/** Mustard: upstream has no vocabulary for it at all. */
const MUSTARD: AllergenRef = {
	id: 54,
	slug: 'mustard',
	label: 'Mustard',
	coveredByTraitVocabulary: false
};

const TREE_NUTS: AllergenRef = {
	id: 14,
	slug: 'tree-nuts',
	label: 'Tree Nuts',
	coveredByTraitVocabulary: true
};

function input(over: Partial<VerdictInput> = {}): VerdictInput {
	return {
		allergen: MILK,
		hasLabel: true,
		hasIngredientText: true,
		evidence: [],
		hiddenSources: [],
		...over
	};
}

const traitHit: EvidenceItem = {
	source: 'trait',
	slug: 'milk',
	label: 'Milk',
	text: 'Milk trait icon on the menu row'
};
const containsHit: EvidenceItem = {
	source: 'contains',
	slug: 'milk',
	label: 'Milk',
	text: 'Contains: Milk'
};

describe('declared evidence', () => {
	it('flags a trait icon as declared even before any label is fetched', () => {
		// The icon lives on the item grid row, so it is known from the menu
		// scrape alone. Waiting for a label to believe it would hide a real
		// warning for hours.
		const r = verdictFor(input({ hasLabel: false, evidence: [traitHit] }));
		expect(r.verdict).toBe('flagged-declared');
		expect(r.isWarning).toBe(true);
	});

	it('flags a Contains: line as declared', () => {
		expect(verdictFor(input({ evidence: [containsHit] })).verdict).toBe('flagged-declared');
	});

	it('carries the evidence string so the claim can be audited', () => {
		const r = verdictFor(input({ evidence: [containsHit] }));
		expect(r.basis).toContain('Contains: Milk');
		expect(r.evidence).toHaveLength(1);
	});

	it('outranks weaker evidence for the same allergen', () => {
		const r = verdictFor(
			input({
				evidence: [
					{ source: 'name', slug: 'milk', label: 'Milk', text: 'item name: Milkshake' },
					containsHit
				]
			})
		);
		expect(r.verdict).toBe('flagged-declared');
		// The weaker evidence is kept and still shown -- it is not wrong, just
		// less load-bearing.
		expect(r.evidence).toHaveLength(2);
		expect(r.evidence[0].source).toBe('contains');
	});
});

describe('inferred evidence', () => {
	it('rates an ingredient-text hit as likely', () => {
		const r = verdictFor(
			input({
				allergen: MUSTARD,
				evidence: [
					{
						source: 'ingredient',
						slug: 'mustard',
						label: 'Mustard',
						text: 'ingredients: MUSTARD SEED'
					}
				]
			})
		);
		expect(r.verdict).toBe('flagged-likely');
		expect(r.isWarning).toBe(true);
	});

	it('rates an item-name-only hit as possible', () => {
		const r = verdictFor(
			input({
				allergen: MUSTARD,
				hasLabel: false,
				hasIngredientText: false,
				evidence: [
					{ source: 'name', slug: 'mustard', label: 'Mustard', text: 'item name: Mustard Greens' }
				]
			})
		);
		expect(r.verdict).toBe('flagged-possible');
		expect(r.isWarning).toBe(true);
	});

	it('names the species when a group hit came from a descendant', () => {
		// This is the feature the whole app exists for: upstream says "Tree
		// Nuts", the ingredient prose says which one.
		const r = verdictFor(
			input({
				allergen: TREE_NUTS,
				evidence: [
					{
						source: 'ingredient',
						slug: 'macadamia',
						label: 'Macadamia',
						text: 'ingredients: MACADAMIA NUTS'
					}
				]
			})
		);
		expect(r.chipLabel).toBe('Tree Nuts — Macadamia');
		expect(r.verdict).toBe('flagged-likely');
	});

	it('does not append a species when the hit is the queried allergen itself', () => {
		expect(verdictFor(input({ evidence: [containsHit] })).chipLabel).toBe('Milk');
	});
});

describe('the no-label invariant', () => {
	it('is unknown for an allergen outside upstream vocabulary with no label', () => {
		const r = verdictFor(input({ allergen: MUSTARD, hasLabel: false, hasIngredientText: false }));
		expect(r.verdict).toBe('unknown');
	});

	it('is no-declared for a covered allergen with no label', () => {
		// Upstream tags all 18 of these on the row itself, so a missing icon is
		// weak evidence -- enough for gray, never enough for reassurance.
		const r = verdictFor(input({ allergen: MILK, hasLabel: false, hasIngredientText: false }));
		expect(r.verdict).toBe('no-declared');
	});

	it('is unknown when a label exists but carries no ingredient list', () => {
		// Some labels have nutrients and nothing else. For mustard that means
		// the one place it could have appeared was never populated.
		const r = verdictFor(input({ allergen: MUSTARD, hasLabel: true, hasIngredientText: false }));
		expect(r.verdict).toBe('unknown');
	});

	it('is no-declared once a label with ingredients found nothing', () => {
		const r = verdictFor(input({ allergen: MUSTARD, hasLabel: true, hasIngredientText: true }));
		expect(r.verdict).toBe('no-declared');
	});

	it('covers every (hasLabel, hasTraits, covered) combination', () => {
		const seen = new Map<string, string>();
		for (const hasLabel of [false, true]) {
			for (const hasTraits of [false, true]) {
				for (const covered of [false, true]) {
					const allergen = covered ? MILK : MUSTARD;
					const r = verdictFor(
						input({
							allergen,
							hasLabel,
							hasIngredientText: hasLabel,
							evidence: hasTraits
								? [{ source: 'trait', slug: allergen.slug, label: allergen.label, text: 'trait' }]
								: []
						})
					);
					seen.set(`${hasLabel}/${hasTraits}/${covered}`, r.verdict);
				}
			}
		}

		expect(Object.fromEntries(seen)).toEqual({
			// A trait icon is declared evidence in every combination.
			'false/true/false': 'flagged-declared',
			'false/true/true': 'flagged-declared',
			'true/true/false': 'flagged-declared',
			'true/true/true': 'flagged-declared',
			// No evidence, no label: only the 18 covered allergens may soften.
			'false/false/false': 'unknown',
			'false/false/true': 'no-declared',
			// No evidence, label read: nothing found in either source.
			'true/false/false': 'no-declared',
			'true/false/true': 'no-declared'
		});
	});
});

describe('hidden-source advisories', () => {
	it('attaches an advisory when an unflagged label hides its sources', () => {
		const r = verdictFor(input({ allergen: MUSTARD, hiddenSources: ['SPICES', 'NATURAL FLAVOR'] }));
		expect(r.verdict).toBe('no-declared');
		expect(r.advisory).toContain('SPICES');
	});

	it('does not bother with an advisory once the allergen is already flagged', () => {
		const r = verdictFor(
			input({
				evidence: [containsHit],
				hiddenSources: ['SPICES']
			})
		);
		expect(r.advisory).toBeNull();
	});
});

describe('rolling an item up', () => {
	const flagged = input({ evidence: [containsHit] });
	const unverified = input({ allergen: MUSTARD, hasLabel: false, hasIngredientText: false });
	const clear = input({ allergen: TREE_NUTS, hasLabel: true, hasIngredientText: true });

	it('reports the strongest verdict for the row', () => {
		expect(worstVerdict([clear, unverified, flagged].map(verdictFor))?.verdict).toBe(
			'flagged-declared'
		);
	});

	it('prefers unverified over no-declared, because it needs attention', () => {
		expect(worstVerdict([clear, unverified].map(verdictFor))?.verdict).toBe('unknown');
	});

	it('returns null for an item with nothing to say', () => {
		expect(worstVerdict([])).toBeNull();
	});

	it('sorts an item summary strongest-first', () => {
		const summary = summarizeItem([clear, unverified, flagged]);
		expect(summary.verdicts.map((v) => v.verdict)).toEqual([
			'flagged-declared',
			'unknown',
			'no-declared'
		]);
		expect(summary.worst?.verdict).toBe('flagged-declared');
		expect(summary.hasWarning).toBe(true);
		expect(summary.hasUnknown).toBe(true);
	});

	it('does not claim an item is clear when any allergen is unverified', () => {
		const summary = summarizeItem([clear, unverified]);
		expect(summary.hasWarning).toBe(false);
		expect(summary.hasUnknown).toBe(true);
		// The whole point: "no warnings" and "checked" are different claims.
		expect(summary.allChecked).toBe(false);
	});

	it('reports allChecked only when every allergen was actually resolved', () => {
		expect(summarizeItem([clear]).allChecked).toBe(true);
	});
});

describe('property: nothing ever reads as safe', () => {
	// Generated over the entire input space rather than a chosen sample. If any
	// future edit introduces a reassuring string on any path, this fails.
	const allergens = [MILK, MUSTARD, TREE_NUTS];
	const evidenceOptions: EvidenceItem[][] = [
		[],
		[traitHit],
		[containsHit],
		[
			{
				source: 'ingredient',
				slug: 'macadamia',
				label: 'Macadamia',
				text: 'ingredients: MACADAMIA'
			}
		],
		[{ source: 'name', slug: 'mustard', label: 'Mustard', text: 'item name: Mustard' }]
	];

	const allInputs: VerdictInput[] = [];
	for (const allergen of allergens) {
		for (const hasLabel of [false, true]) {
			for (const hasIngredientText of [false, true]) {
				for (const evidence of evidenceOptions) {
					for (const hiddenSources of [[], ['SPICES']]) {
						allInputs.push({ allergen, hasLabel, hasIngredientText, evidence, hiddenSources });
					}
				}
			}
		}
	}

	it('generates a wide input space', () => {
		expect(allInputs.length).toBe(3 * 2 * 2 * 5 * 2);
	});

	it('never emits a word a person could read as "safe to eat"', () => {
		for (const i of allInputs) {
			const r = verdictFor(i);
			const text = [r.chipLabel, r.basis, r.advisory ?? ''].join(' | ');
			expect(
				NEVER_SAFE_PATTERN.test(text),
				`"${text}" reads as reassurance for ${i.allergen.slug}`
			).toBe(false);
		}
	});

	it('never returns a non-warning verdict for declared evidence', () => {
		for (const i of allInputs) {
			const r = verdictFor(i);
			const declared = i.evidence.some((e) => e.source === 'trait' || e.source === 'contains');
			if (declared) expect(r.verdict).toBe('flagged-declared');
		}
	});

	it('never returns no-declared without having read something', () => {
		// no-declared is the only verdict that could be mistaken for an
		// all-clear, so it must always rest on an actual observation: either a
		// fetched ingredient list, or membership in the trait vocabulary.
		for (const i of allInputs) {
			const r = verdictFor(i);
			if (r.verdict === 'no-declared') {
				expect(
					i.allergen.coveredByTraitVocabulary || (i.hasLabel && i.hasIngredientText),
					`no-declared with nothing read for ${i.allergen.slug}`
				).toBe(true);
			}
		}
	});

	it('always explains itself', () => {
		for (const i of allInputs) {
			const r = verdictFor(i);
			expect(r.basis.length).toBeGreaterThan(10);
			expect(r.chipLabel.length).toBeGreaterThan(0);
		}
	});
});
