import { describe, expect, it } from 'vitest';
import {
	decodeEntities,
	normalizeItemName,
	normalizeServingSize,
	normalizeWhitespace,
	parseLongDate,
	parseNutrientNumber,
	shortNameFrom,
	slugify
} from './text.ts';

describe('decodeEntities', () => {
	it('decodes the entities upstream actually emits', () => {
		expect(decodeEntities('Grains &amp; Greens')).toBe('Grains & Greens');
		expect(decodeEntities('Don&#39;s Chophouse')).toBe("Don's Chophouse");
		expect(decodeEntities('Corn,&nbsp;Eggs')).toBe('Corn, Eggs');
		expect(decodeEntities('&lt; 1g')).toBe('< 1g');
		expect(decodeEntities('&quot;house&quot;')).toBe('"house"');
	});

	it('decodes numeric and hex references', () => {
		expect(decodeEntities('caf&#233;')).toBe('café');
		expect(decodeEntities('caf&#xe9;')).toBe('café');
	});

	it('decodes &amp;amp; to &amp; in one pass, not to &', () => {
		// Double-decoding is how "&amp;" in real data turns into a broken name.
		expect(decodeEntities('A &amp;amp; B')).toBe('A &amp; B');
	});

	it('leaves text with no entities untouched', () => {
		expect(decodeEntities('Blondie Bars')).toBe('Blondie Bars');
	});
});

describe('normalizeWhitespace', () => {
	it('collapses runs and trims, including the nbsp upstream pads with', () => {
		expect(normalizeWhitespace('  Menu   For \r\n\t Lunch  ')).toBe('Menu For Lunch');
		expect(normalizeWhitespace('a  b')).toBe('a b');
	});
});

describe('normalizeItemName', () => {
	// Conservative on purpose: two different dishes colliding here would make
	// one inherit the other's allergens.
	it('lowercases, decodes and collapses', () => {
		expect(normalizeItemName('  Grains &amp; Greens  ')).toBe('grains & greens');
	});

	it('strips trailing punctuation only', () => {
		expect(normalizeItemName('Chocolate Chip Cookies.')).toBe('chocolate chip cookies');
		expect(normalizeItemName('Soup of the Day -')).toBe('soup of the day');
	});

	it('keeps parentheticals, which distinguish real dishes', () => {
		expect(normalizeItemName('Pizza (Gluten Free)')).toBe('pizza (gluten free)');
		expect(normalizeItemName('Pizza')).not.toBe(normalizeItemName('Pizza (Gluten Free)'));
	});

	it('does not stem or drop stopwords', () => {
		expect(normalizeItemName('Chicken Breast')).not.toBe(normalizeItemName('Chicken Breasts'));
		expect(normalizeItemName('Cream of Broccoli')).toBe('cream of broccoli');
	});

	it('distinguishes dishes that differ only by a qualifier', () => {
		expect(normalizeItemName('Halal Orange & Tarragon Chicken Salad')).not.toBe(
			normalizeItemName('Orange & Tarragon Chicken Salad')
		);
	});
});

describe('normalizeServingSize', () => {
	it('normalizes case and whitespace', () => {
		expect(normalizeServingSize('  Slice  (1/96) ')).toBe('slice (1/96)');
	});

	it('maps a missing serving size to the empty string, not null', () => {
		// The uniqueness index uses COALESCE(serving_size_norm, ''); keeping the
		// normalizer total avoids two spellings of "no serving size".
		expect(normalizeServingSize(null)).toBe('');
		expect(normalizeServingSize('   ')).toBe('');
	});
});

describe('parseLongDate', () => {
	// Upstream dates are America/Chicago wall clock. Constructing a Date here
	// would reinterpret them in the server's zone and shift the day.
	it('parses the format upstream emits', () => {
		expect(parseLongDate('Thursday, August 13, 2026')).toBe('2026-08-13');
		expect(parseLongDate('Tuesday, September 1, 2026')).toBe('2026-09-01');
		expect(parseLongDate('Sunday, January 4, 2026')).toBe('2026-01-04');
	});

	it('tolerates padding and nbsp', () => {
		expect(parseLongDate('  Friday,&nbsp;August 21, 2026 ')).toBe('2026-08-21');
	});

	it('returns null for anything it does not recognise', () => {
		expect(parseLongDate('Someday, Smarch 40, 2026')).toBeNull();
		expect(parseLongDate('')).toBeNull();
		expect(parseLongDate('2026-08-13')).toBeNull();
	});

	it('rejects an out-of-range day rather than rolling it over', () => {
		expect(parseLongDate('Monday, February 30, 2026')).toBeNull();
	});
});

describe('parseNutrientNumber', () => {
	it('reads plain values with their unit suffix', () => {
		expect(parseNutrientNumber('8g')).toEqual({ value: 8, isLessThan: false });
		expect(parseNutrientNumber(' 4.5g ')).toEqual({ value: 4.5, isLessThan: false });
		expect(parseNutrientNumber('150mg')).toEqual({ value: 150, isLessThan: false });
		expect(parseNutrientNumber('180')).toEqual({ value: 180, isLessThan: false });
		expect(parseNutrientNumber('0%')).toEqual({ value: 0, isLessThan: false });
	});

	it('reads "< 1g" as 0.5 and flags it, rather than dropping the bound', () => {
		expect(parseNutrientNumber('< 1g')).toEqual({ value: 0.5, isLessThan: true });
		expect(parseNutrientNumber('&lt; 1g')).toEqual({ value: 0.5, isLessThan: true });
	});

	it('maps NA and blank to null -- NOT to zero', () => {
		// "Trans Fat: NA" means unknown. Recording it as 0 would be a lie a
		// user could act on.
		expect(parseNutrientNumber('NA')).toEqual({ value: null, isLessThan: false });
		expect(parseNutrientNumber('&nbsp;')).toEqual({ value: null, isLessThan: false });
		expect(parseNutrientNumber('')).toEqual({ value: null, isLessThan: false });
		expect(parseNutrientNumber(null)).toEqual({ value: null, isLessThan: false });
	});
});

describe('slugify', () => {
	it('produces url-safe slugs', () => {
		expect(slugify('Ikenberry Dining Center (Ike)')).toBe('ikenberry-dining-center-ike');
		expect(slugify("Don's Chophouse")).toBe('dons-chophouse');
		expect(slugify('Grains & Greens')).toBe('grains-greens');
		expect(slugify('57 North')).toBe('57-north');
	});

	it('never emits leading, trailing or repeated separators', () => {
		expect(slugify('  --Hello--  World--  ')).toBe('hello-world');
	});
});

describe('shortNameFrom', () => {
	it('pulls the parenthesised abbreviation halls are labelled with', () => {
		expect(shortNameFrom('Ikenberry Dining Center (Ike)')).toBe('Ike');
		expect(shortNameFrom('Illinois Street Dining Center (ISR)')).toBe('ISR');
	});

	it('returns null when there is no abbreviation', () => {
		expect(shortNameFrom('Field of Greens')).toBeNull();
		// A parenthetical that is not an abbreviation should not be adopted.
		expect(shortNameFrom('Pizza (Gluten Free Crust Available Daily)')).toBeNull();
	});
});
