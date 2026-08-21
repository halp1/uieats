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
import { mealSort } from '../../../dates.ts';
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
		const upsertCategory = (nnCategoryId: number, name: string, sort: number): number => {
			const row = db
				.prepare<{ id: number }>(
					`INSERT INTO menu_category (menu_id, nn_category_id, name, sort, scrape_run_id)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(menu_id, nn_category_id)
					 DO UPDATE SET name = excluded.name, sort = excluded.sort,
					               scrape_run_id = excluded.scrape_run_id
					 RETURNING id`
				)
				.get(menuId, nnCategoryId, name, sort, runId);
			if (!row) throw new Error(`menu_category upsert returned no row for ${nnCategoryId}`);
			categoryIds.set(nnCategoryId, row.id);
			return row.id;
		};

		for (const category of panel.categories) {
			upsertCategory(category.nnCategoryId, category.name, category.sort);
		}

		let itemsUpserted = 0;
		for (const item of panel.items) {
			// An item whose course heading never appeared would violate the FK, so
			// one is synthesized rather than dropping the dish.
			//
			// This used to `continue`, and that silently lost food off menus:
			// upstream marks an unnamed course with the sentinel id -1234, the oid
			// regex could not read a negative number, so the heading never arrived
			// and every dish under it vanished. The parser is fixed, but a dish
			// disappearing from a menu is not something this app should be capable
			// of doing quietly, whatever upstream invents next. The name is left
			// empty because we genuinely do not know it; the UI reads that, and a
			// negative id, as "no course given".
			const categoryId =
				categoryIds.get(item.nnCategoryId) ??
				upsertCategory(item.nnCategoryId, '', panel.categories.length);

			const itemId = upsertItem(db, item.name, now);
			const servingNorm = normalizeServingSize(item.servingSize);

			// nutrition_fact_id and label_fetched_at are intentionally NOT touched
			// here: re-scraping a menu must not discard labels already fetched, or
			// the backfill would restart from zero every night.
			// Identity is (menu_id, nn_detail_oid) -- the INSTANCE. Keying on the
			// dish name and serving size instead collapsed two genuinely different
			// products that upstream lists under one name, and the survivor was
			// whichever came last in the markup. See 0005_menu_item_identity.sql:
			// every collision observed lost a real allergen difference.
			//
			// category_id and item_id are updated too, so a dish moving course or
			// being renamed upstream follows the same instance rather than
			// orphaning a row.
			const menuItem = db
				.prepare<{ id: number }>(
					`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, serving_size, serving_size_norm, sort, scrape_run_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(menu_id, nn_detail_oid)
					 DO UPDATE SET category_id       = excluded.category_id,
					               item_id           = excluded.item_id,
					               serving_size      = excluded.serving_size,
					               serving_size_norm = excluded.serving_size_norm,
					               sort              = excluded.sort,
					               scrape_run_id     = excluded.scrape_run_id
					 RETURNING id`
				)
				.get(
					menuId,
					categoryId,
					itemId,
					item.detailOid,
					item.servingSize,
					servingNorm,
					item.sort,
					runId
				);
			if (!menuItem) throw new Error(`menu_item upsert returned no row for ${item.detailOid}`);
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

/**
 * Deletes menus for dates upstream no longer publishes.
 *
 * Upstream retires past days: on 2026-08-21 its menu list ran 08-21 to 09-17,
 * and 08-20 was simply gone. Our rows for a retired date are never refreshed --
 * the per-menu sweep in `persistMenu` only touches menus this run actually
 * parsed, deliberately, so a network failure cannot erase data. Nothing else
 * ever removed them.
 *
 * Left alone they are not merely untidy. Their items sit in the nutrition
 * backfill queue as `label_fetched_at IS NULL` forever, and the label endpoint
 * answers 0 bytes for a menu it no longer offers (measured). Because the queue
 * is ordered by service_date ASC, those unfetchable items sort FIRST -- so every
 * night starts by failing, the run reports `partial`, and as more dates retire
 * the error rate climbs toward the 50% circuit breaker that would abort the real
 * work behind them.
 *
 * Only the past is pruned, and only strictly before the window's start, so a
 * narrower `--days` run can never delete future menus it simply did not ask for.
 * The cascade takes menu_category, menu_item and menu_item_trait with it.
 */
export function pruneMenusBefore(db: Db, date: string): number {
	return db.prepare('DELETE FROM menu WHERE service_date < ?').run(date).changes;
}
