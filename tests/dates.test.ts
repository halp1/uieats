/**
 * Dates.
 *
 * Every date in this app is America/Chicago wall clock, because upstream
 * publishes menus against local calendar days. The failure mode is not a crash
 * — it is a UTC server quietly showing tomorrow's dinner from 7pm Central, or a
 * day being skipped across a DST transition. Neither would look like a bug from
 * the outside, so the arithmetic gets its own tests.
 */
import { describe, expect, it } from 'vitest';
import {
	addDays,
	campusToday,
	describeAge,
	formatCampusDate,
	formatClock,
	isDateInRange,
	mealSort,
	weekdayName,
	weekdayOf
} from '../src/lib/dates.ts';

describe('campusToday', () => {
	it("uses the dining halls' zone, not the server's", () => {
		// 02:30 UTC on the 22nd is 21:30 Central on the 21st. A server using its
		// own clock would send everyone to a menu that is not being served yet.
		expect(campusToday(new Date('2026-08-22T02:30:00Z'))).toBe('2026-08-21');
	});

	it('rolls over at local midnight', () => {
		expect(campusToday(new Date('2026-08-22T04:59:00Z'))).toBe('2026-08-21');
		expect(campusToday(new Date('2026-08-22T05:01:00Z'))).toBe('2026-08-22');
	});

	it('returns the storage format', () => {
		expect(campusToday(new Date('2026-01-05T18:00:00Z'))).toBe('2026-01-05');
	});
});

describe('addDays', () => {
	it.each([
		['2026-08-31', 1, '2026-09-01'],
		['2026-09-01', -1, '2026-08-31'],
		['2026-12-31', 1, '2027-01-01'],
		['2027-01-01', -1, '2026-12-31'],
		['2026-02-28', 1, '2026-03-01'],
		// A leap year, which naive month arithmetic gets wrong.
		['2028-02-28', 1, '2028-02-29'],
		['2028-02-29', 1, '2028-03-01'],
		['2026-08-21', 0, '2026-08-21'],
		['2026-08-21', 21, '2026-09-11']
	])('%s %+d -> %s', (date, days, expected) => {
		expect(addDays(date, days)).toBe(expected);
	});

	it('does not skip or repeat a day across a DST transition', () => {
		// Spring forward and fall back. Date-only arithmetic in local time would
		// shift by 23 or 25 hours here and land on the wrong day.
		expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
		expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
		expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
		expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
	});

	it('round-trips', () => {
		for (const start of ['2026-03-08', '2026-11-01', '2026-12-31', '2028-02-29']) {
			expect(addDays(addDays(start, 14), -14)).toBe(start);
		}
	});
});

describe('weekdayOf', () => {
	it('is 0 for Sunday, matching unit_hours.weekday', () => {
		expect(weekdayOf('2026-08-23')).toBe(0);
		expect(weekdayName('2026-08-23')).toBe('Sunday');
	});

	it('is stable across a DST transition', () => {
		expect(weekdayName('2026-03-08')).toBe('Sunday');
		expect(weekdayName('2026-11-01')).toBe('Sunday');
	});
});

describe('formatCampusDate', () => {
	it('drops the year, which is noise in a heading', () => {
		expect(formatCampusDate('2026-08-21')).toBe('Friday, August 21');
	});

	it('does not zero-pad the day', () => {
		expect(formatCampusDate('2026-09-01')).toBe('Tuesday, September 1');
	});

	it('crosses a month boundary without shifting', () => {
		// The bug this guards: parsing a date-only string as an instant and then
		// formatting it in a negative-offset zone lands on the previous day.
		expect(formatCampusDate('2026-01-01')).toBe('Thursday, January 1');
		expect(formatCampusDate('2026-12-31')).toBe('Thursday, December 31');
	});
});

describe('isDateInRange', () => {
	it('is inclusive on both ends', () => {
		expect(isDateInRange('2026-08-21', '2026-08-21', '2026-08-23')).toBe(true);
		expect(isDateInRange('2026-08-23', '2026-08-21', '2026-08-23')).toBe(true);
		expect(isDateInRange('2026-08-24', '2026-08-21', '2026-08-23')).toBe(false);
	});
});

describe('formatClock', () => {
	it.each([
		['07:00', '7:00 AM'],
		['12:00', '12:00 PM'],
		['00:00', '12:00 AM'],
		['13:30', '1:30 PM'],
		['23:45', '11:45 PM']
	])('%s -> %s', (input, expected) => {
		expect(formatClock(input)).toBe(expected);
	});
});

describe('mealSort', () => {
	it('orders sittings by time of day, not alphabetically', () => {
		const meals = ['Dinner', 'Breakfast', 'Lunch', 'Brunch'];
		expect([...meals].sort((a, b) => mealSort(a) - mealSort(b))).toEqual([
			'Breakfast',
			'Brunch',
			'Lunch',
			'Dinner'
		]);
	});

	it('sorts an unrecognised name last', () => {
		// Upstream also publishes all-day stations in this field ("Waffle Bar"),
		// which is what the hall view's tab bar uses to separate them.
		expect(mealSort('Waffle Bar')).toBe(99);
		expect(mealSort('Dinner')).toBeLessThan(mealSort('Waffle Bar'));
	});

	it('ignores case and surrounding space', () => {
		expect(mealSort('  DINNER ')).toBe(mealSort('Dinner'));
	});
});

describe('describeAge', () => {
	const NOW = 1_760_000_000;

	it.each([
		[NOW, 'just now'],
		[NOW - 30, 'just now'],
		[NOW - 600, '10m ago'],
		[NOW - 3 * 3600, '3h ago'],
		[NOW - 40 * 3600, '40h ago'],
		[NOW - 4 * 86_400, '4d ago']
	])('%d -> %s', (then, expected) => {
		expect(describeAge(then, NOW)).toBe(expected);
	});

	it('says never rather than inventing a duration', () => {
		expect(describeAge(null, NOW)).toBe('never');
	});

	it('never reports a negative age from clock skew', () => {
		expect(describeAge(NOW + 500, NOW)).toBe('just now');
	});
});
