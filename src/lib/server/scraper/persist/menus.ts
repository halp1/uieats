/**
 * Persisting one menu and everything on it.
 *
 * The whole thing runs in a single transaction, and the identity rules matter:
 *
 *   * A menu is identified by (unit_id, service_date, meal). `nn_oid` is a
 *     mutable fetch handle -- upstream republishes menus under new oids, and
 *     treating the oid as identity produces either duplicates or a UNIQUE
 *     violation on the next scrape.
 *
 *   * Rows written this run are stamped with scrape_run_id, and anything left
 *     over inside THIS menu is then deleted. That is how a dish removed
 *     upstream disappears while re-scraping unchanged data stays a no-op.
 *     Scoping the delete to one successfully-parsed menu is what stops a
 *     network failure from erasing real data.
 */
import { matchItemName } from '../../allergens/match.ts';
import type { Db } from '../../db/driver.ts';
import { mealSort } from '../../time.ts';
import type { ParsedItemPanel } from '../parse/item-panel.ts';
import { normalizeItemName, normalizeServingSize, slugify } from '../parse/text.ts';

export interface MenuIdentity {
	unitId: number;
	serviceDate: string;
	meal: string;
	nnOid: number;
}

export interface PersistMenuResult {
	menuId: number;
	itemsUpserted: number;
	itemsRemoved: number;
}

