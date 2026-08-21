/**
 * The item grid for one menu: categories, dishes, and their trait icons.
 *
 * This is the highest-risk parser in the scraper. The trait icons it reads are
 * an allergen signal a user may act on, and they agree exactly with the
 * nutrition label's "Contains:" line (verified across 10 venues), so
 * under-reading them is a safety failure rather than a cosmetic one.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { extractOid } from './oid.ts';
import { decodeEntities, normalizeWhitespace, parseLongDate } from './text.ts';

export interface ItemPanelHeader {
	hall: string | null;
	venue: string | null;
	serviceDate: string | null;
	meal: string | null;
}

export interface ParsedCategory {
	nnCategoryId: number;
	name: string;
	sort: number;
}

export interface ParsedItem {
	detailOid: number;
	name: string;
	servingSize: string | null;
	/** Upstream `title` attributes, in markup order. Allergens and diets mixed. */
	traits: string[];
	nnCategoryId: number;
	sort: number;
}

export interface ParsedItemPanel {
	header: ItemPanelHeader;
	categories: ParsedCategory[];
	items: ParsedItem[];
}

const EMPTY_HEADER: ItemPanelHeader = { hall: null, venue: null, serviceDate: null, meal: null };

function toOid(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function textOf(node: HTMLElement): string {
	return normalizeWhitespace(decodeEntities(node.text));
}

/**
 * "Menu For - Ikenberry Dining Center (Ike) - Tuesday, August 18, 2026 - Lunch
 *  - Baked Expectations", joined with nbsp-dash-nbsp.
 */
function parseHeader(root: HTMLElement): ItemPanelHeader {
	const node = root.querySelector('.cbo_nn_itemHeaderDiv .h5') ?? root.querySelector('.h5');
	if (!node) return EMPTY_HEADER;

	const parts = textOf(node)
		.split(/\s+-\s+/)
		.map((p) => p.trim());
	if (parts.length < 5) return EMPTY_HEADER;

	// parts[0] is the literal "Menu For". A venue name containing " - " would
	// spill into extra parts, so the tail is rejoined rather than indexed.
	return {
		hall: parts[1] || null,
		serviceDate: parseLongDate(parts[2]),
		meal: parts[3] || null,
		venue: parts.slice(4).join(' - ') || null
	};
}

export function parseItemPanel(html: string): ParsedItemPanel {
	const root = parse(html);
	const categories: ParsedCategory[] = [];
	const items: ParsedItem[] = [];

	for (const row of root.querySelectorAll('tr')) {
		const className = row.getAttribute('class') ?? '';

		// Category heading row.
		if (className.includes('cbo_nn_itemGroupRow')) {
			const id = extractOid(row.getAttribute('onclick') ?? '', 'toggleCourseItems', 1);
			if (id === null) continue;
			const label = row.querySelector('[role="button"]') ?? row;
			categories.push({ nnCategoryId: id, name: textOf(label), sort: categories.length });
			continue;
		}

		// Dish row. Upstream alternates two class names purely for striping.
		if (
			!className.includes('cbo_nn_itemPrimaryRow') &&
			!className.includes('cbo_nn_itemAlternateRow')
		) {
			continue;
		}

		const anchor = row.querySelector('a.cbo_nn_itemHover');
		if (!anchor) continue;

		// Read the oid from the explicit data attribute rather than the inline
		// handler. The anchor's onclick calls getItemNutritionLabelOnClick, not
		// the bare function, and upstream emits a malformed `tabindex="0"onclick=`
		// with no separating space -- both make handler-scraping fragile here.
		// `id="showNutrition_<oid>"` is the fallback.
		const detailOid =
			toOid(row.querySelector('[data-detailoid]')?.getAttribute('data-detailoid')) ??
			toOid(anchor.getAttribute('id')?.replace('showNutrition_', ''));
		if (detailOid === null) continue;

		// data-categoryid carries the association explicitly, so items keep their
		// category even though the rows are flat siblings of the heading.
		const categoryId = Number(row.getAttribute('data-categoryid'));
		if (!Number.isFinite(categoryId)) continue;

		// Every icon on the row, not just the first: each one is a declared
		// allergen or diet tag.
		const traits = anchor
			.querySelectorAll('img[title]')
			.map((img) => normalizeWhitespace(decodeEntities(img.getAttribute('title') ?? '')))
			.filter((t) => t !== '');

		// anchor.text picks up only the dish name; the icons contribute no text.
		const name = textOf(anchor);
		if (name === '') continue;

		// Serving size is the cell after the one holding the name.
		const cells = row.querySelectorAll('td');
		const nameCellIndex = cells.findIndex((td) => td.querySelector('a.cbo_nn_itemHover'));
		const servingCell = nameCellIndex >= 0 ? cells[nameCellIndex + 1] : undefined;
		const servingSize = servingCell ? textOf(servingCell) || null : null;

		items.push({
			detailOid,
			name,
			servingSize,
			traits,
			nnCategoryId: categoryId,
			sort: items.length
		});
	}

	return { header: parseHeader(root), categories, items };
}
