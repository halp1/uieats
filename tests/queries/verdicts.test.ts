/**
 * The bridge between stored rows and the safety model.
 *
 * `verdict.test.ts` proves the rules are right given the evidence.
 * These tests prove the evidence actually arrives: that a trait row becomes
 * `trait` evidence, that a macadamia hit rolls up to a Tree Nuts selection,
 * that an unlabelled item reaches `verdictFor` with hasLabel false. A bug here
 * would be invisible to both sides -- correct rules fed nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import {
	getAllergenSelection,
	getAllergenTree,
	getDietTags,
	getItemVerdicts
} from '../../src/lib/server/queries/allergens.ts';

const NOW = 1_760_000_000;

let db: Db;
let userId: number;

beforeEach(() => {
	db = createMemoryDb();
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', NOW).lastInsertRowid;
});

function allergenId(slug: string): number {
	return db.prepare<{ id: number }>('SELECT id FROM allergen WHERE slug = ?').get(slug)!.id;
}

function select(...slugs: string[]) {
	for (const slug of slugs) {
		db.prepare(
			'INSERT INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
		).run(userId, allergenId(slug), 'avoid', NOW);
	}
	return getAllergenSelection(db, userId);
}

/** A minimal menu with one dish, so the verdict path can be driven end to end. */
function seedItem(options: { name?: string; withLabel?: boolean } = {}): number {
	const unitId = db
		.prepare(
			`INSERT INTO unit (nn_oid, parent_id, name, slug, kind, first_seen_at, last_seen_at)
			 VALUES (1, NULL, 'Test Venue', 'test', 'standalone', ?, ?)`
		)
		.run(NOW, NOW).lastInsertRowid;
	const menuId = db
		.prepare(
			`INSERT INTO menu (unit_id, service_date, meal, meal_sort, nn_oid, first_seen_at)
			 VALUES (?, '2026-08-21', 'Lunch', 30, 99, ?)`
		)
		.run(unitId, NOW).lastInsertRowid;
	const categoryId = db
		.prepare(
			`INSERT INTO menu_category (menu_id, nn_category_id, name, sort, scrape_run_id)
			 VALUES (?, 1, 'Entrees', 0, 1)`
		)
		.run(menuId).lastInsertRowid;
	const itemId = db
		.prepare('INSERT INTO item (name_norm, name_display, slug, first_seen_at) VALUES (?, ?, ?, ?)')
		.run(
			(options.name ?? 'test dish').toLowerCase(),
			options.name ?? 'Test Dish',
			'test-dish',
			NOW
		).lastInsertRowid;

	return db
		.prepare(
			`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, sort, scrape_run_id)
			 VALUES (?, ?, ?, 1000, 0, 1)`
		)
		.run(menuId, categoryId, itemId).lastInsertRowid;
}

