/**
 * The MCP tools, driven through a real MCP client over an in-memory link.
 *
 * What matters here is that the allergen answers an agent gets are the site's
 * answers: anonymous callers get none, an authenticated caller gets verdicts
 * from the same pipeline, an unlabelled dish is never presented as checked,
 * and no wording anywhere implies clearance.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import { buildMcpServer } from '../../src/lib/server/mcp/server.ts';
import { NEVER_SAFE_PATTERN } from '../../src/lib/server/allergens/verdict.ts';
import { campusToday } from '../../src/lib/dates.ts';

const NOW = 1_760_000_000;
const TODAY = campusToday();

let db: Db;
let userId: number;
let client: Client;
const seen: string[] = [];

function allergenId(slug: string): number {
	return db.prepare<{ id: number }>('SELECT id FROM allergen WHERE slug = ?').get(slug)!.id;
}

/** One standalone venue, one lunch: a milk-declared dish and an unlabelled one. */
function seed() {
	const unitId = db
		.prepare(
			`INSERT INTO unit (nn_oid, parent_id, name, slug, kind, first_seen_at, last_seen_at)
			 VALUES (1, NULL, 'Test Venue', 'test-venue', 'standalone', ?, ?)`
		)
		.run(NOW, NOW).lastInsertRowid;
	const menuId = db
		.prepare(
			`INSERT INTO menu (unit_id, service_date, meal, meal_sort, nn_oid, first_seen_at)
			 VALUES (?, ?, 'Lunch', 30, 99, ?)`
		)
		.run(unitId, TODAY, NOW).lastInsertRowid;
	const categoryId = db
		.prepare(
			`INSERT INTO menu_category (menu_id, nn_category_id, name, sort, scrape_run_id)
			 VALUES (?, 1, 'Entrees', 0, 1)`
		)
		.run(menuId).lastInsertRowid;

	function dish(name: string, slug: string, oid: number, label: { contains?: string } | null) {
		const itemId = db
			.prepare(
				'INSERT INTO item (name_norm, name_display, slug, first_seen_at) VALUES (?, ?, ?, ?)'
			)
			.run(name.toLowerCase(), name, slug, NOW).lastInsertRowid;
		const menuItemId = db
			.prepare(
				`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, sort, scrape_run_id)
				 VALUES (?, ?, ?, ?, 0, 1)`
			)
			.run(menuId, categoryId, itemId, oid).lastInsertRowid;
		if (label) {
			const factId = db
				.prepare(
					`INSERT INTO nutrition_fact (content_hash, ingredients_text, contains_text, first_seen_at)
					 VALUES (?, ?, ?, ?)`
				)
				.run(`h${oid}`, 'MILK, SALT, KIWI', label.contains ?? null, NOW).lastInsertRowid;
			db.prepare(
				`INSERT INTO nutrition_allergen (nutrition_fact_id, allergen_id, source, confidence, evidence)
				 VALUES (?, ?, 'contains', 'declared', 'Contains: Milk')`
			).run(factId, allergenId('milk'));
			db.prepare(
				'UPDATE menu_item SET nutrition_fact_id = ?, label_fetched_at = ? WHERE id = ?'
			).run(factId, NOW, menuItemId);
		}
	}

	dish('Cheese Pizza', 'cheese-pizza', 1001, { contains: 'Milk' });
	dish('Mystery Soup', 'mystery-soup', 1002, null);
}

async function connect(asUser: boolean) {
	const server = buildMcpServer(
		db,
		asUser ? { id: userId, email: 'student@illinois.edu', displayName: null } : null
	);
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	client = new Client({ name: 'test', version: '0' });
	await client.connect(b);
}

