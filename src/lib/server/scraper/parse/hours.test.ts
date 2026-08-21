import { describe, expect, it } from 'vitest';
import { parseClockTime, parseHours } from './hours.ts';
import { loadFixture } from '../../../../../tests/helpers/fixtures.ts';

describe('parseHours against the captured fixture', () => {
	const hours = parseHours(loadFixture('hours-unit-5.html'));

	it('returns one row per weekday, Sunday first', () => {
		expect(hours).toHaveLength(7);
		expect(hours.map((h) => h.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it('reads the closed state upstream publishes out of term', () => {
		// The capture is from summer, when this venue is closed all week.
		for (const h of hours) {
			expect(h.isClosed).toBe(true);
			expect(h.opens).toBeNull();
			expect(h.closes).toBeNull();
			expect(h.raw).toBe('Closed');
		}
	});

	it('ignores a header row that is not a weekday', () => {
		const withHeader =
			'<table><tr><th>Day</th><th>Hours</th></tr><tr><td>Monday</td><td>Closed</td></tr></table>';
		expect(parseHours(withHeader)).toHaveLength(1);
	});
});

describe('parseClockTime', () => {
	it('converts 12-hour times to 24-hour', () => {
		expect(parseClockTime('7:00 AM')).toBe('07:00');
		expect(parseClockTime('10:30 AM')).toBe('10:30');
		expect(parseClockTime('1:15 PM')).toBe('13:15');
		expect(parseClockTime('11:59 PM')).toBe('23:59');
	});

	it('handles the two times people get wrong', () => {
		expect(parseClockTime('12:00 AM')).toBe('00:00');
		expect(parseClockTime('12:00 PM')).toBe('12:00');
	});

	it('tolerates punctuation and a missing minutes field', () => {
		expect(parseClockTime('9 a.m.')).toBe('09:00');
		expect(parseClockTime('  8:05pm ')).toBe('20:05');
	});

	it('returns null rather than a wrong time for anything else', () => {
		expect(parseClockTime('Closed')).toBeNull();
		expect(parseClockTime('25:00 PM')).toBeNull();
		expect(parseClockTime('')).toBeNull();
		expect(parseClockTime('7:99 AM')).toBeNull();
	});
});

describe('parseHours open-row shapes', () => {
	// NOTE: these shapes are INFERRED. Every live capture so far was taken out
	// of term, when upstream renders `<td colspan='2'>Closed</td>` for every
	// day. The colspan implies two cells when open, but the exact formatting is
	// unverified -- so both plausible layouts are supported, and an
	// unrecognised one degrades to isClosed:false with times null and the text
	// preserved in `raw`. Re-capture during term and tighten this.
	it('reads a two-cell open row', () => {
		const html = '<table><tr><td>Monday</td><td>7:00 AM</td><td>10:00 AM</td></tr></table>';
		expect(parseHours(html)[0]).toMatchObject({
			weekday: 1,
			opens: '07:00',
			closes: '10:00',
			isClosed: false
		});
	});

	it('reads a single-cell range', () => {
		const html = '<table><tr><td>Friday</td><td>11:00 AM - 2:00 PM</td></tr></table>';
		expect(parseHours(html)[0]).toMatchObject({
			weekday: 5,
			opens: '11:00',
			closes: '14:00',
			isClosed: false
		});
	});

	it('numbers split hours for the same day', () => {
		const html =
			'<table>' +
			'<tr><td>Monday</td><td>7:00 AM</td><td>10:00 AM</td></tr>' +
			'<tr><td>Monday</td><td>11:00 AM</td><td>2:00 PM</td></tr>' +
			'</table>';
		expect(parseHours(html).map((h) => h.ordinal)).toEqual([0, 1]);
	});

	it('keeps the raw text when the format is unrecognised, rather than dropping the row', () => {
		const html = '<table><tr><td>Tuesday</td><td>By appointment</td></tr></table>';
		expect(parseHours(html)[0]).toMatchObject({
			weekday: 2,
			opens: null,
			closes: null,
			isClosed: false,
			raw: 'By appointment'
		});
	});
});
