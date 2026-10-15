/**
 * What part of a plate a dish is.
 *
 * A balanced meal is a structural idea before it is a numerical one: something
 * with protein, something starchy, something green. Optimising the numbers
 * alone produces plates nobody would assemble -- four sides of cottage cheese,
 * or a meal made of salad dressing because it happens to fill the fat target.
 * So each dish gets a role, and the planner fills roles rather than totals.
 *
 * Upstream's course names ("Entrees", "Starches", "Vegetables") do most of the
 * work. Names and macros settle the rest, because the same course name covers
 * very different food at different venues: a Salad Bar "Proteins" shelf and a
 * deli "Salads" tray both hold tuna.
 */
import type { Candidate } from './types.ts';

export type Role =
	| 'protein'
	| 'starch'
	| 'veg'
	| 'fruit'
	| 'dairy'
	| 'soup'
	| 'side'
	/** Breakfast cereal: planned at breakfast only. */
	| 'cereal'
	/** Never chosen automatically -- only when the user asks for it. */
	| 'dessert'
	| 'drink'
	| 'condiment';

export const ROLE_LABELS: Record<Role, string> = {
	protein: 'Protein',
	starch: 'Starch',
	veg: 'Vegetable',
	fruit: 'Fruit',
	dairy: 'Dairy',
	soup: 'Soup',
	side: 'Side',
	cereal: 'Cereal',
	dessert: 'Dessert',
	drink: 'Drink',
	condiment: 'Condiment'
};

const CONDIMENT =
	/^mix\b|syrup|\bsauce\b|dressing|gravy|ketchup|mustard|mayo|relish|salsa|\bbutter$|jelly|\bjam\b|\bhoney\b|sugar|sprinkles|topping|crouton|bacon bits|seasoning|cream cheese|\bdip\b|hummus|vinaigrette$|\bpickles?\b|olives|sunflower|raisins/i;

const DESSERT =
	/cookie|brownie|blondie|\bcake\b|\bpie\b|cobbler|pudding|ice cream|soft serve|sundae|donut|doughnut|danish|\bcone\b|cupcake|cheesecake|(?<!english )muffin|jell-?o|cinnamon roll|churro|tart\b|crisp\b|parfait|banana bread|bread banana/i;

const PROTEIN_NAME =
	/chicken|turkey|beef|pork|ham\b|salami|steak|brisket|meatball|sausage|bratwurst|fish|salmon|tuna|cod|tilapia|shrimp|egg|tofu|tempeh|seitan|plant-based|beyond|impossible|veggie crumbles|bulgogi|carnitas|lamb|gyro/i;

// "Chili" alone or at the end is the dish; "Thai Chili Chicken" and "Chili
// Cheeze Fries" are not soup.
const SOUP = /soup|stew|congee|chowder|bisque|^chili\b|\bchili$/i;

function proteinShare(c: Candidate): number {
	const n = c.nutrients;
	if (!n || n.calories <= 0) return 0;
	return (n.proteinG * 4) / n.calories;
}

function carbShare(c: Candidate): number {
	const n = c.nutrients;
	if (!n || n.calories <= 0) return 0;
	return (n.carbG * 4) / n.calories;
}

/** By macros, for a course name that does not say. */
function byMacros(c: Candidate): Role {
	const n = c.nutrients;
	if (!n) return 'side';
	if (n.proteinG >= 12 || (proteinShare(c) >= 0.28 && n.proteinG >= 6)) return 'protein';
	if (carbShare(c) >= 0.5 && n.calories >= 60) return 'starch';
	return 'side';
}

export function classify(c: Candidate): Role {
	const name = c.name;
	const category = c.category.toLowerCase();
	const station = c.station.toLowerCase();

	if (/sauces?|dressings?|condiments?|toppings?/.test(category) || station === 'condiments') {
		return 'condiment';
	}
	if (CONDIMENT.test(name)) return 'condiment';

	if (/yogurt|kefir|cottage cheese/i.test(name)) return 'dairy';
	if (category === 'cheeses') return 'condiment';

	if (category === 'beverages' || station === 'beverages') {
		return /\bmilk\b/i.test(name) ? 'dairy' : 'drink';
	}

	if (category === 'desserts' || DESSERT.test(name)) return 'dessert';
	if (category === 'fruits' || category === 'fruit') return 'fruit';

	if (category === 'cereals' || station === 'cereal') {
		return /oat|grits|congee|porridge/i.test(name) ? 'starch' : 'cereal';
	}

	if (category === 'soups' || SOUP.test(name)) return 'soup';

	if (category === 'vegetables' || category === 'vegetable') return 'veg';
	if (category === 'starches' || category === 'breads' || category === 'bread') return 'starch';

	if (category.includes('salad')) {
		if (PROTEIN_NAME.test(name) && (c.nutrients?.proteinG ?? 0) >= 10) return 'protein';
		return 'veg';
	}

	if (category === 'entrees' || category === 'entree' || category === 'proteins') {
		// An entrée that is mostly starch -- polenta, loaded fries -- still has to
		// be paired with a protein, so it is filed as what it actually supplies.
		const role = byMacros(c);
		if (role === 'side') return PROTEIN_NAME.test(name) ? 'protein' : 'starch';
		return role;
	}

	if (PROTEIN_NAME.test(name) && (c.nutrients?.proteinG ?? 0) >= 6) return 'protein';
	if (/chips|fries|tots|beans|rice|pasta|noodle|potato|bread|tortilla|pita|bun\b/i.test(name)) {
		return 'starch';
	}
	return byMacros(c);
}
