/**
 * The uieats MCP server: the same data and the same safety model as the site,
 * as tools an agent can call.
 *
 * Built fresh per request (see `http.ts`) and bound to one identity, or none.
 * Anonymous callers get menus, dishes and the taxonomy. A caller with an
 * access token gets the same tools evaluated against that user's allergens,
 * through the exact `getItemVerdicts` path the pages use, plus three personal
 * tools. Everything is read only.
 *
 * Tool names, descriptions and output must never match `NEVER_SAFE_PATTERN`.
 * The "what can I eat" tool is called `find_unflagged_dishes` for that reason,
 * and it keeps unverified dishes in their own list rather than dropping or
 * merging them, the same rule `searchItems` follows for `hideFlagged`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SessionUser } from '../auth/session.ts';
import type { Db } from '../db/driver.ts';
import { getFreshness } from '../health.ts';
import {
	getAllergenProfile,
	getAllergenTree,
	getDietTags,
	getUserDietTags,
	isEmptyProfile,
	type AllergenProfile,
	type AllergenTreeNode
} from '../queries/allergens.ts';
import { getItemBySlug, getItemDetail } from '../queries/items.ts';
import { getMenusForScope, getUnitsServingOn, type ScopeResult } from '../queries/menus.ts';
import { getFavoritesServedFrom, searchItems } from '../queries/search.ts';
import { getUnitBySlug, getUnitTree, type UnitRef } from '../queries/units.ts';
import { addDays, campusToday } from '../../dates.ts';
import { CROSS_CONTACT_NOTICE, nutritionView, summaryView, traitSlugs } from './serialize.ts';

export const TOKEN_HINT =
	'This tool needs an access token. Create one at /settings/tokens on the uieats site and send it ' +
	'as "Authorization: Bearer <token>".';

const DATE = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-08-21.')
	.describe('Service date, YYYY-MM-DD in campus time (America/Chicago). Defaults to today.');
const DIETS = z
	.array(z.string())
	.describe('Only dishes carrying ALL of these diet tag slugs (see list_allergens).');

class ToolInputError extends Error {}

function ok(value: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Input problems become tool errors the model can read and correct. */
function guarded<A>(fn: (args: A) => CallToolResult): (args: A) => CallToolResult {
	return (args) => {
		try {
			return fn(args);
		} catch (err) {
			if (err instanceof ToolInputError) return toolError(err.message);
			throw err;
		}
	};
}

function unitView(u: UnitRef) {
	return { slug: u.slug, name: u.name, shortName: u.shortName, kind: u.kind };
}

