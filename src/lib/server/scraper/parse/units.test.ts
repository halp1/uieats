import { describe, expect, it } from 'vitest';
import { parseChildUnits, parseUnits } from './units.ts';
import { fixturePanel, loadFixture } from '../../../../../tests/helpers/fixtures.ts';
import { readPanels } from '../panels.ts';
import { parseMenuList } from './menu-list.ts';

describe('parseUnits', () => {
	const units = parseUnits(loadFixture('landing.html'));

	it('finds every top-level unit embedded in the landing page', () => {
		// The unit list ships inside the landing HTML, so discovery costs no
		// extra request.
		expect(units).toHaveLength(12);
	});

	it('reads the verified oid/name pairs', () => {
		expect(units.slice(0, 4)).toEqual([
			{ oid: 1, name: 'Ikenberry Dining Center (Ike)' },
			{ oid: 11, name: 'Illinois Street Dining Center (ISR)' },
			{ oid: 22, name: 'Pennsylvania Avenue Dining Hall (PAR)' },
			{ oid: 29, name: 'Lincoln Avenue Dining Hall (LAR)' }
		]);
		expect(units.at(-1)).toEqual({ oid: 39, name: 'Everybody Eats' });
	});

	it('returns units in the order upstream lists them', () => {
		expect(units.map((u) => u.oid)).toEqual([1, 11, 22, 29, 32, 33, 34, 35, 36, 37, 38, 39]);
	});

	it('leaves no undecoded entities or markup in any name', () => {
		for (const u of units) {
			expect(u.name).not.toMatch(/[<>]|&[a-z#]+;/i);
			expect(u.name).toBe(u.name.trim());
		}
	});

	it('returns an empty list rather than throwing on unrecognised markup', () => {
		expect(parseUnits('<html><body>nothing</body></html>')).toEqual([]);
	});
});

describe('parseChildUnits', () => {
	const children = parseChildUnits(fixturePanel('select-unit-1.hall.json', 'childUnitsPanel'));

	it("finds all nine of Ikenberry's venues", () => {
		expect(children).toHaveLength(9);
		expect(children.map((c) => c.oid)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it('reads venue names including the apostrophe case', () => {
		// "Don's Chophouse" sits inside a single-quoted HTML attribute; getting
		// this wrong truncates the name.
		expect(children.map((c) => c.name)).toEqual([
			'Baked Expectations',
			"Don's Chophouse",
			'Euclid Street Deli',
			'Gregory Drive Diner',
			'Penne Lane',
			'Prairie Fire',
			'Soytainly',
			'Inclusive Solutions Kitchen at Ikenberry',
			'Build Your Own'
		]);
	});

	it('reads the open/closed badge as a point-in-time observation', () => {
		for (const c of children) expect(c.isOpen).toBe(true);
	});

	it('does not mistake the back button for a venue', () => {
		expect(children.some((c) => /back/i.test(c.name))).toBe(false);
	});
});

describe('the standalone-unit branch', () => {
	it('returns a menu list directly, with no childUnitsPanel to parse', () => {
		// Field of Greens (oid 32) has no children, so SelectUnitFromUnitsList
		// answers with menuPanel instead of childUnitsPanel. Eight of the twelve
		// top-level units take this branch, and a crawler that only handles halls
		// silently drops all of them.
		const panels = readPanels(loadFixture('select-unit-32.standalone.json'));
		expect(panels.has('childUnitsPanel')).toBe(false);
		expect(panels.has('menuPanel')).toBe(true);

		// And the panel it returns is a normal menu list.
		const menus = parseMenuList(panels.get('menuPanel')!);
		expect(menus.length).toBeGreaterThan(0);
		expect(menus[0].serviceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('yields no child units if a caller mistakenly parses it as a hall', () => {
		const panels = readPanels(loadFixture('select-unit-32.standalone.json'));
		expect(parseChildUnits(panels.get('menuPanel')!)).toEqual([]);
	});
});
