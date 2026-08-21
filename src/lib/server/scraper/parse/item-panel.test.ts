import { describe, expect, it } from 'vitest';
import { parseItemPanel } from './item-panel.ts';
import { fixturePanel } from '../../../../../tests/helpers/fixtures.ts';

const panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));

describe('parseItemPanel header', () => {
	it('splits the nbsp-dash-nbsp header into its four parts', () => {
		expect(panel.header).toEqual({
			hall: 'Ikenberry Dining Center (Ike)',
			serviceDate: '2026-08-18',
			meal: 'Lunch',
			venue: 'Baked Expectations'
		});
	});
});

describe('parseItemPanel categories', () => {
	it('reads the category rows with their upstream ids', () => {
		expect(panel.categories).toEqual([{ nnCategoryId: 12, name: 'Desserts', sort: 0 }]);
	});
});

describe('parseItemPanel items', () => {
	it('reads name, detail oid and serving size', () => {
		const blondie = panel.items.find((i) => i.name === 'Blondie Bars');
		expect(blondie).toBeDefined();
		expect(blondie?.detailOid).toBe(122098028);
		expect(blondie?.servingSize).toBe('Slice (1/96)');
	});

	it('reads every trait icon on the row, not just the first', () => {
		// A parser that stops at the first icon under-reports allergens, which
		// is the most dangerous failure this module can have.
		const blondie = panel.items.find((i) => i.name === 'Blondie Bars');
		// Note the diet trait: the grid carries Vegetarian alongside the six
		// allergens, which the nutrition label's Contains: line omits. The two
		// sources are complementary, not redundant.
		expect(blondie?.traits).toEqual([
			'Corn',
			'Eggs',
			'Gluten',
			'Milk',
			'Soy',
			'Wheat',
			'Vegetarian'
		]);
	});

	it('assigns every item to the category it appears under', () => {
		for (const item of panel.items) {
			expect(item.nnCategoryId).toBe(12);
		}
	});

	it('finds exactly as many items as there are item rows in the markup', () => {
		const raw = fixturePanel('itempanel-1440348.json', 'itemPanel');
		const rowCount = (raw.match(/cbo_nn_item(?:Primary|Alternate)Row/g) ?? []).length;
		expect(panel.items).toHaveLength(rowCount);
	});

	it('leaves no undecoded entities or markup in any name', () => {
		for (const item of panel.items) {
			expect(item.name).not.toMatch(/[<>]|&[a-z#]+;/i);
			expect(item.name).toBe(item.name.trim());
			expect(item.name).not.toBe('');
		}
	});

	it('gives every item a distinct detail oid within one menu', () => {
		const oids = panel.items.map((i) => i.detailOid);
		expect(new Set(oids).size).toBe(oids.length);
	});

	it('preserves upstream ordering', () => {
		expect(panel.items.map((i) => i.sort)).toEqual(panel.items.map((_, idx) => idx));
	});
});

describe('parseItemPanel across a second real menu', () => {
	const other = parseItemPanel(fixturePanel('itempanel-1440351.json', 'itemPanel'));

	it('reads a different date from the same venue', () => {
		expect(other.header.serviceDate).toBe('2026-08-21');
		expect(other.header.venue).toBe('Baked Expectations');
	});

	it('reads a Tree Nuts declaration that never names the species', () => {
		// White Chocolate Macadamia Nut Cookie: upstream declares only the group,
		// "Tree Nuts". Nothing here says macadamia -- that appears solely in the
		// ingredient text on the nutrition label. This is the case the whole
		// sub-allergen feature exists for.
		const cookie = other.items.find((i) => i.name.includes('Macadamia'));
		expect(cookie).toBeDefined();
		expect(cookie?.traits).toContain('Tree Nuts');
	});
});

describe('parseItemPanel degenerate input', () => {
	it('returns empty collections rather than throwing on an unrecognised panel', () => {
		const empty = parseItemPanel('<section class="cbo_nn_itemGridDiv"></section>');
		expect(empty.items).toEqual([]);
		expect(empty.categories).toEqual([]);
		expect(empty.header.venue).toBeNull();
	});
});
