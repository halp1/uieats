/**
 * Shapes shared by the planner's pure modules, the loader that feeds them and
 * the page that renders the result.
 */

/** Per serving, exactly as the label gives it. */
export interface Nutrients {
	calories: number;
	proteinG: number;
	carbG: number;
	fatG: number;
	/**
	 * The four below are often left blank upstream. A blank is carried as null
	 * and counted as zero in a total -- the page says when a total rests on
	 * blanks, rather than pretending they were read.
	 */
	fiberG: number | null;
	sugarG: number | null;
	sodiumMg: number | null;
	satFatG: number | null;
}

/** One dish instance on the menu being planned from. */
export interface Candidate {
	menuItemId: number;
	itemId: number;
	slug: string;
	name: string;
	venue: string;
	/** The upstream `meal` the dish was listed under: a sitting or a station. */
	station: string;
	category: string;
	servingText: string | null;
	servingGrams: number | null;
	/** null when the label is missing calories or any of the three macros. */
	nutrients: Nutrients | null;
	/** Diet trait slugs, for the diet filter. */
	traits: string[];
}