export function buildMcpServer(db: Db, user: SessionUser | null): McpServer {
	const server = new McpServer(
		{ name: 'uieats', version: '0.1.0' },
		{
			instructions:
				'UIUC dining hall menus with allergen checking. Locations are halls (with venues) or ' +
				'standalone units, addressed by slug from list_locations. ' +
				(user
					? `Authenticated as ${user.email}: menu, search and dish results include allergen ` +
						"verdicts for this user's registered allergens. A verdict of 'unknown' means the " +
						'label has not been read, never that the allergen is absent.'
					: 'Anonymous: no allergen verdicts. Send a bearer token to get per-user verdicts.')
		}
	);

	const userId = user?.id ?? null;
	let cachedProfile: AllergenProfile | undefined;
	const profile = () => (cachedProfile ??= getAllergenProfile(db, userId));
	const personalised = () => user !== null && !isEmptyProfile(profile());

	const dietSlugs = new Set(getDietTags(db).map((d) => d.slug));
	function checkDiets(diets: string[] | undefined): string[] {
		const list = diets ?? [];
		const bad = list.filter((d) => !dietSlugs.has(d));
		if (bad.length > 0) {
			throw new ToolInputError(
				`Unknown diet tag "${bad[0]}". Valid tags: ${[...dietSlugs].join(', ')}.`
			);
		}
		return list;
	}

	function resolveLocation(slug: string): UnitRef {
		const root = getUnitBySlug(db, slug);
		if (!root) {
			throw new ToolInputError(`No location "${slug}". Call list_locations for valid slugs.`);
		}
		return root;
	}

	function envelope() {
		const { lastSuccessAt, isStale } = getFreshness(db);
		return {
			dataLastUpdated: lastSuccessAt === null ? null : new Date(lastSuccessAt * 1000).toISOString(),
			isStale,
			...(personalised() ? { notice: CROSS_CONTACT_NOTICE } : {})
		};
	}

	function scopeView(scope: ScopeResult, meal: string | undefined) {
		const wanted = meal?.trim().toLowerCase();
		return {
			date: scope.date,
			location: unitView(scope.root),
			venues: scope.venues.map((v) => ({
				...unitView(v.venue),
				hours: v.hours.publishesSchedule
					? v.hours.today.map((h) => (h.isClosed ? 'closed' : `${h.opens}-${h.closes}`))
					: null,
				meals: v.meals
					.filter((m) => !wanted || m.meal.toLowerCase() === wanted)
					.map((m) => ({
						meal: m.meal,
						categories: m.categories.map((c) => ({
							name: c.isUncategorised ? null : c.name,
							items: c.items.map((i) => ({
								slug: i.slug,
								name: i.name,
								servingSize: i.servingSize,
								calories: i.calories,
								hasLabel: i.hasLabel,
								tags: traitSlugs(i.traits),
								...(user ? { favorite: i.isFavorite } : {}),
								...(i.allergens ? { allergens: summaryView(i.allergens) } : {})
							}))
						}))
					}))
			}))
		};
	}

	const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

	// ---------------------------------------------------------------- public

	server.registerTool(
		'list_locations',
		{
			title: 'List dining locations',
			description:
				'Every dining hall and standalone location with its venues, and whether it has menus today.',
			annotations: readOnly
		},
		() => {
			const today = campusToday();
			const serving = getUnitsServingOn(db, today);
			return ok({
				today,
				locations: getUnitTree(db).map((top) => {
					const ids = top.venues.length > 0 ? top.venues.map((v) => v.id) : [top.id];
					return {
						...unitView(top),
						servingToday: ids.some((id) => (serving.get(id) ?? 0) > 0),
						venues: top.venues.map(unitView)
					};
				})
			});
		}
	);

	server.registerTool(
		'get_menu',
		{
			title: 'Get a menu',
			description:
				'Menus for one location on one date: every venue, meal, category and dish. With an access ' +
				"token each dish carries allergen verdicts for the user's registered allergens.",
			inputSchema: {
				location: z.string().describe('Location slug from list_locations.'),
				venue: z.string().optional().describe('Venue slug within the location. Omit for all.'),
				date: DATE.optional(),
				meal: z.string().optional().describe('Only this meal, e.g. "Lunch". Omit for all.'),
				diets: DIETS.optional()
			},
			annotations: readOnly
		},
		guarded(({ location, venue, date, meal, diets }) => {
			const root = resolveLocation(location);
			let venueId: number | undefined;
			if (venue) {
				const v = getUnitBySlug(db, venue, root.id);
				if (!v) throw new ToolInputError(`${root.name} has no venue "${venue}".`);
				venueId = v.id;
			}
			const scope = getMenusForScope(db, {
				date: date ?? campusToday(),
				root,
				venueId,
				diets: checkDiets(diets),
				userId,
				profile: profile()
			});
			return ok({ ...envelope(), ...scopeView(scope, meal) });
		})
	);

	server.registerTool(
		'search_dishes',
		{
			title: 'Search dishes',
			description:
				'Find dishes by name across every location from today on, with the soonest serving of ' +
				'each. With an access token, results carry the worst allergen verdict for that serving.',
			inputSchema: {
				query: z.string().min(2).describe('Part of a dish name.'),
				diets: DIETS.optional(),
				hide_flagged: z
					.boolean()
					.optional()
					.describe(
						"Drop dishes with a warning for the user's allergens. Needs a token. Unverified " +
							'dishes are kept and marked.'
					),
				limit: z.number().int().min(1).max(60).optional()
			},
			annotations: readOnly
		},
		guarded(({ query, diets, hide_flagged, limit }) => {
			const hits = searchItems(db, {
				query,
				fromDate: campusToday(),
				userId,
				profile: profile(),
				hideFlagged: user !== null && hide_flagged === true,
				diets: checkDiets(diets),
				limit
			});
			return ok({
				...envelope(),
				results: hits.map((h) => ({
					slug: h.slug,
					name: h.name,
					upcomingServings: h.servings,
					next: h.next && {
						date: h.next.date,
						meal: h.next.meal,
						venue: h.next.venueName,
						location: h.next.hallSlug,
						hasLabel: h.next.hasLabel
					},
					...(user ? { favorite: h.isFavorite } : {}),
					...(personalised()
						? {
								worstVerdict: h.worstVerdict,
								hasWarning: h.hasWarning,
								hasUnknown: h.hasUnknown
							}
						: {})
				}))
			});
		})
	);

	server.registerTool(
		'get_dish',
		{
			title: 'Get a dish',
			description:
				'One dish: every upcoming serving with its own nutrition label, ingredients, "contains" ' +
				'and "may contain" text, diet tags and, with a token, per-serving allergen verdicts.',
			inputSchema: { slug: z.string().describe('Dish slug from get_menu or search_dishes.') },
			annotations: readOnly
		},
		guarded(({ slug }) => {
			const item = getItemBySlug(db, slug);
			if (!item) throw new ToolInputError(`No dish "${slug}".`);
			const detail = getItemDetail(db, item, {
				fromDate: addDays(campusToday(), -1),
				userId,
				profile: profile()
			});
			return ok({
				...envelope(),
				slug: item.slug,
				name: item.name,
				...(user ? { favorite: detail.isFavorite } : {}),
				servings: detail.appearances.map((a) => ({
					date: a.date,
					meal: a.meal,
					venue: a.venueName,
					location: a.hallSlug,
					servingSize: a.servingSize,
					hasLabel: a.hasLabel,
					tags: traitSlugs(a.traits),
					nutrition: nutritionView(a.nutrition),
					...(a.allergens ? { allergens: summaryView(a.allergens) } : {})
				}))
			});
		})
	);

	server.registerTool(
		'list_allergens',
		{
			title: 'List allergens and diet tags',
			description:
				'The allergen taxonomy (groups such as tree-nuts with their species) and the diet tag ' +
				'slugs accepted by the diets filter.',
			annotations: readOnly
		},
		() => {
			const node = (n: AllergenTreeNode): unknown => ({
				slug: n.slug,
				label: n.label,
				...(n.children.length > 0 ? { includes: n.children.map(node) } : {})
			});
			return ok({
				allergens: getAllergenTree(db).map(node),
				dietTags: getDietTags(db).map((d) => ({ slug: d.slug, label: d.label }))
			});
		}
	);

	// -------------------------------------------------------------- personal

	server.registerTool(
		'get_my_profile',
		{
			title: 'Get my allergen profile',
			description:
				"The authenticated user's registered allergens (with severity), custom allergens and " +
				'their search terms, and diet tags. Needs an access token.',
			annotations: readOnly
		},
		() => {
			if (!user) return toolError(TOKEN_HINT);
			const { selection, custom } = profile();
			return ok({
				email: user.email,
				displayName: user.displayName,
				allergens: selection.map((s) => ({
					slug: s.ref.slug,
					label: s.ref.label,
					severity: s.severity
				})),
				customAllergens: custom.map((c) => ({ label: c.label, terms: c.terms })),
				dietTags: getUserDietTags(db, user.id).map((d) => d.slug),
				...(isEmptyProfile(profile())
					? { note: 'No allergens registered. Add them at /settings/allergens.' }
					: {})
			});
		}
	);

	server.registerTool(
		'get_my_favorites',
		{
			title: 'Get my saved dishes',
			description:
				"The authenticated user's saved dishes, and where they are served over the coming days " +
				'with allergen flags. Needs an access token.',
			inputSchema: {
				days: z.number().int().min(1).max(14).optional().describe('How far ahead. Default 7.')
			},
			annotations: readOnly
		},
		({ days }) => {
			if (!user) return toolError(TOKEN_HINT);
			const today = campusToday();
			const saved = db
				.prepare<{ slug: string; name_display: string }>(
					`SELECT i.slug, i.name_display FROM favorite f JOIN item i ON i.id = f.item_id
					 WHERE f.user_id = ? ORDER BY i.name_display`
				)
				.all(user.id);
			const served = getFavoritesServedFrom(
				db,
				user.id,
				today,
				addDays(today, (days ?? 7) - 1),
				profile()
			);
			return ok({
				...envelope(),
				saved: saved.map((s) => ({ slug: s.slug, name: s.name_display })),
				upcoming: served.map((s) => ({
					slug: s.slug,
					name: s.name,
					date: s.date,
					meal: s.meal,
					venue: s.venueName,
					location: s.hallSlug,
					...(personalised() ? { hasWarning: s.hasWarning, hasUnknown: s.hasUnknown } : {})
				}))
			});
		}
	);

	server.registerTool(
		'find_unflagged_dishes',
		{
			title: 'Find dishes with no allergen warning',
			description:
				"Dishes on a date with no warning for the user's registered allergens, split into " +
				'"checked" (every allergen resolved against a label) and "unverified" (no warning, but ' +
				'at least one allergen could not be checked). Dishes with a warning are left out. Needs ' +
				'an access token.',
			inputSchema: {
				date: DATE.optional(),
				location: z.string().optional().describe('Location slug. Omit for every location.'),
				meal: z.string().optional().describe('Only this meal, e.g. "Dinner".'),
				diets: DIETS.optional()
			},
			annotations: readOnly
		},
		guarded(({ date, location, meal, diets }) => {
			if (!user) return toolError(TOKEN_HINT);
			if (isEmptyProfile(profile())) {
				return toolError(
					'No allergens are registered, so nothing can be checked. Add them at /settings/allergens.'
				);
			}

			const day = date ?? campusToday();
			const roots = location ? [resolveLocation(location)] : getUnitTree(db);
			const wanted = meal?.trim().toLowerCase();
			const dietList = checkDiets(diets);

			type Row = {
				slug: string;
				name: string;
				location: string;
				venue: string;
				meal: string;
			};
			const checked: Row[] = [];
			const unverified: (Row & { unchecked: string[] })[] = [];
			let flaggedCount = 0;

			for (const root of roots) {
				const scope = getMenusForScope(db, {
					date: day,
					root,
					diets: dietList,
					userId,
					profile: profile()
				});
				for (const v of scope.venues) {
					for (const m of v.meals) {
						if (wanted && m.meal.toLowerCase() !== wanted) continue;
						for (const c of m.categories) {
							for (const i of c.items) {
								const s = i.allergens;
								if (!s) continue;
								if (s.hasWarning) {
									flaggedCount++;
									continue;
								}
								const row = {
									slug: i.slug,
									name: i.name,
									location: root.slug,
									venue: v.venue.name,
									meal: m.meal
								};
								if (s.allChecked) checked.push(row);
								else
									unverified.push({
										...row,
										unchecked: s.verdicts
											.filter((x) => x.verdict === 'unknown')
											.map((x) => x.allergen.label)
									});
							}
						}
					}
				}
			}

			return ok({
				...envelope(),
				date: day,
				flaggedCount,
				checked,
				unverified
			});
		})
	);

	return server;
}
