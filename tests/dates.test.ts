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
	campusHour,
	campusToday,
	currentMeal,
	defaultMeal,
	mealAtHour,
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

describe('campusHour', () => {
	it('is the campus clock, not the server clock', () => {
		// 02:30 UTC is 21:30 the previous evening in Chicago. A server reading its
		// own clock would call that breakfast time.
		expect(campusHour(new Date('2026-08-22T02:30:00Z'))).toBe(21);
	});

	it('tracks the DST offset rather than assuming one', () => {
		// 15:00 UTC is 09:00 CDT in summer and 09:00 CST in winter -- different
		// offsets, same local hour, which is the point.
		expect(campusHour(new Date('2026-07-01T14:00:00Z'))).toBe(9);
		expect(campusHour(new Date('2026-01-01T15:00:00Z'))).toBe(9);
	});
});

describe('mealAtHour', () => {
	it.each([
		[0, 'Breakfast'],
		[7, 'Breakfast'],
		[9, 'Breakfast'],
		// The boundaries, exactly: 10:00 is lunch, 14:00 is dinner.
		[10, 'Lunch'],
		[13, 'Lunch'],
		[14, 'Dinner'],
		[19, 'Dinner'],
		[23, 'Dinner']
	])('%d:00 -> %s', (hour, expected) => {
		expect(mealAtHour(hour)).toBe(expected);
	});

	it('maps every hour to a sitting, with no gaps', () => {
		// There is deliberately no "closed" answer: at 22:00 you are looking at
		// what dinner was, not at nothing.
		for (let h = 0; h < 24; h++) {
			expect(['Breakfast', 'Lunch', 'Dinner']).toContain(mealAtHour(h));
		}
	});

	it('is what currentMeal reports for the same instant', () => {
		const at = new Date('2026-08-21T18:00:00Z'); // 13:00 CDT
		expect(currentMeal(at)).toBe(mealAtHour(campusHour(at)));
		expect(currentMeal(at)).toBe('Lunch');
	});
});

describe('defaultMeal', () => {
	const ALL = ['Breakfast', 'Lunch', 'Dinner'];
	const TODAY = '2026-08-21';
	const at = (hour: number) => new Date(`2026-08-21T${String(hour + 5).padStart(2, '0')}:00:00Z`);

	it('opens on the sitting being served now', () => {
		expect(defaultMeal(ALL, { date: TODAY, today: TODAY, at: at(8) })).toBe('Breakfast');
		expect(defaultMeal(ALL, { date: TODAY, today: TODAY, at: at(12) })).toBe('Lunch');
		expect(defaultMeal(ALL, { date: TODAY, today: TODAY, at: at(18) })).toBe('Dinner');
	});

	it('ignores the clock on any other day', () => {
		// The time of day says what you want NOW; it says nothing about a day you
		// are planning for. Opening next Tuesday at 21:00 starts at its top.
		expect(defaultMeal(ALL, { date: '2026-08-25', today: TODAY, at: at(21) })).toBe('Breakfast');
	});

	it('falls forward to the next sitting a venue actually serves', () => {
		// Lunch-and-dinner venue, opened at breakfast time.
		expect(defaultMeal(['Lunch', 'Dinner'], { date: TODAY, today: TODAY, at: at(8) })).toBe(
			'Lunch'
		);
	});

	it('falls back when there is nothing later', () => {
		// A breakfast-only venue opened in the evening lands on breakfast rather
		// than on nothing.
		expect(defaultMeal(['Breakfast'], { date: TODAY, today: TODAY, at: at(19) })).toBe('Breakfast');
	});

	it('handles the sittings between the named ones', () => {
		expect(
			defaultMeal(['Breakfast', 'Light Lunch', 'Dinner'], { date: TODAY, today: TODAY, at: at(12) })
		).toBe('Light Lunch');
	});

	it('never auto-selects an all-day station', () => {
		// Upstream files "Beverages" and "Waffle Bar" under `meal` too. Those are
		// chosen deliberately or not at all -- opening Build Your Own on Condiments
		// because of the hour would be absurd.
		expect(
			defaultMeal(['Breakfast', 'Beverages', 'Waffle Bar'], {
				date: TODAY,
				today: TODAY,
				at: at(19)
			})
		).toBe('Breakfast');
	});

	it('takes the first entry when a venue offers no recognisable sitting', () => {
		expect(
			defaultMeal(['Beverages', 'Condiments'], { date: TODAY, today: TODAY, at: at(12) })
		).toBe('Beverages');
	});

	it('has nothing to say about an empty menu', () => {
		expect(defaultMeal([], { date: TODAY, today: TODAY, at: at(12) })).toBeNull();
	});
});
