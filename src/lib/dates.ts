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

/** Campus wall-clock hour, 0-23, for the given instant. */
export function campusHour(at: Date = new Date()): number {
	return Number(
		new Intl.DateTimeFormat('en-GB', {
			timeZone: CAMPUS_TIME_ZONE,
			hour: '2-digit',
			hour12: false
		}).format(at)
	);
}

/**
 * Which sitting a person opening the app right now is most likely asking about.
 *
 * Boundaries are 10:00 and 14:00 campus time. They are cutoffs rather than
 * service windows on purpose: at 09:00 you are choosing breakfast, and at 22:00
 * you are looking at what dinner was, so there is no "closed" answer -- every
 * hour maps to a sitting.
 */
export function mealAtHour(hour: number): 'Breakfast' | 'Lunch' | 'Dinner' {
	if (hour < 10) return 'Breakfast';
	if (hour < 14) return 'Lunch';
	return 'Dinner';
}

export function currentMeal(at: Date = new Date()): 'Breakfast' | 'Lunch' | 'Dinner' {
	return mealAtHour(campusHour(at));
}

/**
 * The sitting to open a location on.
 *
 * Only applied to TODAY. Opening next Tuesday at 21:00 should start at the top
 * of that day rather than at its dinner -- the time of day says something about
 * what you want now, and nothing about a day you are planning for.
 *
 * Falls forward, then back, through the sittings the venue actually offers: a
 * dinner-only venue opened at breakfast time should land on dinner rather than
 * on nothing. Anything upstream files under `meal` that is not a sitting at all
 * -- the all-day stations, "Beverages", "Waffle Bar" -- is never auto-selected,
 * only ever chosen deliberately.
 */
export function defaultMeal(
	available: readonly string[],
	options: { date: string; today: string; at?: Date }
): string | null {
	if (available.length === 0) return null;

	const sittings = ['Breakfast', 'Brunch', 'Lunch', 'Light Lunch', 'Dinner', 'Late Night'];
	const offered = available.filter((m) => sittings.includes(m));

	// A different day, or a venue with no recognisable sitting at all: take the
	// first thing on offer, which mealSort has already put in serving order.
	if (options.date !== options.today || offered.length === 0) return available[0];

	const wanted = currentMeal(options.at ?? new Date());
	const wantedRank = sittings.indexOf(wanted);

	// Nearest at or after the current sitting, else the last one before it.
	const after = offered.find((m) => sittings.indexOf(m) >= wantedRank);
	return after ?? offered[offered.length - 1];
}
