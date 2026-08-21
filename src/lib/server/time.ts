/**
 * Dates in this app are America/Chicago wall clock, always.
 *
 * Upstream publishes menus by local calendar day. A server running in UTC that
 * used `new Date().toISOString()` would roll over to tomorrow's menu at 7pm
 * Central, so "today" must be computed in the dining halls' zone rather than
 * the server's.
 */
export const CAMPUS_TIME_ZONE = 'America/Chicago';

// en-CA formats as YYYY-MM-DD, which is exactly our storage format.
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
	timeZone: CAMPUS_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/** 'YYYY-MM-DD' for the given instant (default: now) on campus. */
export function campusToday(at: Date = new Date()): string {
	return DATE_FORMAT.format(at);
}

/**
 * Shifts a 'YYYY-MM-DD' string by whole days.
 *
 * Uses UTC arithmetic on a date-only value deliberately: the input carries no
 * time, so there is no DST transition to land inside. Doing this in local time
 * would shift by 23 or 25 hours across a transition and skip or repeat a day.
 */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number);
	const shifted = new Date(Date.UTC(y, m - 1, d + days));
	return shifted.toISOString().slice(0, 10);
}

/** Inclusive on both ends. */
export function isDateInRange(date: string, from: string, to: string): boolean {
	return date >= from && date <= to;
}

export function unixNow(at: Date = new Date()): number {
	return Math.floor(at.getTime() / 1000);
}

/**
 * Sort key for meals. Upstream gives no ordering, and alphabetical would put
 * Dinner before Lunch. Unknown meals sort last but stay stable.
 */
const MEAL_ORDER: Record<string, number> = {
	breakfast: 10,
	brunch: 20,
	lunch: 30,
	'light lunch': 35,
	dinner: 40,
	'late night': 50
};

export function mealSort(meal: string): number {
	return MEAL_ORDER[meal.trim().toLowerCase()] ?? 99;
}
