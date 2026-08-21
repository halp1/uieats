/**
 * Persisting a venue's weekly hours.
 *
 * Upsert on (unit_id, weekday, ordinal), then delete the ordinals this run did
 * not write. That last step is what handles a schedule SHRINKING -- a split
 * lunch collapsing to one block -- which a bare upsert would leave behind
 * forever as a phantom opening.
 *
 * The obvious alternative, delete-then-insert, would be simpler and wrong: it
 * hands every row a new id on every scrape, so "scrape twice, get identical
 * rows" stops holding for this table. That guarantee is asserted end to end in
 * `crawl.test.ts` and is worth more than the four lines it costs here.
 */
import type { Db } from '../../db/driver.ts';
import type { ParsedHours } from '../parse/hours.ts';

export function persistHours(db: Db, unitId: number, hours: ParsedHours[], now: number): number {
	return db.transaction(() => {
		for (const entry of hours) {
			db.prepare(
				`INSERT INTO unit_hours (unit_id, weekday, ordinal, opens, closes, is_closed, raw, scraped_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(unit_id, weekday, ordinal)
				 DO UPDATE SET opens = excluded.opens, closes = excluded.closes,
				               is_closed = excluded.is_closed, raw = excluded.raw,
				               scraped_at = excluded.scraped_at`
			).run(
				unitId,
				entry.weekday,
				entry.ordinal,
				entry.opens,
				entry.closes,
				entry.isClosed ? 1 : 0,
				entry.raw,
				now
			);
		}

		// Anything past the highest ordinal written for a weekday is a block that
		// no longer exists upstream. Scoped per weekday so a day missing from this
		// response never erases the others.
		const maxOrdinal = new Map<number, number>();
		for (const entry of hours) {
			maxOrdinal.set(entry.weekday, Math.max(maxOrdinal.get(entry.weekday) ?? 0, entry.ordinal));
		}
		for (const [weekday, ordinal] of maxOrdinal) {
			db.prepare('DELETE FROM unit_hours WHERE unit_id = ? AND weekday = ? AND ordinal > ?').run(
				unitId,
				weekday,
				ordinal
			);
		}

		return hours.length;
	});
}
