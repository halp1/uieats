/**
 * The only regex in the scraper.
 *
 * NetNutrition encodes every identifier inside an inline event handler:
 *
 *   onclick="javascript:NetNutrition.UI.unitsSelectUnit(1);"
 *   onclick='NetNutrition.UI.toggleCourseItems(this, 12);'
 *
 * An HTML parser gets us to the attribute; only a regex gets us inside it.
 * Confining that to one tested function is the point of this module.
 */

const cache = new Map<string, RegExp>();

function patternFor(fnName: string, argIndex: number): RegExp {
	const key = `${fnName} ${argIndex}`;
	let re = cache.get(key);
	if (!re) {
		// The lookbehind excludes a preceding word character but NOT a dot, so
		// `NetNutrition.UI.unitsSelectUnit` still matches while
		// `childUnitsSelectUnit` does not satisfy a request for
		// `unitsSelectUnit` -- a real collision in this API.
		const skipped = '\\s*[^,()]*,'.repeat(argIndex);
		// The sign is not optional decoration. Upstream marks a course group that
		// has no name with the sentinel id -1234
		// (`toggleCourseItems(this, -1234)`), and a digits-only pattern returns
		// null for it -- which made every dish under that heading disappear,
		// because persistence drops items whose category it never saw. Real oids
		// are positive; callers that need that guarantee check it themselves.
		re = new RegExp(`(?<!\\w)${fnName}\\s*\\(${skipped}\\s*(-?\\d+)\\s*[,)]`, 'g');
		cache.set(key, re);
	}
	re.lastIndex = 0;
	return re;
}

/** First oid passed to `fnName`, or null. `argIndex` selects which argument. */
export function extractOid(source: string, fnName: string, argIndex = 0): number | null {
	const match = patternFor(fnName, argIndex).exec(source);
	return match ? Number(match[1]) : null;
}

/** Every distinct oid passed to `fnName`, in document order. */
export function extractOids(source: string, fnName: string, argIndex = 0): number[] {
	const re = patternFor(fnName, argIndex);
	const seen = new Set<number>();
	for (let m = re.exec(source); m !== null; m = re.exec(source)) {
		seen.add(Number(m[1]));
	}
	return [...seen];
}