function attachFact(
	menuItemId: number,
	fact: { ingredients?: string | null; contains?: string; hidden?: string | null }
): number {
	const factId = db
		.prepare(
			`INSERT INTO nutrition_fact (content_hash, ingredients_text, contains_text, hidden_sources, first_seen_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(
			`hash-${menuItemId}-${Math.trunc(Math.abs(menuItemId))}`,
			fact.ingredients ?? null,
			fact.contains ?? null,
			fact.hidden ?? null,
			NOW
		).lastInsertRowid;

	db.prepare('UPDATE menu_item SET nutrition_fact_id = ?, label_fetched_at = ? WHERE id = ?').run(
		factId,
		NOW,
		menuItemId
	);
	return factId;
}

function addTrait(menuItemId: number, traitLabel: string): void {
	const traitId = db
		.prepare<{ id: number }>('SELECT id FROM trait WHERE label = ?')
		.get(traitLabel)!.id;
	db.prepare('INSERT INTO menu_item_trait (menu_item_id, trait_id) VALUES (?, ?)').run(
		menuItemId,
		traitId
	);
}

describe('getAllergenSelection', () => {
	it('expands a group to every descendant', () => {
		const [treeNuts] = select('tree-nuts');
		expect(treeNuts.ref.slug).toBe('tree-nuts');
		// Ten species, plus the group itself.
		expect(treeNuts.memberIds.size).toBe(11);
		expect(treeNuts.memberIds.has(allergenId('macadamia'))).toBe(true);
	});

	it('expands two levels, so shellfish reaches oyster', () => {
		const [shellfish] = select('shellfish');
		// shellfish -> crustacean/mollusk -> species
		expect(shellfish.memberIds.has(allergenId('oyster'))).toBe(true);
		expect(shellfish.memberIds.has(allergenId('crustacean'))).toBe(true);
	});

	it('keeps a leaf selection to itself', () => {
		const [macadamia] = select('macadamia');
		expect([...macadamia.memberIds]).toEqual([allergenId('macadamia')]);
	});

	it('carries the SELECTED allergen coverage flag, not the descendant one', () => {
		// Tree Nuts is in upstream's vocabulary; macadamia is not. A Tree Nuts
		// selection must therefore be able to reach `no-declared`, and a
		// macadamia selection must not.
		const [treeNuts] = select('tree-nuts');
		expect(treeNuts.ref.coveredByTraitVocabulary).toBe(true);
	});

	it('excludes diet tags, which must never become warnings', () => {
		const selection = select('vegan', 'milk');
		expect(selection.map((s) => s.ref.slug)).toEqual(['milk']);
	});

	it('is empty for an anonymous visitor', () => {
		expect(getAllergenSelection(db, null)).toEqual([]);
	});
});

describe('getItemVerdicts', () => {
	it('returns nothing at all when no allergens are registered', () => {
		const menuItemId = seedItem();
		expect(getItemVerdicts(db, [], [menuItemId]).size).toBe(0);
	});

	it('turns a grid trait into declared evidence with no label present', () => {
		const menuItemId = seedItem();
		addTrait(menuItemId, 'Milk');

		const summary = getItemVerdicts(db, select('milk'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.verdict).toBe('flagged-declared');
		expect(summary.worst?.evidence[0].source).toBe('trait');
	});

	it('rolls a species hit up to the group the user selected', () => {
		// The whole product in one test: upstream declared "Tree Nuts", the prose
		// named macadamia, and the user asked about Tree Nuts.
		const menuItemId = seedItem();
		const factId = attachFact(menuItemId, { ingredients: 'SUGAR, MACADAMIA NUTS.' });
		db.prepare(
			`INSERT INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
			 VALUES (?, ?, 'ingredient', 'likely', 'ingredients: MACADAMIA NUTS')`
		).run(factId, allergenId('macadamia'));

		const summary = getItemVerdicts(db, select('tree-nuts'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.verdict).toBe('flagged-likely');
		expect(summary.worst?.chipLabel).toBe('Tree Nuts — Macadamia');
	});

	it('does not roll a sibling species up to an unrelated selection', () => {
		const menuItemId = seedItem();
		const factId = attachFact(menuItemId, { ingredients: 'SUGAR, MACADAMIA NUTS.' });
		db.prepare(
			`INSERT INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
			 VALUES (?, ?, 'ingredient', 'likely', 'ingredients: MACADAMIA NUTS')`
		).run(factId, allergenId('macadamia'));

		// A cashew allergy is not a macadamia allergy.
		const summary = getItemVerdicts(db, select('cashew'), [menuItemId]).get(menuItemId)!;
		expect(summary.hasWarning).toBe(false);
	});

	it('reports unknown for a non-vocabulary allergen with no label', () => {
		const menuItemId = seedItem();
		const summary = getItemVerdicts(db, select('mustard'), [menuItemId]).get(menuItemId)!;

		expect(summary.worst?.verdict).toBe('unknown');
		expect(summary.allChecked).toBe(false);
	});

	it('reports no-declared for a vocabulary allergen with no label', () => {
		const menuItemId = seedItem();
		const summary = getItemVerdicts(db, select('milk'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.verdict).toBe('no-declared');
	});

	it('stays unknown when the fetched label has no ingredient list', () => {
		const menuItemId = seedItem();
		attachFact(menuItemId, { ingredients: null, contains: 'Milk' });

		const summary = getItemVerdicts(db, select('mustard'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.verdict).toBe('unknown');
	});

	it('resolves to no-declared once an ingredient list has been read', () => {
		const menuItemId = seedItem();
		attachFact(menuItemId, { ingredients: 'WATER, SALT, SUGAR.' });

		const summary = getItemVerdicts(db, select('mustard'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.verdict).toBe('no-declared');
		expect(summary.allChecked).toBe(true);
	});

	it('surfaces the umbrella terms as an advisory', () => {
		const menuItemId = seedItem();
		attachFact(menuItemId, { ingredients: 'CHICKEN, SPICES.', hidden: 'SPICES' });

		const summary = getItemVerdicts(db, select('mustard'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.advisory).toContain('SPICES');
	});

	it('picks up a name-derived hit with no label at all', () => {
		const menuItemId = seedItem({ name: 'Peanut Sauce' });
		const itemId = db
			.prepare<{ item_id: number }>('SELECT item_id FROM menu_item WHERE id = ?')
			.get(menuItemId)!.item_id;
		db.prepare(
			`INSERT INTO item_allergen (item_id, allergen_id, confidence, evidence)
			 VALUES (?, ?, 'possible', 'item name: Peanut Sauce')`
		).run(itemId, allergenId('peanuts'));

		const summary = getItemVerdicts(db, select('peanuts'), [menuItemId]).get(menuItemId)!;
		expect(summary.worst?.verdict).toBe('flagged-possible');
	});

	it('ignores diet traits when gathering allergen evidence', () => {
		const menuItemId = seedItem();
		addTrait(menuItemId, 'Vegan');
		addTrait(menuItemId, 'Milk');

		const summary = getItemVerdicts(db, select('milk'), [menuItemId]).get(menuItemId)!;
		expect(summary.verdicts).toHaveLength(1);
		expect(summary.worst?.allergen.slug).toBe('milk');
	});

	it('handles an empty id list without touching the database', () => {
		expect(getItemVerdicts(db, select('milk'), []).size).toBe(0);
	});
});

describe('the allergen tree', () => {
	it('nests species under their group', () => {
		const tree = getAllergenTree(db);
		const treeNuts = tree.find((n) => n.slug === 'tree-nuts')!;
		expect(treeNuts.children.map((c) => c.slug)).toContain('macadamia');
	});

	it('nests two levels deep under shellfish', () => {
		const shellfish = getAllergenTree(db).find((n) => n.slug === 'shellfish')!;
		const crustacean = shellfish.children.find((c) => c.slug === 'crustacean')!;
		expect(crustacean.children.map((c) => c.slug)).toContain('shrimp');
	});

	it('leaves diets out of the warning tree entirely', () => {
		const slugs = getAllergenTree(db).map((n) => n.slug);
		expect(slugs).not.toContain('vegan');
		expect(getDietTags(db).map((t) => t.slug)).toContain('vegan');
	});

	it('marks exactly the 18 allergens upstream tags on menu rows', () => {
		// The number this invariant rests on. If a migration changes it, the
		// no-label verdict changes for every affected allergen, so it is asserted
		// rather than assumed.
		const count = db
			.prepare<{ c: number }>(
				'SELECT COUNT(*) AS c FROM allergen WHERE covered_by_trait_vocabulary = 1'
			)
			.get()!.c;
		expect(count).toBe(18);
	});
});
