/**
 * The single enforcement point for the safety model.
 *
 * Nothing else in this codebase may decide whether an item is a problem for a
 * user. Every chip, badge, filter and sort order downstream reads its severity
 * from `verdictFor`, which is a pure function of evidence -- so the rules are
 * auditable in one file and testable without a database.
 *
 * THE INVARIANT:
 *
 *   If an item has no nutrition label yet, the verdict is `unknown` for every
 *   allergen EXCEPT the 18 carrying covered_by_trait_vocabulary = 1. Upstream
 *   tags those on the item row itself, so the absence of an icon is weak
 *   evidence. For everything else -- mustard, celery, anchovy, a specific nut
 *   species -- absence of evidence is not evidence of absence.
 *
 * And the rule that shapes every string in here: `no-declared` must never
 * render as the word "safe". This app assists a decision; it does not certify
 * anything. Shared fryers and serving utensils are a real risk that no amount
 * of label data can capture, which is why the layout carries a permanent
 * cross-contact disclaimer alongside whatever this function returns.
 */

export type Verdict =
	/** Trait icon or "Contains:" line -- upstream's own declaration. */
	| 'flagged-declared'
	/** A keyword hit in the ingredient text. */
	| 'flagged-likely'
	/** The item name only; the weakest signal we act on. */
	| 'flagged-possible'
	/** Something was read and this allergen was not in it. */
	| 'no-declared'
	/** Nothing has been read that could have shown it. */
	| 'unknown';

/** Where a piece of evidence came from, strongest first. */
export type EvidenceSource = 'trait' | 'contains' | 'ingredient' | 'name';

export interface AllergenRef {
	id: number;
	slug: string;
	label: string;
	/**
	 * True for the 18 allergens upstream tags with an icon on every item row.
	 * ONLY these may soften to `no-declared` without a label. See the invariant
	 * at the top of this file.
	 */
	coveredByTraitVocabulary: boolean;
}

export interface EvidenceItem {
	source: EvidenceSource;
	/** The allergen actually hit. May be a descendant of the queried one. */
	slug: string;
	label: string;
	/** Human-readable and auditable, e.g. 'Contains: Milk'. */
	text: string;
}

export interface VerdictInput {
	/** The allergen being asked about. May be a group such as Tree Nuts. */
	allergen: AllergenRef;
	/** Has a nutrition label been fetched for this item instance? */
	hasLabel: boolean;
	/** Did that label actually carry an ingredient list? */
	hasIngredientText: boolean;
	/** Evidence for this allergen or any of its descendants. */
	evidence: EvidenceItem[];
	/**
	 * Umbrella ingredient terms found on the label ("SPICES", "NATURAL
	 * FLAVOR"). These hide their own contents, so they downgrade the meaning of
	 * "not found" without themselves being a hit.
	 */
	hiddenSources?: string[];
}

export interface VerdictResult {
	verdict: Verdict;
	allergen: AllergenRef;
	/** Chip text, e.g. 'Milk' or 'Tree Nuts — Macadamia'. */
	chipLabel: string;
	/** Why we say that. Always present, never reassuring. */
	basis: string;
	/** Strongest first, so the UI can show the best reason at a glance. */
	evidence: EvidenceItem[];
	advisory: string | null;
	/** Sort key; higher demands more attention. */
	severityRank: number;
	/** True when this should read as a warning rather than an observation. */
	isWarning: boolean;
}

/**
 * Any output matching this is a bug, and `verdict.test.ts` asserts it over the
 * whole input space. Wording that implies clearance is exactly the failure this
 * module exists to prevent: an item can only ever be "not declared", and the
 * distance between that and "safe" is the entire product.
 */
export const NEVER_SAFE_PATTERN =
	/\b(safe|safely|allergen[- ]free|allergy[- ]free|free of|free from|no risk|risk[- ]free|ok to eat|okay to eat|suitable for|clear of|guaranteed)\b/i;

/** Evidence strength, and therefore which verdict a hit produces. */
const SOURCE_RANK: Record<EvidenceSource, number> = {
	trait: 4,
	contains: 3,
	ingredient: 2,
	name: 1
};

/**
 * Source, not the stored `confidence` column, decides the tier.
 *
 * match.ts rates an ingredient hit `likely` when a parent group was declared
 * and `possible` otherwise -- useful nuance for the evidence text, but it would
 * demote mustard and celery to the weakest tier purely because upstream has no
 * vocabulary in which to declare them. An ingredient list naming MUSTARD SEED
 * is strong evidence regardless of what upstream chose to tag, so the mapping
 * keys on where the text came from.
 */
