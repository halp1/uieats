/**
 * Ingredient-text and item-name allergen matching.
 *
 * Scope is deliberately narrow. Upstream's "Contains:" line is authoritative
 * for the 18 allergens in its own vocabulary, and the item-grid trait icons
 * agree with it exactly (verified across 10 venues). Re-deriving milk or soy
 * from ingredient prose would add false positives and no information.
 *
 * So free-text matching runs only where upstream tells us nothing:
 *   1. resolving a declared GROUP to a species -- "Tree Nuts" -> MACADAMIA NUTS
 *   2. allergens outside upstream's vocabulary -- mustard, celery, lupin
 *
 * The false positives are the whole difficulty. "nutmeg", "nutritional yeast",
 * "butternut squash" and "water chestnut" must not read as tree nuts; "cocoa
 * butter" and "peanut butter" must not read as milk. That is what
 * negative_prefixes and the refusal to ever alias a bare "nut" are for.
 */
import type { Db } from '../db/driver.ts';

export type MatchSource = 'ingredient' | 'name';
export type Confidence = 'declared' | 'likely' | 'possible';

export interface AllergenMatch {
	allergenId: number;
	slug: string;
	source: MatchSource;
	confidence: Confidence;
	/** The exact substring that matched, so a user can audit the claim. */
	evidence: string;
}

interface AliasRow {
	allergen_id: number;
	slug: string;
	alias: string;
	match_kind: string;
	requires_word_boundary: number;
	negative_prefixes: string | null;
}

function loadAliases(db: Db, kind: MatchSource): AliasRow[] {
	return db
		.prepare<AliasRow>(
			`SELECT aa.allergen_id, a.slug, aa.alias, aa.match_kind,
			        aa.requires_word_boundary, aa.negative_prefixes
			 FROM allergen_alias aa
			 JOIN allergen a ON a.id = aa.allergen_id
			 WHERE aa.match_kind = ?
			 ORDER BY LENGTH(aa.alias) DESC`
		)
		.all(kind);
}

/**
 * True when `alias` occurs in `haystack` and is not vetoed by a preceding word.
 *
 * The veto is what separates "butter" (milk) from "cocoa butter" (not milk),
 * and "chestnut" (a tree nut) from "water chestnut" (an aquatic vegetable).
 */
function findMatch(
	haystack: string,
	alias: string,
	negativePrefixes: string | null
): string | null {
	const vetoes = negativePrefixes ? negativePrefixes.split('|').filter(Boolean) : [];
	const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Bound on non-letter explicitly rather than \b, and allow a plural suffix:
	// aliases are stored singular ("peanut") while labels say "Peanuts".
	const re = new RegExp(`(?<![a-z])${escaped}(?:es|s)?(?![a-z])`, 'gi');

	for (let m = re.exec(haystack); m !== null; m = re.exec(haystack)) {
		const before = haystack.slice(Math.max(0, m.index - 40), m.index);
		const vetoed = vetoes.some((v) => new RegExp(`(?<![a-z])${v}[\\s-]+$`, 'i').test(before));
		if (vetoed) continue;

		// "CASHEW-FREE SAUCE" and "nut free" advertise the ABSENCE of an
		// allergen. Reading them as a hit is the most galling kind of false
		// positive: the label is reassuring the very person we would alarm.
		const after = haystack.slice(m.index + m[0].length, m.index + m[0].length + 12);
		if (/^[\s-]*free\b/i.test(after)) continue;

		// A little context either side, so the UI can show why it flagged.
		const start = Math.max(0, m.index - 20);
		const end = Math.min(haystack.length, m.index + m[0].length + 20);
		return haystack.slice(start, end).trim();
	}
	return null;
}

/**
 * Allergens inferred from a label's ingredient prose.
 *
 * `declaredAllergenIds` are the ones upstream already stated; a species hit
 * beneath a declared group is `likely`, and a hit with no declaration behind
 * it is only `possible`.
 */