async function call(name: string, args: Record<string, unknown> = {}) {
	const result = (await client.callTool({ name, arguments: args })) as {
		isError?: boolean;
		content: { type: string; text: string }[];
	};
	const text = result.content.map((c) => c.text).join('\n');
	seen.push(text);
	return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

beforeEach(() => {
	db = createMemoryDb();
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', NOW).lastInsertRowid;
	seed();
});

afterEach(async () => {
	await client?.close();
});

describe('anonymous', () => {
	it('serves menus without verdicts and refuses personal tools', async () => {
		await connect(false);
		const menu = (await call('get_menu', { location: 'test-venue', date: TODAY })).json();
		const items = menu.venues[0].meals[0].categories[0].items;
		expect(items.map((i: { slug: string }) => i.slug).sort()).toEqual([
			'cheese-pizza',
			'mystery-soup'
		]);
		expect(items.every((i: object) => !('allergens' in i))).toBe(true);

		for (const tool of ['get_my_profile', 'get_my_favorites', 'find_unflagged_dishes']) {
			expect((await call(tool)).isError).toBe(true);
		}
	});

	it('returns input problems as tool errors', async () => {
		await connect(false);
		expect((await call('get_menu', { location: 'nowhere' })).isError).toBe(true);
		expect((await call('get_menu', { location: 'test-venue', diets: ['carnivore'] })).isError).toBe(
			true
		);
		expect((await call('get_dish', { slug: 'nope' })).isError).toBe(true);
	});
});

describe('authenticated', () => {
	// Milk is in upstream's trait vocabulary, so an unlabelled dish resolves to
	// no-declared for it. Mustard is not, so the same dish stays unknown.
	beforeEach(() => {
		for (const slug of ['milk', 'mustard']) {
			db.prepare(
				'INSERT INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
			).run(userId, allergenId(slug), 'severe', NOW);
		}
	});

	it('flags the declared dish and never lists the unlabelled one as checked', async () => {
		await connect(true);

		const menu = (await call('get_menu', { location: 'test-venue', date: TODAY })).json();
		const bySlug = Object.fromEntries(
			menu.venues[0].meals[0].categories[0].items.map((i: { slug: string }) => [i.slug, i])
		);
		expect(bySlug['cheese-pizza'].allergens.worst).toBe('flagged-declared');
		expect(bySlug['cheese-pizza'].allergens.hasWarning).toBe(true);
		expect(bySlug['mystery-soup'].allergens.hasWarning).toBe(false);
		expect(bySlug['mystery-soup'].allergens.allChecked).toBe(false);
		expect(menu.notice).toBeTruthy();

		const found = (await call('find_unflagged_dishes', { date: TODAY })).json();
		expect(found.flaggedCount).toBe(1);
		expect(found.checked).toEqual([]);
		expect(found.unverified.map((r: { slug: string }) => r.slug)).toEqual(['mystery-soup']);

		const dish = (await call('get_dish', { slug: 'cheese-pizza' })).json();
		expect(dish.servings[0].allergens.verdicts).toContainEqual(
			expect.objectContaining({ allergen: 'milk', verdict: 'flagged-declared' })
		);
	});

	it('checks custom allergens and reports them in the profile', async () => {
		db.prepare(
			'INSERT INTO user_custom_allergen (user_id, label, terms, created_at) VALUES (?, ?, ?, ?)'
		).run(userId, 'Kiwi', 'kiwi', NOW);
		db.prepare(
			'INSERT INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
		).run(userId, allergenId('vegan'), 'avoid', NOW);
		await connect(true);

		const me = (await call('get_my_profile')).json();
		expect(me.allergens.map((a: { slug: string }) => a.slug).sort()).toEqual(['milk', 'mustard']);
		expect(me.customAllergens).toEqual([{ label: 'Kiwi', terms: ['kiwi'] }]);
		expect(me.dietTags).toEqual(['vegan']);

		const dish = (await call('get_dish', { slug: 'cheese-pizza' })).json();
		const kiwi = dish.servings[0].allergens.verdicts.find(
			(v: { label: string }) => v.label === 'Kiwi'
		);
		expect(kiwi?.warning).toBe(true);
	});

	it('hide_flagged drops warnings but keeps unverified dishes', async () => {
		await connect(true);
		db.prepare("UPDATE item SET name_norm = 'pizza soup ' || name_norm").run();
		const res = (await call('search_dishes', { query: 'pizza soup', hide_flagged: true })).json();
		expect(res.results.map((r: { slug: string }) => r.slug)).toEqual(['mystery-soup']);
		expect(res.results[0].hasUnknown).toBe(true);
	});
});

describe('wording', () => {
	it('never implies clearance in tool metadata or any output seen above', async () => {
		await connect(true);
		const { tools } = await client.listTools();
		const text = [
			...tools.flatMap((t) => [t.name, t.title ?? '', t.description ?? '']),
			JSON.stringify(tools.map((t) => t.inputSchema)),
			...seen
		];
		for (const chunk of text) expect(chunk).not.toMatch(NEVER_SAFE_PATTERN);
	});
});
