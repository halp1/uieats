/**
 * Unit discovery.
 *
 * Top-level units are embedded in the landing page, so the crawl gets them for
 * free. Venues arrive later, in the childUnitsPanel of a hall.
 */
import { parse } from 'node-html-parser';
import { extractOid } from './oid.ts';
import { decodeEntities, normalizeWhitespace } from './text.ts';

export interface ParsedUnit {
	oid: number;
	name: string;
}

export interface ParsedChildUnit extends ParsedUnit {
	/**
	 * The green/grey badge upstream renders next to the venue. It is an
	 * observation at scrape time, not a property of the venue, and is stored
	 * separately from its published hours.
	 */
	isOpen: boolean;
}

function textOf(node: { text: string }): string {
	return normalizeWhitespace(decodeEntities(node.text));
}

/** Top-level units from the landing page HTML. */
export function parseUnits(html: string): ParsedUnit[] {
	const root = parse(html);
	const units: ParsedUnit[] = [];

	for (const anchor of root.querySelectorAll('#cbo_nn_unitDataList a[onclick]')) {
		const oid = extractOid(anchor.getAttribute('onclick') ?? '', 'unitsSelectUnit');
		if (oid === null) continue;
		units.push({ oid, name: textOf(anchor) });
	}

	return units;
}

/** Venues from a hall's childUnitsPanel. */
export function parseChildUnits(html: string): ParsedChildUnit[] {
	const root = parse(html);
	const children: ParsedChildUnit[] = [];

	// Each venue is one .card; the name anchor and the status badge are
	// siblings inside its header, so scoping to the card keeps them paired even
	// when a venue is missing one of them.
	for (const card of root.querySelectorAll('.card')) {
		let found: ParsedChildUnit | undefined;

		for (const anchor of card.querySelectorAll('a[onclick]')) {
			const oid = extractOid(anchor.getAttribute('onclick') ?? '', 'childUnitsSelectUnit');
			if (oid === null) continue;
			found = { oid, name: textOf(anchor), isOpen: false };
			break;
		}
		if (!found) continue;

		const badge = card.querySelector('.badge');
		found.isOpen = badge ? /open/i.test(textOf(badge)) : false;
		children.push(found);
	}

	return children;
}