export function matchIngredients(
	db: Db,
	ingredientsText: string,
	declaredAllergenIds: Set<number> = new Set()
): AllergenMatch[] {
	if (!ingredientsText.trim()) return [];

	const matches: AllergenMatch[] = [];
	const seen = new Set<number>();

	for (const alias of loadAliases(db, 'ingredient')) {
		if (seen.has(alias.allergen_id)) continue;

		const evidence = findMatch(ingredientsText, alias.alias, alias.negative_prefixes);
		if (evidence === null) continue;

		seen.add(alias.allergen_id);

		// Is an ancestor of this allergen already declared? If upstream said
		// "Tree Nuts" and the prose says macadamia, that is a strong resolution
		// rather than a speculative new finding.
		const supported = db
			.prepare<{ c: number }>(
				`WITH RECURSIVE ancestors(id) AS (
				   SELECT ? UNION ALL
				   SELECT a.parent_id FROM allergen a JOIN ancestors an ON a.id = an.id
				   WHERE a.parent_id IS NOT NULL
				 )
				 SELECT COUNT(*) AS c FROM ancestors WHERE id IN (${[...declaredAllergenIds].map(() => '?').join(',') || 'NULL'})`
			)
			.get(alias.allergen_id, ...declaredAllergenIds);

		matches.push({
			allergenId: alias.allergen_id,
			slug: alias.slug,
			source: 'ingredient',
			confidence: (supported?.c ?? 0) > 0 ? 'likely' : 'possible',
			evidence
		});
	}

	return matches;
}

/** The weakest signal. May only ever add a warning, never clear one. */
export function matchItemName(db: Db, itemName: string): AllergenMatch[] {
	if (!itemName.trim()) return [];

	const matches: AllergenMatch[] = [];
	const seen = new Set<number>();

	for (const alias of loadAliases(db, 'name')) {
		if (seen.has(alias.allergen_id)) continue;
		const evidence = findMatch(itemName, alias.alias, alias.negative_prefixes);
		if (evidence === null) continue;

		seen.add(alias.allergen_id);
		matches.push({
			allergenId: alias.allergen_id,
			slug: alias.slug,
			source: 'name',
			confidence: 'possible',
			evidence
		});
	}

	return matches;
}

/**
 * Umbrella ingredient terms, which hide their own contents.
 *
 * "SPICES" and "NATURAL FLAVOR" are legally permitted collective names in the
 * US, so an allergen can sit inside one without ever being written down.
 * Treating them as hits would flag nearly every dish and train users to ignore
 * warnings; treating them as nothing would let "not found in the ingredients"
 * sound more conclusive than it is. So they are neither -- they become an
 * advisory attached to an unflagged verdict. See verdict.ts.
 */
const HIDDEN_SOURCE_TERMS = [
	'natural flavor',
	'natural flavour',
	'artificial flavor',
	'artificial flavour',
	'natural and artificial flavor',
	'flavoring',
	'flavouring',
	'spices',
	'spice blend',
	'seasoning',
	'seasoning blend',
	'modified food starch',
	'vegetable oil',
	'mono and diglycerides'
];

/** The umbrella terms present in a label's ingredient prose, as written. */
export function hiddenSourceTerms(ingredientsText: string | null | undefined): string[] {
	if (!ingredientsText) return [];

	const found: string[] = [];
	for (const term of HIDDEN_SOURCE_TERMS) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const m = new RegExp(`(?<![a-z])${escaped}(?:s|es)?(?![a-z])`, 'i').exec(ingredientsText);
		// Report it exactly as the label wrote it, so the advisory quotes the
		// source rather than paraphrasing it.
		if (m) found.push(m[0]);
	}

	// Longer terms subsume shorter ones: "SPICE BLEND" already covers "SPICE".
	return found.filter(
		(t) => !found.some((other) => other !== t && other.toLowerCase().includes(t.toLowerCase()))
	);
}
