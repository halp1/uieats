#!/usr/bin/env node
/**
 * A realistic development database with zero network traffic.
 *
 * Every byte of content here is real captured upstream output, pushed through
 * the same persistence layer the live scraper uses -- so this doubles as an
 * end-to-end exercise of that layer, and a schema change that breaks
 * persistence breaks this script too.
 *
 * What is synthetic is the BREADTH, and only the breadth: there are three
 * captured item panels and two captured labels, so they are fanned out across
 * the menu list to give every venue-day something to render. Item identity,
 * allergen traits, ingredient prose and nutrient values are all genuine.
 *
 *   node scripts/seed-demo.ts            -- seed into the current database
 *   node scripts/seed-demo.ts --reset    -- wipe it first
 */
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, resolveDatabasePath } from '../src/lib/server/db/index.ts';
import { readPanels } from '../src/lib/server/scraper/panels.ts';
import { parseHours } from '../src/lib/server/scraper/parse/hours.ts';
import { parseItemPanel } from '../src/lib/server/scraper/parse/item-panel.ts';
import { parseMenuList } from '../src/lib/server/scraper/parse/menu-list.ts';
import { parseNutritionLabel } from '../src/lib/server/scraper/parse/nutrition-label.ts';
import { parseChildUnits, parseUnits } from '../src/lib/server/scraper/parse/units.ts';
import { persistHours } from '../src/lib/server/scraper/persist/hours.ts';
import { persistMenu } from '../src/lib/server/scraper/persist/menus.ts';
import {
	attachLabelToMenuItem,
	persistLabel
} from '../src/lib/server/scraper/persist/nutrition.ts';
import { recordUnitStatus, upsertUnit } from '../src/lib/server/scraper/persist/units.ts';
import { unixNow } from '../src/lib/dates.ts';

const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'tests',
	'fixtures',
	'netnutrition'
);

const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const panel = (name: string, id: string) => {
	const html = readPanels(fixture(name)).get(id);
	if (html === undefined) throw new Error(`fixture ${name} has no panel ${id}`);
	return html;
};

if (process.argv.includes('--reset')) {
	const path = resolveDatabasePath();
	for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
	console.log(`removed ${path}`);
}

const db = getDb();
const now = unixNow();

const runId = db
	.prepare("INSERT INTO scrape_run (kind, started_at, status) VALUES ('demo', ?, 'running')")
	.run(now).lastInsertRowid;

// ---- Units -----------------------------------------------------------------
//
// All twelve top-level units, exactly as the landing page lists them. Unit 1
// (Ike) gets its nine real children; the rest are seeded standalone, which is
// what eight of the twelve genuinely are.
const tops = parseUnits(fixture('landing.html'));
const venues: { unitId: number; name: string }[] = [];

for (const [index, top] of tops.entries()) {
	const hasChildren = top.oid === 1;
	const unitId = upsertUnit(
		db,
		{
			nnOid: top.oid,
			parentId: null,
			name: top.name,
			kind: hasChildren ? 'hall' : 'standalone',
			sort: index
		},
		now
	);

	if (!hasChildren) {
		recordUnitStatus(db, unitId, index % 3 !== 0, now);
		venues.push({ unitId, name: top.name });
		continue;
	}

	for (const [childIndex, child] of parseChildUnits(
		panel('select-unit-1.hall.json', 'childUnitsPanel')
	).entries()) {
		const venueId = upsertUnit(
			db,
			{
				nnOid: child.oid,
				parentId: unitId,
				name: child.name,
				kind: 'venue',
				sort: childIndex
			},
			now
		);
		recordUnitStatus(db, venueId, child.isOpen, now);
		venues.push({ unitId: venueId, name: child.name });
	}
}
console.log(`units:   ${tops.length} top-level, ${venues.length} venues`);

// ---- Hours -----------------------------------------------------------------
const hours = parseHours(fixture('hours-unit-5.html'));
for (const venue of venues) persistHours(db, venue.unitId, hours, now);
console.log(`hours:   ${hours.length} rows per venue`);

// ---- Menus -----------------------------------------------------------------
//
// One captured menu list, replayed for every venue. The three item panels are
// dealt out round-robin so that consecutive meals differ, which is what makes
// the browse UI worth looking at.
const menuRefs = parseMenuList(panel('select-childunit-2.menulist.json', 'menuPanel'));
const panels = [
	parseItemPanel(panel('itempanel-1440348.json', 'itemPanel')),
	parseItemPanel(panel('itempanel-1440351.json', 'itemPanel')),
	parseItemPanel(panel('itempanel-1439178.json', 'itemPanel'))
];

let menus = 0;
let items = 0;
let deal = 0;

for (const venue of venues) {
	for (const ref of menuRefs) {
		const result = persistMenu(
			db,
			{
				unitId: venue.unitId,
				serviceDate: ref.serviceDate,
				meal: ref.meal,
				nnOid: ref.oid
			},
			panels[deal++ % panels.length],
			runId,
			now
		);
		menus++;
		items += result.itemsUpserted;
	}
}
console.log(`menus:   ${menus} menus, ${items} item instances`);

// ---- Nutrition labels ------------------------------------------------------
//
// Two real labels. They are attached to the menu_items whose detail oids they
// were actually captured for, so the label genuinely belongs to the dish -- and
// everything else deliberately stays unlabelled, which is the state the whole
// `unknown` verdict exists to represent. A demo database where every item is
// resolved would hide the most important thing the UI has to get right.
const labels = [
	{ file: 'label-122098028.html', detailOid: 122098028 },
	{ file: 'label-122038050.html', detailOid: 122038050 }
];

let attached = 0;
for (const { file, detailOid } of labels) {
	const parsed = parseNutritionLabel(fixture(file));
	const { nutritionFactId } = persistLabel(db, parsed, now);

	for (const row of db
		.prepare<{ id: number }>('SELECT id FROM menu_item WHERE nn_detail_oid = ?')
		.all(detailOid)) {
		attachLabelToMenuItem(db, row.id, nutritionFactId, now);
		attached++;
	}
}

const unlabelled = db
	.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM menu_item WHERE label_fetched_at IS NULL')
	.get()!.c;
console.log(`labels:  ${labels.length} distinct, attached to ${attached} instances`);
console.log(`         ${unlabelled} instances left unverified on purpose`);

db.prepare(
	`UPDATE scrape_run SET finished_at = ?, status = 'ok', units_seen = ?, menus_seen = ?,
	 menus_scraped = ?, items_upserted = ?, labels_fetched = ? WHERE id = ?`
).run(now, venues.length, menus, menus, items, labels.length, runId);

const allergenRows = db
	.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM nutrition_allergen')
	.get()!.c;
const nameRows = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM item_allergen').get()!.c;
console.log(`matched: ${allergenRows} label allergens, ${nameRows} name-inferred`);
console.log(`\nseeded ${resolveDatabasePath()}`);
