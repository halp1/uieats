/**
 * Persisting the unit tree.
 *
 * Slugs are assigned once and never rewritten: they appear in URLs, and
 * changing one silently breaks every existing link to that venue.
 */
import type { Db } from '../../db/driver.ts';
import { shortNameFrom, slugify } from '../parse/text.ts';

export type UnitKind = 'hall' | 'venue' | 'standalone';

export interface UnitInput {
	nnOid: number;
	parentId: number | null;
	name: string;
	kind: UnitKind;
	sort: number;
}

/** Inserts or updates one unit, returning its surrogate id. */
export function upsertUnit(db: Db, input: UnitInput, now: number): number {
	const existing = db
		.prepare<{ id: number }>('SELECT id FROM unit WHERE nn_oid = ?')
		.get(input.nnOid);

	if (existing) {
		db.prepare(
			`UPDATE unit
			 SET parent_id = ?, name = ?, short_name = ?, kind = ?, sort = ?,
			     is_active = 1, last_seen_at = ?
			 WHERE id = ?`
		).run(
			input.parentId,
			input.name,
			shortNameFrom(input.name),
			input.kind,
			input.sort,
			now,
			existing.id
		);
		return existing.id;
	}

	// Prefer the abbreviation upstream already publishes: "Ikenberry Dining
	// Center (Ike)" gives /d/2026-08-21/ike/gregory-drive-diner rather than a
	// URL with the whole building name in it. These end up in shared links, so
	// short and recognisable is worth the extra line.
	//
	// Two venues in different halls may share a name ("Build Your Own"), and the
	// slug index is scoped to the parent, so only disambiguate within a parent.
	const base =
		slugify(shortNameFrom(input.name) ?? input.name) ||
		slugify(input.name) ||
		`unit-${input.nnOid}`;
	let slug = base;
	for (let n = 2; ; n++) {
		const clash = db
			.prepare<{ id: number }>(
				'SELECT id FROM unit WHERE COALESCE(parent_id, 0) = COALESCE(?, 0) AND slug = ?'
			)
			.get(input.parentId, slug);
		if (!clash) break;
		slug = `${base}-${n}`;
	}

	return db
		.prepare(
			`INSERT INTO unit (nn_oid, parent_id, name, short_name, slug, kind, sort, first_seen_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.nnOid,
			input.parentId,
			input.name,
			shortNameFrom(input.name),
			slug,
			input.kind,
			input.sort,
			now,
			now
		).lastInsertRowid;
}

/** The open/closed badge is an observation at scrape time, not a schedule. */
export function recordUnitStatus(db: Db, unitId: number, isOpen: boolean, now: number): void {
	db.prepare(
		`INSERT INTO unit_status (unit_id, is_open, observed_at) VALUES (?, ?, ?)
		 ON CONFLICT(unit_id) DO UPDATE SET is_open = excluded.is_open, observed_at = excluded.observed_at`
	).run(unitId, isOpen ? 1 : 0, now);
}

/**
 * Marks units not seen in this run inactive rather than deleting them.
 * Menus reference units, and a venue closing for a term should not erase its
 * history.
 */
export function deactivateUnitsNotSeen(db: Db, since: number): number {
	return db.prepare('UPDATE unit SET is_active = 0 WHERE last_seen_at < ?').run(since).changes;
}
