/**
 * Text normalization, in exactly one place.
 *
 * Every parser routes its strings through here. Decoding entities in two
 * places is how "Don&#39;s Chophouse" ends up stored two different ways.
 */

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	'#39': "'"
};

/**
 * Single-pass decode. Passing over the string once matters: decoding
 * repeatedly would turn a literal "&amp;amp;" into "&", losing a character
 * that was really in the data.
 */
export function decodeEntities(input: string): string {
	return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
		const lower = body.toLowerCase();
		if (lower.startsWith('#x')) {
			const code = Number.parseInt(lower.slice(2), 16);
			return Number.isNaN(code) ? whole : String.fromCodePoint(code);
		}
		if (lower.startsWith('#')) {
			const code = Number.parseInt(lower.slice(1), 10);
			return Number.isNaN(code) ? whole : String.fromCodePoint(code);
		}
		return NAMED[lower] ?? whole;
	});
}

/** Collapses all whitespace runs (including decoded nbsp) and trims. */
export function normalizeWhitespace(input: string): string {
	// \s already matches U+00A0, so decoded nbsp collapses here too.
	return input.replace(/\s+/g, ' ').trim();
}

function clean(input: string): string {
	return normalizeWhitespace(decodeEntities(input));
}

/**
 * The dish identity key.
 *
 * Deliberately conservative: lowercase, decode, collapse whitespace, and strip
 * trailing punctuation. No stemming, no stopword removal, no dropping
 * parentheticals -- two distinct dishes colliding on this key would make one
 * inherit the other's allergen data, which is a safety bug rather than a
 * cosmetic one.
 */
export function normalizeItemName(input: string): string {
	return clean(input)
		.toLowerCase()
		.replace(/[\s.,;:\-*]+$/, '');
}

/** Total by design: "no serving size" has exactly one spelling, the empty string. */
export function normalizeServingSize(input: string | null | undefined): string {
	if (!input) return '';
	return clean(input).toLowerCase();
}

const MONTHS: Record<string, number> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12
};

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * "Thursday, August 13, 2026" -> "2026-08-13".
 *
 * Returns a plain string and never constructs a Date. Upstream dates are
 * America/Chicago wall clock; letting Date reinterpret them in the server's
 * zone shifts the menu by a day for anyone running in UTC.
 */
export function parseLongDate(input: string): string | null {
	const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(clean(input));
	if (!match) return null;

	const month = MONTHS[match[1].toLowerCase()];
	if (!month) return null;

	const day = Number(match[2]);
	if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;

	const year = Number(match[3]);
	// Leap years: February 29 is allowed above, so reject it only when invalid.
	if (month === 2 && day === 29 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) {
		return null;
	}

	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface NutrientValue {
	value: number | null;
	isLessThan: boolean;
}

/**
 * Reads one cell of a nutrition label.
 *
 * Two upstream conventions are load-bearing:
 *   "NA" / blank  -> null. Recording unknown as 0 would be a lie a user acts on.
 *   "< 1g"        -> 0.5 with isLessThan set, so the bound is not silently lost.
 */
export function parseNutrientNumber(input: string | null | undefined): NutrientValue {
	if (input == null) return { value: null, isLessThan: false };

	const text = clean(input);
	if (text === '' || /^n\/?a$/i.test(text)) return { value: null, isLessThan: false };

	const isLessThan = text.startsWith('<');
	const match = /-?\d+(?:\.\d+)?/.exec(text);
	if (!match) return { value: null, isLessThan: false };

	const raw = Number(match[0]);
	return isLessThan ? { value: raw / 2, isLessThan: true } : { value: raw, isLessThan: false };
}

export function slugify(input: string): string {
	return (
		clean(input)
			.toLowerCase()
			// Apostrophes vanish rather than becoming separators, so Don's Chophouse
			// slugs as dons-chophouse and not don-s-chophouse.
			.replace(/['’]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
	);
}

/**
 * Halls are labelled "Ikenberry Dining Center (Ike)". Only adopt the
 * parenthetical when it reads like an abbreviation, so a descriptive aside
 * does not become a display name.
 */
export function shortNameFrom(name: string): string | null {
	const match = /\(([^)]{1,8})\)\s*$/.exec(clean(name));
	if (!match) return null;
	const inner = match[1].trim();
	return /^[A-Za-z0-9 .&'-]+$/.test(inner) && !inner.includes(' ') ? inner : null;
}
