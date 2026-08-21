#!/usr/bin/env node
/**
 * Re-derives inferred allergens from labels already stored, with no network.
 *
 * Two things make this necessary rather than nice to have:
 *
 *   * Matching runs at persist time, so a change to the matcher or to the
 *     `allergen_alias` table does not reach the back catalogue. Every label
 *     already fetched keeps whatever the old rules concluded.
 *   * `label_fetched_at` deliberately stops a label being fetched twice, so
 *     "just re-scrape" does not fix it either. The ingredient text is already
 *     on disk; the answer can be recomputed from it.
 *
 * What it rewrites: `may_contain_text`, and the `ingredient` / `may-contain`
 * rows of `nutrition_allergen`. What it leaves alone: the `contains` rows, which
 * come from upstream's own declaration and owe nothing to our matching.
 *
 *   node scripts/rematch-allergens.ts            -- rewrite everything
 *   node scripts/rematch-allergens.ts --dry-run  -- report, change nothing
 */
import {
	hiddenSourceTerms,
	matchAdvisory,
	matchIngredients
} from '../src/lib/server/allergens/match.ts';
import { getDb, resolveDatabasePath } from '../src/lib/server/db/index.ts';
import { splitIngredientAdvisory } from '../src/lib/server/scraper/parse/nutrition-label.ts';

const dryRun = process.argv.includes('--dry-run');
const db = getDb();

console.log(`database   ${resolveDatabasePath()}`);
console.log(`mode       ${dryRun ? 'dry run' : 'rewriting'}`);

interface FactRow {
	id: number;
	ingredients_text: string | null;
	contains_text: string | null;
}

const facts = db
	.prepare<FactRow>('SELECT id, ingredients_text, contains_text FROM nutrition_fact ORDER BY id')
	.all();

/** The ids upstream declared outright, so a species beneath one is `likely`. */
function declaredIdsFor(containsText: string | null): Set<number> {
	const ids = new Set<number>();
	for (const token of (containsText ?? '').split(',')) {
		const alias = token.trim().toLowerCase();
		if (!alias) continue;
		const row = db
			.prepare<{ allergen_id: number }>(
				"SELECT allergen_id FROM allergen_alias WHERE match_kind = 'contains' AND alias = ?"
			)
			.get(alias);
		if (row) ids.add(row.allergen_id);
	}
	return ids;
}

let advisoriesFound = 0;
let ingredientRows = 0;
let advisoryRows = 0;
let removedFromAdvisory = 0;

db.transaction(() => {
	for (const fact of facts) {
		const split = fact.ingredients_text
			? splitIngredientAdvisory(fact.ingredients_text)
			: { body: null, advisory: null };
		if (split.advisory) advisoriesFound++;

		// What the old rules concluded from the whole text, so the report can say
		// how many findings were actually wrong rather than just how many changed.
		const before = new Set(
			db
				.prepare<{ allergen_id: number }>(
					"SELECT allergen_id FROM nutrition_allergen WHERE nutrition_fact_id = ? AND source = 'ingredient'"
				)
				.all(fact.id)
				.map((r) => r.allergen_id)
		);

		const declared = declaredIdsFor(fact.contains_text);
		const fromBody = split.body ? matchIngredients(db, split.body, declared) : [];
		const fromAdvisory = split.advisory ? matchAdvisory(db, split.advisory) : [];

		for (const m of fromAdvisory) {
			// An allergen that WAS recorded as an ingredient and is now only in the
			// advisory is exactly the over-warning this fixes.
			if (before.has(m.allergenId) && !fromBody.some((b) => b.allergenId === m.allergenId)) {
				removedFromAdvisory++;
			}
		}

		if (dryRun) continue;

		db.prepare(
			'UPDATE nutrition_fact SET may_contain_text = ?, hidden_sources = ? WHERE id = ?'
		).run(split.advisory, hiddenSourceTerms(split.body).join('|') || null, fact.id);
		db.prepare(
			"DELETE FROM nutrition_allergen WHERE nutrition_fact_id = ? AND source IN ('ingredient', 'may-contain')"
		).run(fact.id);

		for (const m of fromBody) {
			if (declared.has(m.allergenId)) continue;
			db.prepare(
				`INSERT OR IGNORE INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
				 VALUES (?, ?, 'ingredient', ?, ?)`
			).run(fact.id, m.allergenId, m.confidence, `ingredients: ${m.evidence}`);
			ingredientRows++;
		}
		const advisoryEvidence = (split.advisory ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
		for (const m of fromAdvisory) {
			if (declared.has(m.allergenId)) continue;
			db.prepare(
				`INSERT OR IGNORE INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
				 VALUES (?, ?, 'may-contain', 'possible', ?)`
			).run(fact.id, m.allergenId, advisoryEvidence);
			advisoryRows++;
		}
	}
});

console.log(`\nlabels             ${facts.length}`);
console.log(`with an advisory   ${advisoriesFound}`);
console.log(`ingredient rows    ${ingredientRows}`);
console.log(`may-contain rows   ${advisoryRows}`);
console.log(
	`downgraded         ${removedFromAdvisory}   (was "contains this", now "may contain this")`
);
if (dryRun) console.log('\nnothing was written.');
