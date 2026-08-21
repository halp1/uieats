import { describe, expect, it } from 'vitest';
import { parseMenuList } from './menu-list.ts';
import { fixturePanel } from '../../../../../tests/helpers/fixtures.ts';

const menus = parseMenuList(fixturePanel('select-childunit-2.menulist.json', 'menuPanel'));

describe('parseMenuList', () => {
	it('finds every date/meal combination offered', () => {
		expect(menus.length).toBeGreaterThan(50);
	});

	it('converts the long date format without going through Date', () => {
		const first = menus[0];
		expect(first.serviceDate).toBe('2026-08-13');
		expect(first.meal).toBe('Lunch');
		expect(first.oid).toBe(1440778);
	});

	it('pairs each meal with the date heading it sits under', () => {
		const aug13 = menus.filter((m) => m.serviceDate === '2026-08-13');
		expect(aug13.map((m) => m.meal)).toEqual(['Lunch', 'Dinner']);

		// Later dates in this fixture add Breakfast; the grouping must follow the
		// heading rather than assume a fixed three meals per day.
		const aug18 = menus.filter((m) => m.serviceDate === '2026-08-18');
		expect(aug18.map((m) => m.meal)).toEqual(['Breakfast', 'Lunch', 'Dinner']);
	});

	it('does not invent entries for calendar days upstream skipped', () => {
		// This venue publishes nothing for Sunday 16 August. A parser that
		// assumed contiguous days would shift every later menu by one.
		expect(menus.some((m) => m.serviceDate === '2026-08-16')).toBe(false);
		expect(menus.some((m) => m.serviceDate === '2026-08-17')).toBe(true);
	});

	it('emits dates in ascending order and every one well-formed', () => {
		const dates = menus.map((m) => m.serviceDate);
		expect([...dates].sort()).toEqual(dates);
		for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('gives every entry a positive oid and a non-empty meal', () => {
		for (const m of menus) {
			expect(m.oid).toBeGreaterThan(0);
			expect(m.meal).not.toBe('');
			expect(m.meal).not.toMatch(/[<>]|&[a-z#]+;/i);
		}
	});

	it('never repeats a (date, meal) pair', () => {
		const keys = menus.map((m) => `${m.serviceDate} ${m.meal}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('returns an empty list for a venue with no published menus', () => {
		expect(parseMenuList('<section><div>Nothing scheduled</div></section>')).toEqual([]);
	});
});
