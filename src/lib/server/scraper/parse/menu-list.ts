/**
 * A venue's published menus: one card per service date, one link per meal.
 */
import { parse } from 'node-html-parser';
import { extractOid } from './oid.ts';
import { decodeEntities, normalizeWhitespace, parseLongDate } from './text.ts';

export interface ParsedMenuRef {
	oid: number;
	/** 'YYYY-MM-DD' in America/Chicago wall clock. */
	serviceDate: string;
	/** Raw upstream label: Breakfast, Lunch, Dinner, Brunch, Late Night, ... */
	meal: string;
}

export function parseMenuList(html: string): ParsedMenuRef[] {
	const root = parse(html);
	const menus: ParsedMenuRef[] = [];
	const seen = new Set<string>();

	// Meals are grouped under a date heading rather than carrying their own
	// date, so the card is the unit of parsing. Upstream also skips days a
	// venue is closed, so nothing here may assume contiguous dates.
	for (const card of root.querySelectorAll('section.card')) {
		const heading = card.querySelector('header');
		if (!heading) continue;

		const serviceDate = parseLongDate(heading.text);
		if (!serviceDate) continue;

		for (const link of card.querySelectorAll('a[onclick]')) {
			const oid = extractOid(link.getAttribute('onclick') ?? '', 'menuListSelectMenu');
			if (oid === null) continue;

			const meal = normalizeWhitespace(decodeEntities(link.text));
			if (meal === '') continue;

			const key = `${serviceDate} ${meal}`;
			if (seen.has(key)) continue;
			seen.add(key);

			menus.push({ oid, serviceDate, meal });
		}
	}

	return menus;
}
