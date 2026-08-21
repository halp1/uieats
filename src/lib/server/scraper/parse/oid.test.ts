import { describe, expect, it } from 'vitest';
import { extractOid, extractOids } from './oid.ts';

// Upstream puts every id inside an inline handler string, so this is the one
// place in the codebase where a regex is the right tool. It is also the single
// point of failure for the whole scraper, hence the exhaustive cases.
describe('extractOid', () => {
	it('reads an oid out of a javascript: handler', () => {
		expect(extractOid('javascript:NetNutrition.UI.unitsSelectUnit(1);', 'unitsSelectUnit')).toBe(1);
	});

	it('reads an oid with no javascript: prefix', () => {
		expect(extractOid('NetNutrition.UI.childUnitsSelectUnit(10);', 'childUnitsSelectUnit')).toBe(
			10
		);
	});

	it('tolerates whitespace around the argument', () => {
		expect(extractOid('NetNutrition.UI.menuListSelectMenu( 1440348 )', 'menuListSelectMenu')).toBe(
			1440348
		);
	});

	it('reads the second argument of toggleCourseItems', () => {
		expect(extractOid('NetNutrition.UI.toggleCourseItems(this, 12);', 'toggleCourseItems', 1)).toBe(
			12
		);
	});

	it('returns null rather than guessing when the function is absent', () => {
		expect(extractOid('NetNutrition.UI.somethingElse(5)', 'unitsSelectUnit')).toBeNull();
		expect(extractOid('', 'unitsSelectUnit')).toBeNull();
	});

	it('does not match a different function that merely shares a prefix', () => {
		// childUnitsSelectUnit must not satisfy a request for unitsSelectUnit.
		expect(extractOid('NetNutrition.UI.childUnitsSelectUnit(7)', 'unitsSelectUnit')).toBeNull();
	});

	it('returns the first oid when several are present', () => {
		expect(extractOid('a(1) unitsSelectUnit(4); unitsSelectUnit(9)', 'unitsSelectUnit')).toBe(4);
	});

	it('ignores a non-numeric argument instead of producing NaN', () => {
		expect(extractOid('NetNutrition.UI.unitsSelectUnit(this)', 'unitsSelectUnit')).toBeNull();
	});
});

describe('extractOids', () => {
	it('collects every occurrence in document order, de-duplicated', () => {
		const html = 'x(1) menuListSelectMenu(30) y menuListSelectMenu(10) z menuListSelectMenu(30)';
		expect(extractOids(html, 'menuListSelectMenu')).toEqual([30, 10]);
	});

	it('returns an empty array when there are none', () => {
		expect(extractOids('<div>nothing here</div>', 'menuListSelectMenu')).toEqual([]);
	});
});

describe('signed ids', () => {
	// Upstream marks a course group with no name using the sentinel -1234. A
	// digits-only pattern returned null for it, the heading was skipped, and
	// persistence then dropped every dish underneath -- food silently missing
	// from a menu in an allergen app. Real oids are positive; this only has to
	// not lose the sign.
	it('reads the negative course sentinel', () => {
		expect(
			extractOid('NetNutrition.UI.toggleCourseItems(this, -1234);', 'toggleCourseItems', 1)
		).toBe(-1234);
	});

	it('still reads a normal positive course id', () => {
		expect(extractOid('NetNutrition.UI.toggleCourseItems(this, 12);', 'toggleCourseItems', 1)).toBe(
			12
		);
	});

	it('does not invent a number where there is none', () => {
		expect(
			extractOid('NetNutrition.UI.toggleCourseItems(this, x);', 'toggleCourseItems', 1)
		).toBeNull();
		expect(
			extractOid('NetNutrition.UI.toggleCourseItems(this, -);', 'toggleCourseItems', 1)
		).toBeNull();
	});

	it('collects signed ids too', () => {
		expect(
			extractOids(
				'toggleCourseItems(this, -1234); toggleCourseItems(this, 9);',
				'toggleCourseItems',
				1
			)
		).toEqual([-1234, 9]);
	});
});
