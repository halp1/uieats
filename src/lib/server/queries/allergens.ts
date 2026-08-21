/**
 * Turning stored rows into verdict inputs.
 *
 * This is the seam between the database and `allergens/verdict.ts`. It gathers
 * the four kinds of evidence -- grid traits, the label's Contains: line,
 * ingredient-text hits, item-name hits -- rolls each one up to whichever
 * allergen the user actually selected, and hands the result to `verdictFor`.
 *
 * The rollup is the reason a group selection works at all: a user who selects
 * "Tree Nuts" gets a hit on MACADAMIA NUTS, because the closure below expands
 * their selection to every descendant. It runs as one recursive query for the
 * whole selection, not one per allergen.
 *
 * Every function here is set-based over a batch of menu_item ids. A hall-day is
 * ~150 items and gets five statements total.
 */
import {
	summarizeItem,
	type AllergenRef,
	type EvidenceItem,
	type EvidenceSource,
	type ItemAllergenSummary,
	type VerdictInput
} from '../allergens/verdict.ts';
import { findMatch } from '../allergens/match.ts';
import type { Db } from '../db/driver.ts';
import { splitIngredientAdvisory } from '../scraper/parse/nutrition-label.ts';
import { groupBy, selectByIds } from './sql.ts';

export interface AllergenSelection {
	ref: AllergenRef;
	severity: 'avoid' | 'severe';
	/** The allergen itself plus every descendant. Evidence for any of these counts. */
	memberIds: Set<number>;
}

interface AllergenRow {
	id: number;
	slug: string;
	label: string;
	kind: string;
	covered_by_trait_vocabulary: number;
	parent_id: number | null;
	sort: number;
}

export interface AllergenTreeNode extends AllergenRef {
	kind: 'group' | 'leaf' | 'diet';
	parentId: number | null;
	children: AllergenTreeNode[];
}

function toRef(row: AllergenRow): AllergenRef {
	return {
		id: row.id,
		slug: row.slug,
		label: row.label,
		coveredByTraitVocabulary: row.covered_by_trait_vocabulary === 1
	};
}

