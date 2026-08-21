#!/usr/bin/env node
/**
 * Captures real NetNutrition responses into tests/fixtures/netnutrition/.
 *
 * Deliberately uses plain fetch rather than the scraper's own transport: a
 * fixture captured through the code under test would validate nothing. Run it
 * by hand when upstream drifts, never in CI.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE =
	process.env.NETNUTRITION_BASE_URL ?? 'https://eatsmart.housing.illinois.edu/NetNutrition/46';
const DIR = join(process.cwd(), 'tests', 'fixtures', 'netnutrition');
const UA = 'uieats-fixture-capture/0.1 (+https://github.com/yourname/uieats)';

mkdirSync(DIR, { recursive: true });

let cookie = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function absorb(res: Response) {
	const set = res.headers.getSetCookie?.() ?? [];
	const jar = new Map(
		cookie ? cookie.split('; ').map((c) => c.split('=') as [string, string]) : []
	);
	for (const raw of set) {
		const [pair] = raw.split(';');
		const idx = pair.indexOf('=');
		if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
	}
	cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function bootstrap(): Promise<string> {
	const res = await fetch(BASE, { headers: { 'User-Agent': UA } });
	absorb(res);
	return res.text();
}

async function post(path: string, body: Record<string, string | number>): Promise<string> {
	await sleep(200); // politeness; this hits a university server
	const res = await fetch(`${BASE}/${path}`, {
		method: 'POST',
		headers: {
			'User-Agent': UA,
			'X-Requested-With': 'XMLHttpRequest',
			'Content-Type': 'application/x-www-form-urlencoded',
			Cookie: cookie
		},
		body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
	});
	absorb(res);
	return res.text();
}

/**
 * Upstream answers HTTP 200 with a "NetNutrition Start-up Error" page when it
 * is unhealthy. Writing that to disk would silently replace a good fixture
 * with an error page and make the parser tests assert nonsense, so refuse.
 */
function save(name: string, contents: string) {
	if (
		contents.includes('NetNutrition Start-up Error') ||
		contents.includes('The system has encountered an error')
	) {
		throw new Error(
			`${name}: upstream returned its start-up error page. Aborting; try again later.`
		);
	}
	if (contents.length < 500) {
		throw new Error(
			`${name}: response is only ${contents.length} bytes, that is not a real payload.`
		);
	}
	writeFileSync(join(DIR, name), contents);
	console.log(`  ${name.padEnd(40)} ${contents.length.toLocaleString()} bytes`);
}

function panels(json: string): Record<string, string> {
	const parsed = JSON.parse(json) as { panels: { id: string; html: string }[] };
	return Object.fromEntries(parsed.panels.map((p) => [p.id, p.html]));
}

function oids(html: string, fn: string): string[] {
	return [...html.matchAll(new RegExp(`${fn}\\((\\d+)`, 'g'))].map((m) => m[1]);
}

console.log('capturing from', BASE);

const landing = await bootstrap();
save('landing.html', landing);

// Ikenberry: a hall, so this returns childUnitsPanel.
const ike = await post('Unit/SelectUnitFromUnitsList', { unitOid: 1 });
save('select-unit-1.hall.json', ike);

// Field of Greens: no children, so this returns menuPanel directly. This
// branch is the one most likely to be forgotten.
const standalone = await post('Unit/SelectUnitFromUnitsList', { unitOid: 32 });
save('select-unit-32.standalone.json', standalone);

// Baked Expectations (a child of Ikenberry) -> its menu list.
const bakedMenus = await post('Unit/SelectUnitFromChildUnitsList', { unitOid: 2 });
save('select-childunit-2.menulist.json', bakedMenus);

const menuOids = oids(panels(bakedMenus).menuPanel ?? '', 'menuListSelectMenu');
const pickedMenu = menuOids[Math.floor(menuOids.length / 2)];
const itemPanel = await post('Menu/SelecUnitAndtMenu', { unitOid: 2, menuOid: pickedMenu });
save(`itempanel-${pickedMenu}.json`, itemPanel);

// A nutrition label. Prefer an item whose Contains: names a group so the
// species-resolution path has a real example.
const itemHtml = panels(itemPanel).itemPanel ?? '';
const detailOids = oids(itemHtml, 'getItemNutritionLabel');
const label = await post('NutritionDetail/ShowItemNutritionLabel', {
	detailOid: detailOids[0],
	menuOid: pickedMenu
});
save(`label-${detailOids[0]}.html`, label);

// Hours of operation (raw HTML, not a JSON envelope).
save('hours-unit-5.html', await post('Unit/GetHoursOfOperationMarkup', { unitOid: 5 }));

// A menu with no items at all -- the empty-state path.
let emptyFound = false;
for (const unitOid of [2, 5, 3, 4, 6]) {
	const list = await post('Unit/SelectUnitFromChildUnitsList', { unitOid });
	for (const menuOid of oids(panels(list).menuPanel ?? '', 'menuListSelectMenu').slice(0, 12)) {
		const res = await post('Menu/SelecUnitAndtMenu', { unitOid, menuOid });
		if (oids(panels(res).itemPanel ?? '', 'getItemNutritionLabel').length === 0) {
			save('itempanel-empty.json', res);
			emptyFound = true;
			break;
		}
	}
	if (emptyFound) break;
}
if (!emptyFound) console.log('  (no empty menu found; synthesize itempanel-empty.json by hand)');

// A request with a junk session, to capture what expiry actually looks like.
cookie = 'ASP.NET_SessionId=0000000000000000000000000000';
save(
	'session-expired.txt',
	await post('Menu/SelecUnitAndtMenu', { unitOid: 2, menuOid: pickedMenu })
);

console.log('done');
