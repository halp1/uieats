/**
 * Persisting nutrition labels.
 *
 * Every menu_item gets its own real label fetch, but identical labels collapse
 * onto one content-addressed `nutrition_fact` row -- roughly 31k instances
 * become ~3k stored facts. Allergen matching then runs once per distinct
 * label rather than once per instance.
 *
 * Only the authoritative "Contains:" mapping happens here. Ingredient-text and
 * item-name inference live in allergens/match.ts, because they carry lower
 * confidence and need the full alias table with its negative prefixes.
 */
import { hiddenSourceTerms, matchIngredients } from '../../allergens/match.ts';
import type { Db } from '../../db/driver.ts';
import type { ParsedLabel } from '../parse/nutrition-label.ts';

export interface PersistLabelResult {
	nutritionFactId: number;
	/** False when an identical label was already stored under this hash. */
	created: boolean;
}

/** Resolves a "Contains:" token to an allergen id via the seeded aliases. */
function allergenIdForContains(db: Db, token: string): number | null {
	const row = db
		.prepare<{ allergen_id: number }>(
			"SELECT allergen_id FROM allergen_alias WHERE match_kind = 'contains' AND alias = ?"
		)
		.get(token.trim().toLowerCase());
	return row?.allergen_id ?? null;
}

export function persistLabel(db: Db, label: ParsedLabel, now: number): PersistLabelResult {
	return db.transaction(() => {
		const existing = db
			.prepare<{ id: number }>('SELECT id FROM nutrition_fact WHERE content_hash = ?')
			.get(label.contentHash);
		if (existing) return { nutritionFactId: existing.id, created: false };

		const n = label.nutrients;
		const id = db
			.prepare(
				`INSERT INTO nutrition_fact (
					content_hash, serving_size_text, serving_grams,
					calories, cal_from_fat, total_fat_g, sat_fat_g, trans_fat_g, poly_fat_g, mono_fat_g,
					cholesterol_mg, sodium_mg, potassium_mg, total_carb_g,
					fiber_g, fiber_is_lt, sugars_g, protein_g,
					vit_a_dv, vit_c_dv, calcium_dv, iron_dv,
					ingredients_text, contains_text, first_seen_at, hidden_sources
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				label.contentHash,
				label.servingSizeText,
				label.servingGrams,
				n.calories,
				n.calFromFat,
				n.totalFatG,
				n.satFatG,
				n.transFatG,
				n.polyFatG,
				n.monoFatG,
				n.cholesterolMg,
				n.sodiumMg,
				n.potassiumMg,
				n.totalCarbG,
				n.fiberG,
				n.fiberIsLessThan ? 1 : 0,
				n.sugarsG,
				n.proteinG,
				n.vitADv,
				n.vitCDv,
				n.calciumDv,
				n.ironDv,
				label.ingredientsText,
				label.contains.join(', '),
				now,
				hiddenSourceTerms(label.ingredientsText).join('|') || null
			).lastInsertRowid;

		for (const [i, component] of label.components.entries()) {
			db.prepare(
				`INSERT INTO recipe_ingredient (nutrition_fact_id, sort, component_name, ingredient_text)
				 VALUES (?, ?, ?, ?)`
			).run(id, i, component.componentName, component.ingredientText);
		}

		// "Contains:" is upstream's own declaration, so it is recorded at the
		// highest confidence we ever assign.
		const declaredIds = new Set<number>();
		for (const token of label.contains) {
			const allergenId = allergenIdForContains(db, token);
			if (allergenId === null) continue;
			declaredIds.add(allergenId);
			db.prepare(
				`INSERT OR IGNORE INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
				 VALUES (?, ?, 'contains', 'declared', ?)`
			).run(id, allergenId, `Contains: ${token}`);
		}

		// Then the inferred pass, which runs once per DISTINCT label rather than
		// once per instance -- that is the whole reason nutrition_fact is
		// content-addressed. The declared ids go in so that a species found
		// beneath an already-declared group ("Tree Nuts" -> MACADAMIA NUTS) is
		// rated `likely` rather than treated as a speculative new finding.
		if (label.ingredientsText) {
			for (const match of matchIngredients(db, label.ingredientsText, declaredIds)) {
				// An allergen upstream already declared needs no weaker duplicate.
				if (declaredIds.has(match.allergenId)) continue;
				db.prepare(
					`INSERT OR IGNORE INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
					 VALUES (?, ?, 'ingredient', ?, ?)`
				).run(id, match.allergenId, match.confidence, `ingredients: ${match.evidence}`);
			}
		}

		return { nutritionFactId: id, created: true };
	});
}

/** Links a fetched label to the menu_item it was fetched for. */
export function attachLabelToMenuItem(
	db: Db,
	menuItemId: number,
	nutritionFactId: number,
	now: number
): void {
	db.prepare('UPDATE menu_item SET nutrition_fact_id = ?, label_fetched_at = ? WHERE id = ?').run(
		nutritionFactId,
		now,
		menuItemId
	);
}

export interface PendingLabel {
	menu_item_id: number;
	detail_oid: number;
	menu_oid: number;
	/** Needed to re-select the menu: the label endpoint is session-stateful. */
	unit_nn_oid: number;
	service_date: string;
	item_id: number;
	serving_size_norm: string;
}

/**
 * The backfill queue: instances with no label yet, soonest service date first
 * so the meals a user is about to look at get facts before distant ones.
 */
export function pendingLabels(db: Db, limit: number, notBefore: string): PendingLabel[] {
	// Ordered by menu so the caller can select each menu once and then fetch all
	// of its labels; the endpoint only answers for the currently-selected menu.
	//
	// `notBefore` excludes menus upstream has already retired. It answers 0 bytes
	// for those (measured), and because this queue is ordered by service_date ASC
	// they would sort to the very front -- so every run would begin by failing on
	// work that can never succeed. Pruning removes most of them; this makes the
	// queue correct even in the window between a date retiring and the next
	// prune, and for anything a narrower run left behind.
	return db
		.prepare<PendingLabel>(
			`SELECT mi.id            AS menu_item_id,
			        mi.nn_detail_oid AS detail_oid,
			        m.nn_oid         AS menu_oid,
			        u.nn_oid         AS unit_nn_oid,
			        m.service_date   AS service_date,
			        mi.item_id       AS item_id,
			        COALESCE(mi.serving_size_norm, '') AS serving_size_norm
			 FROM menu_item mi
			 JOIN menu m ON m.id = mi.menu_id
			 JOIN unit u ON u.id = m.unit_id
			 WHERE mi.label_fetched_at IS NULL AND m.service_date >= ?
			 ORDER BY m.service_date ASC, m.nn_oid ASC, mi.sort ASC
			 LIMIT ?`
		)
		.all(notBefore, limit);
}

/**
 * In dedupe mode, one label per normalized (item, serving size) is enough;
 * every other instance of the same dish reuses it without a fetch.
 */
export function reuseLabelForMatchingItems(
	db: Db,
	itemId: number,
	servingSizeNorm: string,
	nutritionFactId: number,
	now: number
): number {
	return db
		.prepare(
			`UPDATE menu_item SET nutrition_fact_id = ?, label_fetched_at = ?
			 WHERE item_id = ? AND COALESCE(serving_size_norm, '') = ? AND label_fetched_at IS NULL`
		)
		.run(nutritionFactId, now, itemId, servingSizeNorm).changes;
}