const VERDICT_FOR_SOURCE: Record<EvidenceSource, Verdict> = {
	trait: 'flagged-declared',
	contains: 'flagged-declared',
	ingredient: 'flagged-likely',
	name: 'flagged-possible'
};

const SEVERITY_RANK: Record<Verdict, number> = {
	'flagged-declared': 4,
	'flagged-likely': 3,
	'flagged-possible': 2,
	// Above no-declared deliberately: an unverified item is the one a user needs
	// to look at, so it must never sort below one we have actually read.
	unknown: 1,
	'no-declared': 0
};

function advisoryFor(hiddenSources: string[]): string | null {
	if (hiddenSources.length === 0) return null;
	const list = [...new Set(hiddenSources)].join(', ');
	return `The ingredient list defers to umbrella terms (${list}), which do not name what they contain.`;
}

export function verdictFor(input: VerdictInput): VerdictResult {
	const { allergen, hasLabel, hasIngredientText } = input;
	const hiddenSources = input.hiddenSources ?? [];

	// Strongest evidence first. Weaker evidence is kept rather than discarded --
	// it is not wrong, just less load-bearing, and a user auditing a warning
	// wants every reason we have.
	const evidence = [...input.evidence].sort(
		(a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source]
	);
	const strongest = evidence[0];

	if (strongest) {
		const verdict = VERDICT_FOR_SOURCE[strongest.source];
		// "Tree Nuts — Macadamia" when the prose resolved a group to a species.
		const chipLabel =
			strongest.slug === allergen.slug ? allergen.label : `${allergen.label} — ${strongest.label}`;

		return {
			verdict,
			allergen,
			chipLabel,
			basis: strongest.text,
			evidence,
			// An advisory would only dilute an already-actionable warning.
			advisory: null,
			severityRank: SEVERITY_RANK[verdict],
			isWarning: true
		};
	}

	// No evidence. What that means depends entirely on what we have actually
	// read, which is where the invariant lives.
	const readIngredients = hasLabel && hasIngredientText;

	if (!readIngredients && !allergen.coveredByTraitVocabulary) {
		return {
			verdict: 'unknown',
			allergen,
			chipLabel: `${allergen.label} unverified`,
			basis: hasLabel
				? `This item's label carries no ingredient list, and upstream never tags ${allergen.label} on the menu row. Nothing here could have shown it.`
				: `No nutrition label has been fetched for this item yet, and upstream never tags ${allergen.label} on the menu row. Nothing here could have shown it.`,
			evidence,
			advisory: advisoryFor(hiddenSources),
			severityRank: SEVERITY_RANK.unknown,
			isWarning: false
		};
	}

	// `no-declared` -- the only verdict that could be misread as clearance, so
	// its wording is the most careful in the file. It says what was checked and
	// stops there.
	const basis = readIngredients
		? allergen.coveredByTraitVocabulary
			? `Upstream declares ${allergen.label} on items that contain it, and this item's menu row and ingredient list were both read without a match.`
			: `${allergen.label} was not found in this item's ingredient list. Upstream never declares it, so this rests on the ingredient text alone.`
		: `Upstream tags ${allergen.label} on every item row that contains it, and this row carries no such tag. The full ingredient list has not been read yet.`;

	return {
		verdict: 'no-declared',
		allergen,
		chipLabel: `No ${allergen.label} declared`,
		basis,
		evidence,
		advisory: advisoryFor(hiddenSources),
		severityRank: SEVERITY_RANK['no-declared'],
		isWarning: false
	};
}

/** The single verdict a menu row should show: whichever needs most attention. */
export function worstVerdict(results: VerdictResult[]): VerdictResult | null {
	let worst: VerdictResult | null = null;
	for (const r of results) {
		if (!worst || r.severityRank > worst.severityRank) worst = r;
	}
	return worst;
}

export interface ItemAllergenSummary {
	verdicts: VerdictResult[];
	worst: VerdictResult | null;
	hasWarning: boolean;
	hasUnknown: boolean;
	/**
	 * True only when every one of the user's allergens was actually resolved.
	 * "No warnings" and "we checked" are different claims, and conflating them
	 * is how a UI ends up implying safety it cannot support.
	 */
	allChecked: boolean;
}

export function summarizeItem(inputs: VerdictInput[]): ItemAllergenSummary {
	const verdicts = inputs
		.map(verdictFor)
		.sort(
			(a, b) => b.severityRank - a.severityRank || a.allergen.slug.localeCompare(b.allergen.slug)
		);

	return {
		verdicts,
		worst: worstVerdict(verdicts),
		hasWarning: verdicts.some((v) => v.isWarning),
		hasUnknown: verdicts.some((v) => v.verdict === 'unknown'),
		allChecked: verdicts.length > 0 && verdicts.every((v) => v.verdict !== 'unknown')
	};
}
