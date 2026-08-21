/**
 * Dates in this app are America/Chicago wall clock, always.
 *
 * This lives in `$lib` rather than `$lib/server` deliberately. It is pure --
 * no I/O, no secrets -- and the same formatting has to run in components as
 * well as loaders. Under `server/` SvelteKit's build guard rejects it, and
 * rightly: that directory is a boundary, not a junk drawer for shared code.
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

/**
 * Day of week for a 'YYYY-MM-DD' date, 0 = Sunday to match unit_hours.weekday.
 *
 * Parsed as UTC on purpose. The input is a date with no time in it, so there is
 * no instant to convert and nothing for a zone to shift; going through local
 * time would make the answer depend on the server's offset.
 */
export function weekdayOf(date: string): number {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
];

export function weekdayName(date: string): string {
	return WEEKDAY_NAMES[weekdayOf(date)];
}

/** 'Thursday, August 20' -- for headings, where the year is just noise. */
export function formatCampusDate(date: string): string {
	const [y, m, d] = date.split('-').map(Number);
	const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
		new Date(Date.UTC(y, m - 1, d))
	);
	return `${weekdayName(date)}, ${month} ${d}`;
}

/** '12:30 PM' from stored 'HH:MM'. */
export function formatClock(hhmm: string): string {
	const [h, m] = hhmm.split(':').map(Number);
	const suffix = h < 12 ? 'AM' : 'PM';
	const hour12 = h % 12 === 0 ? 12 : h % 12;
	return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** 'updated 3h ago' -- the footer's freshness line. */
export function describeAge(then: number | null, at: number = unixNow()): string {
	if (then === null) return 'never';
	const seconds = Math.max(0, at - then);
	if (seconds < 90) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(seconds / 3600);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * When menu data stops being trustworthy enough to present quietly.
 *
 * The scrape runs nightly, so 30 hours means a full run has been missed. Past
 * that the footer switches from informational to a warning: stale menus must be
 * visible, never silent.
 */
export const STALE_AFTER_SECONDS = 30 * 60 * 60;
