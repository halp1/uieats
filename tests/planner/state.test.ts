import { describe, expect, it } from 'vitest';
import { plannerHref, readPlannerState, replan } from '../../src/lib/planner/state.ts';

const read = (q: string) => readPlannerState(new URLSearchParams(q));

describe('planner state', () => {
	it('round-trips through the query string', () => {
		const state = read(
			'date=2026-10-15&hall=ike&meal=Lunch&nosalad=1&diet=vegan&reserve=300&x=4&x=9&want=12&want=15:2&opt=2'
		);
		expect(state).toEqual({
			date: '2026-10-15',
			hall: 'ike',
			meal: 'Lunch',
			skipSaladBar: true,
			diets: ['vegan'],
			reserve: 300,
			excluded: [4, 9],
			wanted: [
				{ menuItemId: 12, multiplier: 1 },
				{ menuItemId: 15, multiplier: 2 }
			],
			option: 2
		});
		expect(read(plannerHref(state).slice('/plan?'.length))).toEqual(state);
	});

	it('ignores junk rather than throwing', () => {
		const state = read('date=tomorrow&x=-1&x=abc&want=7:99&want=7&reserve=-5&opt=x&diet=<b>');
		expect(state.date).toBeNull();
		expect(state.excluded).toEqual([]);
		expect(state.wanted).toEqual([{ menuItemId: 7, multiplier: 1 }]);
		expect(state.reserve).toBe(0);
		expect(state.option).toBe(0);
		expect(state.diets).toEqual([]);
	});

	it('resets the option when the plan changes', () => {
		const state = read('hall=ike&opt=3');
		expect(replan(state, { excluded: [5] })).toBe('/plan?hall=ike&x=5');
	});
});