function upsertMenu(db: Db, id: MenuIdentity, headerRaw: string | null, now: number): number {
	const existing = db
		.prepare<{ id: number }>(
			'SELECT id FROM menu WHERE unit_id = ? AND service_date = ? AND meal = ?'
		)
		.get(id.unitId, id.serviceDate, id.meal);

	if (existing) {
		db.prepare('UPDATE menu SET nn_oid = ?, header_raw = ?, last_scraped_at = ? WHERE id = ?').run(
			id.nnOid,
			headerRaw,
			now,
			existing.id
		);
		return existing.id;
	}

	return db
		.prepare(
			`INSERT INTO menu (unit_id, service_date, meal, meal_sort, nn_oid, header_raw, first_seen_at, last_scraped_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id.unitId, id.serviceDate, id.meal, mealSort(id.meal), id.nnOid, headerRaw, now, now)
		.lastInsertRowid;
}

/**
 * Item-name allergen inference.
 *
 * Keyed on `name_checked_at` rather than on "did we just insert this row",
 * because the second form silently skips every dish already in the registry --
 * which is the entire catalogue the day this code first runs against a
 * populated database. An empty item_allergen would then be indistinguishable
 * from a clean result, which is precisely the confusion verdict.ts exists to
 * prevent.
 *
 * This is the only allergen signal available before a label is fetched, which
 * is exactly the window where a user has nothing else to go on. It is also the
 * weakest: verdict.ts renders it as `flagged-possible`, and per the design it
 * may only ever add a warning, never clear one.
 */
function matchName(db: Db, itemId: number, displayName: string, now: number): void {
	for (const match of matchItemName(db, displayName)) {
		db.prepare(
			`INSERT OR IGNORE INTO item_allergen (item_id, allergen_id, confidence, evidence)
			 VALUES (?, ?, 'possible', ?)`
		).run(itemId, match.allergenId, `item name: ${match.evidence}`);
	}
	db.prepare('UPDATE item SET name_checked_at = ? WHERE id = ?').run(now, itemId);
}

/** The canonical dish registry, keyed on a conservatively normalized name. */
function upsertItem(db: Db, displayName: string, now: number): number {
	const nameNorm = normalizeItemName(displayName);
	const existing = db
		.prepare<{ id: number; name_checked_at: number | null }>(
			'SELECT id, name_checked_at FROM item WHERE name_norm = ?'
		)
		.get(nameNorm);
	if (existing) {
		if (existing.name_checked_at === null) matchName(db, existing.id, displayName, now);
		return existing.id;
	}

	const base = slugify(displayName) || 'item';
	let slug = base;
	for (let n = 2; ; n++) {
		const clash = db.prepare<{ id: number }>('SELECT id FROM item WHERE slug = ?').get(slug);
		if (!clash) break;
		slug = `${base}-${n}`;
	}

	const itemId = db
		.prepare('INSERT INTO item (name_norm, name_display, slug, first_seen_at) VALUES (?, ?, ?, ?)')
		.run(nameNorm, displayName, slug, now).lastInsertRowid;

	matchName(db, itemId, displayName, now);
	return itemId;
}

export function persistMenu(
	db: Db,
	identity: MenuIdentity,
	panel: ParsedItemPanel,
	runId: number,
	now: number
): PersistMenuResult {
	return db.transaction(() => {
		const menuId = upsertMenu(db, identity, panel.header.venue, now);

		const categoryIds = new Map<number, number>();
		for (const category of panel.categories) {
			db.prepare(
				`INSERT INTO menu_category (menu_id, nn_category_id, name, sort, scrape_run_id)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(menu_id, nn_category_id)
				 DO UPDATE SET name = excluded.name, sort = excluded.sort, scrape_run_id = excluded.scrape_run_id`
			).run(menuId, category.nnCategoryId, category.name, category.sort, runId);

			const row = db
				.prepare<{ id: number }>(
					'SELECT id FROM menu_category WHERE menu_id = ? AND nn_category_id = ?'
				)
				.get(menuId, category.nnCategoryId);
			if (row) categoryIds.set(category.nnCategoryId, row.id);
		}

		let itemsUpserted = 0;
		for (const item of panel.items) {
			const categoryId = categoryIds.get(item.nnCategoryId);
			// An item whose category heading never appeared would violate the FK.
			// Skipping keeps the rest of the menu rather than losing all of it.
			if (categoryId === undefined) continue;

			const itemId = upsertItem(db, item.name, now);
			const servingNorm = normalizeServingSize(item.servingSize);

			// nutrition_fact_id and label_fetched_at are intentionally NOT touched
			// here: re-scraping a menu must not discard labels already fetched, or
			// the backfill would restart from zero every night.
			db.prepare(
				`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, serving_size, serving_size_norm, sort, scrape_run_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(menu_id, category_id, item_id, COALESCE(serving_size_norm, ''))
				 DO UPDATE SET nn_detail_oid = excluded.nn_detail_oid,
				               serving_size  = excluded.serving_size,
				               sort          = excluded.sort,
				               scrape_run_id = excluded.scrape_run_id`
			).run(
				menuId,
				categoryId,
				itemId,
				item.detailOid,
				item.servingSize,
				servingNorm,
				item.sort,
				runId
			);

			const menuItem = db
				.prepare<{ id: number }>(
					`SELECT id FROM menu_item
					 WHERE menu_id = ? AND category_id = ? AND item_id = ? AND COALESCE(serving_size_norm, '') = ?`
				)
				.get(menuId, categoryId, itemId, servingNorm);
			if (!menuItem) continue;
			itemsUpserted++;

			// Trait sets are tiny (<= 8) and can shrink, so replace wholesale
			// rather than diffing.
			db.prepare('DELETE FROM menu_item_trait WHERE menu_item_id = ?').run(menuItem.id);
			for (const label of item.traits) {
				const trait = db.prepare<{ id: number }>('SELECT id FROM trait WHERE label = ?').get(label);
				// An unknown trait means upstream added one to its legend. Dropping
				// it here is safe because the label's Contains: line remains
				// authoritative; the live smoke test is what surfaces the drift.
				if (trait) {
					db.prepare(
						'INSERT OR IGNORE INTO menu_item_trait (menu_item_id, trait_id) VALUES (?, ?)'
					).run(menuItem.id, trait.id);
				}
			}
		}

		// Anything in THIS menu not written by THIS run is gone upstream.
		const itemsRemoved = db
			.prepare('DELETE FROM menu_item WHERE menu_id = ? AND scrape_run_id <> ?')
			.run(menuId, runId).changes;
		db.prepare('DELETE FROM menu_category WHERE menu_id = ? AND scrape_run_id <> ?').run(
			menuId,
			runId
		);

		db.prepare(
			'UPDATE menu SET item_count = (SELECT COUNT(*) FROM menu_item WHERE menu_id = ?) WHERE id = ?'
		).run(menuId, menuId);

		return { menuId, itemsUpserted, itemsRemoved };
	});
}