/** Every non-diet allergen, nested, for the settings picker. */
export function getAllergenTree(db: Db): AllergenTreeNode[] {
	const rows = db
		.prepare<AllergenRow>(
			`SELECT id, slug, label, kind, covered_by_trait_vocabulary, parent_id, sort
			 FROM allergen WHERE kind <> 'diet' ORDER BY sort`
		)
		.all();

	const nodes = new Map<number, AllergenTreeNode>();
	for (const row of rows) {
		nodes.set(row.id, {
			...toRef(row),
			kind: row.kind as 'group' | 'leaf',
			parentId: row.parent_id,
			children: []
		});
	}

	const roots: AllergenTreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

/** The diet tags, which are filters and never warnings. */
export function getDietTags(db: Db): AllergenRef[] {
	return db
		.prepare<AllergenRow>(
			`SELECT id, slug, label, kind, covered_by_trait_vocabulary, parent_id, sort
			 FROM allergen WHERE kind = 'diet' ORDER BY sort`
		)
		.all()
		.map(toRef);
}

/**
 * What the user asked to be warned about, each expanded to its descendants.
 *
 * `kind = 'diet'` is excluded structurally rather than by convention: a diet
 * tag reaching verdictFor would render "Vegan" as a warning chip, which is
 * both wrong and alarming.
 */
export function getAllergenSelection(db: Db, userId: number | null): AllergenSelection[] {
	if (userId === null) return [];

	const rows = db
		.prepare<AllergenRow & { severity: string; selected_id: number }>(
			`WITH RECURSIVE selected(id) AS (
			   SELECT allergen_id FROM user_allergen WHERE user_id = ?
			 ),
			 closure(root, id) AS (
			   SELECT id, id FROM selected
			   UNION
			   SELECT c.root, a.id FROM allergen a JOIN closure c ON a.parent_id = c.id
			 )
			 SELECT c.root AS selected_id, c.id AS id,
			        a.slug, a.label, a.kind, a.covered_by_trait_vocabulary, a.parent_id, a.sort,
			        ua.severity
			 FROM closure c
			 JOIN allergen a ON a.id = c.root
			 JOIN user_allergen ua ON ua.allergen_id = c.root AND ua.user_id = ?
			 WHERE a.kind <> 'diet'
			 ORDER BY a.sort`
		)
		.all(userId, userId);

	const out = new Map<number, AllergenSelection>();
	for (const row of rows) {
		let entry = out.get(row.selected_id);
		if (!entry) {
			entry = {
				ref: toRef({ ...row, id: row.selected_id }),
				severity: row.severity === 'severe' ? 'severe' : 'avoid',
				memberIds: new Set()
			};
			out.set(row.selected_id, entry);
		}
		entry.memberIds.add(row.id);
	}
	return [...out.values()];
}

export interface CustomAllergen {
	/**
	 * Negative, always. `user_custom_allergen.id` and `allergen.id` are separate
	 * autoincrements and would otherwise collide, and these two never mean the
	 * same thing.
	 */
	id: number;
	label: string;
	terms: string[];
}

/**
 * What a user has registered, seeded and custom.
 *
 * Bundled so the four places that resolve verdicts cannot pick up one half and
 * forget the other -- a custom allergen silently not being checked is the worst
 * possible failure for this feature.
 */
export interface AllergenProfile {
	selection: AllergenSelection[];
	custom: CustomAllergen[];
}

export function getCustomAllergens(db: Db, userId: number | null): CustomAllergen[] {
	if (userId === null) return [];
	return db
		.prepare<{ id: number; label: string; terms: string }>(
			'SELECT id, label, terms FROM user_custom_allergen WHERE user_id = ? ORDER BY label'
		)
		.all(userId)
		.map((row) => ({
			id: -row.id,
			label: row.label,
			terms: row.terms
				.split('|')
				.map((t) => t.trim())
				.filter((t) => t !== '')
		}));
}

export function getAllergenProfile(db: Db, userId: number | null): AllergenProfile {
	return {
		selection: getAllergenSelection(db, userId),
		custom: getCustomAllergens(db, userId)
	};
}

/** True when nothing is registered, so the browse pages render no chips. */
export function isEmptyProfile(profile: AllergenProfile): boolean {
	return profile.selection.length === 0 && profile.custom.length === 0;
}

interface FactRow {
	menu_item_id: number;
	item_id: number;
	nutrition_fact_id: number | null;
	label_fetched_at: number | null;
	has_ingredients: number;
	hidden_sources: string | null;
}

interface FactTextRow {
	id: number;
	ingredients_text: string | null;
	may_contain_text: string | null;
}

interface EvidenceRow {
	menu_item_id: number;
	allergen_id: number;
	slug: string;
	label: string;
	source: string;
	evidence: string | null;
}

/**
 * Per-item allergen summaries for a batch of menu_items.
 *
 * Five statements regardless of batch size. Anonymous users (empty selection)
 * short-circuit to an empty map, which is what makes the browse pages render
 * no chips at all rather than chips with nothing in them.
 */
export function getItemVerdicts(
	db: Db,
	profile: AllergenProfile,
	menuItemIds: readonly number[]
): Map<number, ItemAllergenSummary> {
	const { selection, custom } = profile;
	const summaries = new Map<number, ItemAllergenSummary>();
	if (isEmptyProfile(profile) || menuItemIds.length === 0) return summaries;

	const facts = selectByIds<FactRow>(
		db,
		(list) => `SELECT mi.id AS menu_item_id, mi.item_id, mi.nutrition_fact_id, mi.label_fetched_at,
		                  CASE WHEN nf.ingredients_text IS NOT NULL AND TRIM(nf.ingredients_text) <> ''
		                       THEN 1 ELSE 0 END AS has_ingredients,
		                  nf.hidden_sources
		           FROM menu_item mi
		           LEFT JOIN nutrition_fact nf ON nf.id = mi.nutrition_fact_id
		           WHERE mi.id IN (${list})`,
		menuItemIds
	);

	// Grid traits: known from the menu scrape alone, so these are the evidence
	// that exists before any label has been fetched.
	const traitRows = selectByIds<EvidenceRow>(
		db,
		// The evidence string is a sentence, not a label: it is shown verbatim as
		// the reason for a warning, and "Fish" on its own explains nothing.
		(list) => `SELECT mit.menu_item_id, ta.allergen_id, a.slug, a.label,
		                  'trait' AS source,
		                  'Tagged ' || t.label || ' on the university''s menu row' AS evidence
		           FROM menu_item_trait mit
		           JOIN trait t ON t.id = mit.trait_id
		           JOIN trait_allergen ta ON ta.trait_id = t.id
		           JOIN allergen a ON a.id = ta.allergen_id
		           WHERE mit.menu_item_id IN (${list}) AND t.is_diet = 0`,
		menuItemIds
	);

	// Label-derived evidence, joined back through the menu_item so a shared
	// content-addressed fact fans out to every instance using it.
	const labelRows = selectByIds<EvidenceRow>(
		db,
		(list) => `SELECT mi.id AS menu_item_id, na.allergen_id, a.slug, a.label,
		                  na.source, na.evidence
		           FROM menu_item mi
		           JOIN nutrition_allergen na ON na.nutrition_fact_id = mi.nutrition_fact_id
		           JOIN allergen a ON a.id = na.allergen_id
		           WHERE mi.id IN (${list})`,
		menuItemIds
	);

	const nameRows = selectByIds<EvidenceRow>(
		db,
		(list) => `SELECT mi.id AS menu_item_id, ia.allergen_id, a.slug, a.label,
		                  'name' AS source, ia.evidence
		           FROM menu_item mi
		           JOIN item_allergen ia ON ia.item_id = mi.item_id
		           JOIN allergen a ON a.id = ia.allergen_id
		           WHERE mi.id IN (${list})`,
		menuItemIds
	);

	const evidenceByItem = groupBy([...traitRows, ...labelRows, ...nameRows], (r) => r.menu_item_id);

	// Custom allergens are matched HERE rather than at scrape time, because a user
	// can add one at any moment and re-deriving 28,000 stored labels on a settings
	// save is not an option. The cost is one extra statement, and only when the
	// user actually has custom allergens -- the ingredient text is loaded once per
	// distinct label, not once per dish.
	const textByFact = new Map<number, { body: string | null; advisory: string | null }>();
	if (custom.length > 0) {
		const factIds = [
			...new Set(facts.map((f) => f.nutrition_fact_id).filter((id): id is number => id !== null))
		];
		for (const row of selectByIds<FactTextRow>(
			db,
			(list) =>
				`SELECT id, ingredients_text, may_contain_text FROM nutrition_fact WHERE id IN (${list})`,
			factIds
		)) {
			// Split rather than trusting may_contain_text alone: the stored ingredient
			// text is verbatim and still holds the advisory, and a custom term must
			// not match an advisory clause as though it named an ingredient -- the
			// same mistake that made a plain dinner roll warn for tree nuts.
			const split = row.ingredients_text
				? splitIngredientAdvisory(row.ingredients_text)
				: { body: null, advisory: null };
			textByFact.set(row.id, {
				body: split.body,
				advisory: split.advisory ?? row.may_contain_text
			});
		}
	}

	/**
	 * Evidence for one custom allergen against one label.
	 *
	 * Ingredients first, advisory second, so a term appearing in both is reported
	 * as the stronger finding.
	 */
	const customEvidence = (entry: CustomAllergen, factId: number | null): EvidenceItem[] => {
		if (factId === null) return [];
		const text = textByFact.get(factId);
		if (!text) return [];

		for (const term of entry.terms) {
			const hit = text.body ? findMatch(text.body, term) : null;
			if (hit) {
				return [
					{
						source: 'ingredient',
						slug: `custom:${entry.id}`,
						label: entry.label,
						text: `ingredients: ${hit}`
					}
				];
			}
		}
		for (const term of entry.terms) {
			if (text.advisory && findMatch(text.advisory, term)) {
				return [
					{
						source: 'may-contain',
						slug: `custom:${entry.id}`,
						label: entry.label,
						text: text.advisory.replace(/\s+/g, ' ').trim().slice(0, 200)
					}
				];
			}
		}
		return [];
	};

	for (const fact of facts) {
		const rows = evidenceByItem.get(fact.menu_item_id) ?? [];
		const hiddenSources = fact.hidden_sources ? fact.hidden_sources.split('|') : [];

		const inputs: VerdictInput[] = selection.map((sel) => ({
			allergen: sel.ref,
			hasLabel: fact.label_fetched_at !== null,
			hasIngredientText: fact.has_ingredients === 1,
			// Roll the hit up to the selected allergen: a macadamia row counts as
			// evidence for a Tree Nuts selection.
			evidence: rows
				.filter((r) => sel.memberIds.has(r.allergen_id))
				.map((r): EvidenceItem => ({
					source: r.source as EvidenceSource,
					slug: r.slug,
					label: r.label,
					text: r.evidence ?? `${r.label} (${r.source})`
				})),
			hiddenSources
		}));

		for (const entry of custom) {
			inputs.push({
				// coveredByTraitVocabulary is false and cannot be otherwise: upstream
				// has no icon for a user's own allergen, so a missing icon says nothing
				// and an unlabelled dish is `unknown` rather than clear. That guarantee
				// is why custom allergens live in their own table.
				allergen: {
					id: entry.id,
					slug: `custom:${entry.id}`,
					label: entry.label,
					coveredByTraitVocabulary: false
				},
				hasLabel: fact.label_fetched_at !== null,
				hasIngredientText: fact.has_ingredients === 1,
				evidence: customEvidence(entry, fact.nutrition_fact_id),
				hiddenSources
			});
		}

		summaries.set(fact.menu_item_id, summarizeItem(inputs));
	}

	return summaries;
}
