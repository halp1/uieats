/**
 * A venue's weekly hours of operation.
 *
 * CAUTION: the only capture available was taken in summer, when every venue
 * reads "Closed", so the open-hours cell layout is INFERRED, not observed. The
 * closed row is `<td>Sunday</td><td colspan='2'>Closed</td>`; the colspan
 * strongly implies two cells when open, but the time format is a guess. Both
 * the two-cell and single-range shapes are handled, and anything unrecognised
 * is preserved in `raw` rather than dropped. Re-verify against a live term.
 */
import { parse } from 'node-html-parser';
import { decodeEntities, normalizeWhitespace } from './text.ts';

export interface ParsedHours {
	/** 0 = Sunday, matching the unit_hours CHECK constraint. */
	weekday: number;
	/** Nth block for that day; venues can publish split hours. */
	ordinal: number;
	/** 'HH:MM' 24-hour local time, or null when closed / unparseable. */
	opens: string | null;
	closes: string | null;
	isClosed: boolean;
	/** Verbatim cell text, so an unrecognised format is never silently lost. */
	raw: string;
}

const WEEKDAYS: Record<string, number> = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6
};

/** '7:00 AM' -> '07:00'. Returns null for anything that is not a clock time. */
export function parseClockTime(input: string): string | null {
	const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(normalizeWhitespace(input));
	if (!match) return null;

	let hour = Number(match[1]);
	const minute = Number(match[2] ?? '0');
	if (hour < 1 || hour > 12 || minute > 59) return null;

	const isPm = match[3].toLowerCase() === 'p';
	if (hour === 12) hour = 0;
	if (isPm) hour += 12;

	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseHours(html: string): ParsedHours[] {
	const root = parse(html);
	const rows: ParsedHours[] = [];
	const seenPerDay = new Map<number, number>();

	for (const tr of root.querySelectorAll('tr')) {
		const cells = tr
			.querySelectorAll('td')
			.map((td) => normalizeWhitespace(decodeEntities(td.text)));
		if (cells.length < 2) continue;

		const weekday = WEEKDAYS[cells[0].toLowerCase()];
		if (weekday === undefined) continue;

		const ordinal = seenPerDay.get(weekday) ?? 0;
		seenPerDay.set(weekday, ordinal + 1);

		const raw = cells.slice(1).join(' ').trim();

		if (/closed/i.test(raw)) {
			rows.push({ weekday, ordinal, opens: null, closes: null, isClosed: true, raw });
			continue;
		}

		// Two cells when open, per the colspan='2' the closed row collapses.
		let opens = cells[1] ? parseClockTime(cells[1]) : null;
		let closes = cells[2] ? parseClockTime(cells[2]) : null;

		// Fall back to a single "7:00 AM - 10:00 AM" cell.
		if (!opens && !closes) {
			const [from, to] = raw.split(/\s*(?:-|–|—|to)\s*/i);
			opens = from ? parseClockTime(from) : null;
			closes = to ? parseClockTime(to) : null;
		}

		rows.push({ weekday, ordinal, opens, closes, isClosed: false, raw });
	}

	return rows;
}
