/**
 * Halls, venues and hours.
 *
 * `unit` is one self-referential table mirroring upstream exactly: children ⇒
 * hall, has a parent ⇒ venue, neither ⇒ standalone. Eight of the twelve
 * top-level units are standalone, so anything that only understands
 * hall-with-venues drops two thirds of campus. Every function here treats a
 * standalone unit as a hall that happens to contain only itself, which is what
 * lets one route render both.
 */
import type { Db } from '../db/driver.ts';
import { weekdayOf } from '../../dates.ts';

export interface UnitRef {
	id: number;
	nnOid: number;
	slug: string;
	name: string;
	shortName: string | null;
	kind: 'hall' | 'venue' | 'standalone';
}

export interface HallWithVenues extends UnitRef {
	venues: UnitRef[];
}

interface UnitRow {
	id: number;
	nn_oid: number;
	slug: string;
	name: string;
	short_name: string | null;
	kind: string;
	parent_id: number | null;
	sort: number;
}

function toRef(row: UnitRow): UnitRef {
	return {
		id: row.id,
		nnOid: row.nn_oid,
		slug: row.slug,
		name: row.name,
		shortName: row.short_name,
		kind: row.kind as UnitRef['kind']
	};
}

const UNIT_COLUMNS = 'id, nn_oid, slug, name, short_name, kind, parent_id, sort';

/** Top-level units with their venues; standalones come back with none. */
export function getUnitTree(db: Db): HallWithVenues[] {
	const rows = db
		.prepare<UnitRow>(`SELECT ${UNIT_COLUMNS} FROM unit WHERE is_active = 1 ORDER BY sort, name`)
		.all();

	const byId = new Map(rows.map((r) => [r.id, r]));
	const tops = rows.filter((r) => r.parent_id === null);

	return tops.map((top) => ({
		...toRef(top),
		venues: rows
			.filter((r) => r.parent_id === top.id)
			.map(toRef)
			.sort((a, b) => (byId.get(a.id)!.sort ?? 0) - (byId.get(b.id)!.sort ?? 0))
	}));
}

export function getUnitBySlug(
	db: Db,
	slug: string,
	parentId: number | null = null
): UnitRef | null {
	const row = db
		.prepare<UnitRow>(
			`SELECT ${UNIT_COLUMNS} FROM unit
			 WHERE slug = ? AND COALESCE(parent_id, 0) = COALESCE(?, 0)`
		)
		.get(slug, parentId);
	return row ? toRef(row) : null;
}

export function getUnitById(db: Db, id: number): UnitRef | null {
	const row = db.prepare<UnitRow>(`SELECT ${UNIT_COLUMNS} FROM unit WHERE id = ?`).get(id);
	return row ? toRef(row) : null;
}

/**
 * The venues a scope covers.
 *
 * A hall expands to its children; a standalone unit is its own only venue.
 * Callers never branch on kind because of this.
 */
export function getVenuesOf(db: Db, unit: UnitRef): UnitRef[] {
	if (unit.kind !== 'hall') return [unit];
	return db
		.prepare<UnitRow>(
			`SELECT ${UNIT_COLUMNS} FROM unit WHERE parent_id = ? AND is_active = 1 ORDER BY sort, name`
		)
		.all(unit.id)
		.map(toRef);
}

export interface HoursEntry {
	opens: string | null;
	closes: string | null;
	isClosed: boolean;
	raw: string;
}

export interface VenueHours {
	/** The blocks for the requested weekday, in ordinal order. */
	today: HoursEntry[];
	/**
	 * False when the stored week is closed on all seven days.
	 *
	 * That is not a venue that never opens -- it is upstream declining to
	 * publish a schedule, which is what every capture taken out of term looks
	 * like. Rendering it as "Closed today" next to a published breakfast menu
	 * puts two contradictory claims on one row and makes the user arbitrate, so
	 * callers show nothing instead.
	 */
	publishesSchedule: boolean;
}

/**
 * Opening hours for one weekday, plus whether a schedule exists at all.
 *
 * `raw` is always preserved: the parser handles the two layouts observed out of
 * term, and anything it cannot read still shows the user upstream's own words
 * instead of nothing.
 */
export function getHoursFor(
	db: Db,
	unitIds: readonly number[],
	date: string
): Map<number, VenueHours> {
	const out = new Map<number, VenueHours>();
	if (unitIds.length === 0) return out;

	const list = unitIds.map(() => '?').join(', ');
	const rows = db
		.prepare<{
			unit_id: number;
			weekday: number;
			opens: string | null;
			closes: string | null;
			is_closed: number;
			raw: string;
		}>(
			`SELECT unit_id, weekday, opens, closes, is_closed, raw FROM unit_hours
			 WHERE unit_id IN (${list}) ORDER BY unit_id, weekday, ordinal`
		)
		.all(...unitIds);

	const weekday = weekdayOf(date);
	const anyOpen = new Set<number>();

	for (const row of rows) {
		if (row.is_closed !== 1) anyOpen.add(row.unit_id);

		let entry = out.get(row.unit_id);
		if (!entry) {
			entry = { today: [], publishesSchedule: false };
			out.set(row.unit_id, entry);
		}
		if (row.weekday === weekday) {
			entry.today.push({
				opens: row.opens,
				closes: row.closes,
				isClosed: row.is_closed === 1,
				raw: row.raw
			});
		}
	}

	for (const [unitId, entry] of out) entry.publishesSchedule = anyOpen.has(unitId);
	return out;
}

/**
 * The Open/Closed badge upstream renders.
 *
 * This is a point-in-time observation from whenever the scrape ran, not a fact
 * about the venue, so it is returned with its timestamp and the UI must say
 * when it was seen rather than presenting it as current.
 */
export function getUnitStatuses(
	db: Db,
	unitIds: readonly number[]
): Map<number, { isOpen: boolean; observedAt: number }> {
	const out = new Map<number, { isOpen: boolean; observedAt: number }>();
	if (unitIds.length === 0) return out;

	const list = unitIds.map(() => '?').join(', ');
	for (const row of db
		.prepare<{ unit_id: number; is_open: number; observed_at: number }>(
			`SELECT unit_id, is_open, observed_at FROM unit_status WHERE unit_id IN (${list})`
		)
		.all(...unitIds)) {
		out.set(row.unit_id, { isOpen: row.is_open === 1, observedAt: row.observed_at });
	}
	return out;
}
