/**
 * The crawl orchestrator.
 *
 * Phases, and why each is shaped the way it is:
 *
 *   A  units      -- the landing HTML already lists them, so this costs one
 *                    GET. Each unit is then probed once; a childUnitsPanel
 *                    means it is a hall, a menuPanel means it is standalone
 *                    and its menu list is ALREADY IN HAND (8 of the 12
 *                    top-level units take that branch).
 *   B  menu lists -- one POST per venue. Duplicate venues sharing an identical
 *                    menu set ("Build Your Own" appears under four halls) are
 *                    fetched once.
 *   C  menus      -- SelecUnitAndtMenu takes unitOid AND menuOid, so it does
 *                    not depend on session state and can run concurrently.
 *   D  labels     -- the bulk of the work. Resumable by construction: the
 *                    queue is `label_fetched_at IS NULL`, so a killed run
 *                    picks up exactly where it stopped.
 *   E  hours      -- one POST per venue for a weekly grid. Last, because a
 *                    menu without hours still helps and hours without a menu
 *                    do not.
 *
 * Every unit of work is individually caught into scrape_error. A run is
 * 'partial' under a 20% error rate and 'failed' above 50%, at which point it
 * circuit-breaks rather than keep hammering a site that is already unwell.
 */
import type { Db } from '../../db/driver.ts';
import { addDays, campusToday, unixNow } from '../../time.ts';
import type { ScraperConfig } from '../config.ts';
import * as endpoints from '../endpoints.ts';
import { panelOrThrow, RAW_PANEL, readPanels } from '../panels.ts';
import { parseHours } from '../parse/hours.ts';
import { parseItemPanel } from '../parse/item-panel.ts';
import { parseMenuList, type ParsedMenuRef } from '../parse/menu-list.ts';
import { parseNutritionLabel } from '../parse/nutrition-label.ts';
import { parseChildUnits, parseUnits } from '../parse/units.ts';
import { persistHours } from '../persist/hours.ts';
import { persistMenu } from '../persist/menus.ts';
import {
	attachLabelToMenuItem,
	pendingLabels,
	persistLabel,
	reuseLabelForMatchingItems
} from '../persist/nutrition.ts';
import { recordUnitStatus, upsertUnit } from '../persist/units.ts';
import type { Transport } from '../transport/client.ts';

export interface RunOptions {
	/** Restrict the crawl to these top-level unit oids. Handy while iterating. */
	onlyUnits?: number[];
	/** Overrides config.daysAhead. */
	daysAhead?: number;
	skipLabels?: boolean;
	/** Hours are a weekly grid; a nightly run can skip them. */
	skipHours?: boolean;
	/** Cap on labels fetched this run; undefined means drain the queue. */
	labelBudget?: number;
	today?: string;
	now?: () => number;
	log?: (message: string) => void;
}

export interface RunSummary {
	runId: number;
	status: 'ok' | 'partial' | 'failed';
	unitsSeen: number;
	menusSeen: number;
	menusScraped: number;
	itemsUpserted: number;
	labelsFetched: number;
	httpRequests: number;
	errorCount: number;
}

interface Venue {
	unitId: number;
	nnOid: number;
	name: string;
	/** Present when phase A already returned this venue's menu list. */
	menuPanelHtml?: string;
}

const CIRCUIT_BREAK_RATE = 0.5;
const PARTIAL_RATE = 0.2;

export async function runScrape(
	db: Db,
	transport: Transport,
	config: ScraperConfig,
	options: RunOptions = {}
): Promise<RunSummary> {
	const now = options.now ?? unixNow;
	const log = options.log ?? (() => {});
	const today = options.today ?? campusToday();
	const from = addDays(today, -config.daysBehind);
	const to = addDays(today, options.daysAhead ?? config.daysAhead);

	const runId = db
		.prepare("INSERT INTO scrape_run (kind, started_at, status) VALUES ('full', ?, 'running')")
		.run(now()).lastInsertRowid;

	let errors = 0;
	let attempts = 0;

	const fail = (phase: string, target: string, kind: string, err: unknown) => {
		errors++;
		db.prepare(
			`INSERT INTO scrape_error (run_id, phase, target, kind, message, body_excerpt, at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(
			runId,
			phase,
			target,
			kind,
			err instanceof Error ? err.message : String(err),
			null,
			now()
		);
		log(`  ! ${phase} ${target}: ${err instanceof Error ? err.message : String(err)}`);
	};

	const tripped = () => attempts >= 10 && errors / attempts > CIRCUIT_BREAK_RATE;

	const summary: RunSummary = {
		runId,
		status: 'ok',
		unitsSeen: 0,
		menusSeen: 0,
		menusScraped: 0,
		itemsUpserted: 0,
		labelsFetched: 0,
		httpRequests: 0,
		errorCount: 0
	};

	try {
		// ---- Phase A: units -------------------------------------------------
		const landing = await transport.bootstrap();
		const topUnits = parseUnits(landing).filter(
			(u) => !options.onlyUnits || options.onlyUnits.includes(u.oid)
		);
		log(`units: ${topUnits.length}`);

		const venues: Venue[] = [];

		for (const [index, top] of topUnits.entries()) {
			attempts++;
			try {
				const panels = readPanels(await endpoints.selectUnit(transport, top.oid));
				const children = panels.get('childUnitsPanel');

				if (children) {
					const hallId = upsertUnit(
						db,
						{ nnOid: top.oid, parentId: null, name: top.name, kind: 'hall', sort: index },
						now()
					);
					for (const [childIndex, child] of parseChildUnits(children).entries()) {
						const venueId = upsertUnit(
							db,
							{
								nnOid: child.oid,
								parentId: hallId,
								name: child.name,
								kind: 'venue',
								sort: childIndex
							},
							now()
						);
						recordUnitStatus(db, venueId, child.isOpen, now());
						venues.push({ unitId: venueId, nnOid: child.oid, name: child.name });
					}
				} else {
					// No children: this response IS the menu list, so phase B can
					// skip a redundant request for it.
					const unitId = upsertUnit(
						db,
						{ nnOid: top.oid, parentId: null, name: top.name, kind: 'standalone', sort: index },
						now()
					);
					venues.push({
						unitId,
						nnOid: top.oid,
						name: top.name,
						menuPanelHtml: panelOrThrow(panels, 'menuPanel')
					});
				}
			} catch (err) {
				fail('units', `unit ${top.oid} (${top.name})`, 'http', err);
			}
		}
		summary.unitsSeen = venues.length;
		log(`venues: ${venues.length}`);

		// ---- Phase B: menu lists --------------------------------------------
		const work: { venue: Venue; menu: ParsedMenuRef }[] = [];

		for (const venue of venues) {
			if (tripped()) break;
			attempts++;
			try {
				const html =
					venue.menuPanelHtml ??
					panelOrThrow(
						readPanels(await endpoints.selectChildUnit(transport, venue.nnOid)),
						'menuPanel'
					);

				for (const menu of parseMenuList(html)) {
					if (menu.serviceDate >= from && menu.serviceDate <= to) work.push({ venue, menu });
				}
			} catch (err) {
				fail('menu-list', `unit ${venue.nnOid} (${venue.name})`, 'http', err);
			}
		}
		summary.menusSeen = work.length;
		log(`menus in ${from}..${to}: ${work.length}`);

		// ---- Phase C: menu items --------------------------------------------
		//
		// Several venues share a menu oid: "Build Your Own" is published under
		// four different halls with an identical menu set. Those are genuinely
		// the same upstream menu, so it is fetched ONCE and then persisted under
		// each venue that offers it -- deduping the persistence instead would
		// make the venue vanish from three of its four halls.
		const byMenuOid = new Map<number, { venue: Venue; menu: ParsedMenuRef }[]>();
		for (const entry of work) {
			const bucket = byMenuOid.get(entry.menu.oid);
			if (bucket) bucket.push(entry);
			else byMenuOid.set(entry.menu.oid, [entry]);
		}
		const shared = work.length - byMenuOid.size;
		if (shared > 0) log(`  shared menus: ${shared} fetches saved`);

		for (const [menuOid, entries] of byMenuOid) {
			if (tripped()) break;
			attempts++;
			const [first] = entries;
			try {
				const panels = readPanels(
					await endpoints.selectMenu(transport, first.venue.nnOid, menuOid)
				);
				const parsed = parseItemPanel(panelOrThrow(panels, 'itemPanel'));

				for (const { venue, menu } of entries) {
					const result = persistMenu(
						db,
						{
							unitId: venue.unitId,
							serviceDate: menu.serviceDate,
							meal: menu.meal,
							nnOid: menu.oid
						},
						parsed,
						runId,
						now()
					);
					summary.menusScraped++;
					summary.itemsUpserted += result.itemsUpserted;
				}
			} catch (err) {
				fail(
					'menu',
					`${first.venue.name} ${first.menu.serviceDate} ${first.menu.meal}`,
					'parse',
					err
				);
			}
		}
		log(`menus scraped: ${summary.menusScraped}, items: ${summary.itemsUpserted}`);

		// ---- Phase D: nutrition labels ---------------------------------------
		if (!options.skipLabels) {
			const budget = options.labelBudget ?? Number.MAX_SAFE_INTEGER;
			const queue = pendingLabels(db, Math.min(budget, 100_000));
			log(`labels pending: ${queue.length}`);

			// The label endpoint is SESSION-STATEFUL: it answers only for the menu
			// currently selected in the session, returning a ~350-byte stub
			// otherwise. Verified live -- detailOid 122098120 gave 359 bytes until
			// its menu was selected, then 8,214. So walk menu by menu, selecting
			// each once, rather than firing labels in isolation.
			let selectedMenuOid: number | null = null;

			for (const pending of queue) {
				if (summary.labelsFetched >= budget || tripped()) break;
				attempts++;
				try {
					if (selectedMenuOid !== pending.menu_oid) {
						await endpoints.selectMenu(transport, pending.unit_nn_oid, pending.menu_oid);
						selectedMenuOid = pending.menu_oid;
					}

					const body = await endpoints.itemNutritionLabel(
						transport,
						pending.detail_oid,
						pending.menu_oid
					);
					const panels = readPanels(body);
					const label = parseNutritionLabel(panels.get(RAW_PANEL) ?? body);

					// Refuse to store a label we clearly failed to read. Without this
					// every stub collapses onto one empty content hash and the item
					// looks like it has verified nutrition data when it has none --
					// exactly the failure the allergen model must never make.
					if (label.name === null && label.contains.length === 0) {
						throw new Error(
							`Unparseable nutrition label (${body.length} bytes); menu may not be selected`
						);
					}

					const { nutritionFactId } = persistLabel(db, label, now());

					attachLabelToMenuItem(db, pending.menu_item_id, nutritionFactId, now());
					if (config.recipeMode === 'dedupe') {
						reuseLabelForMatchingItems(
							db,
							pending.item_id,
							pending.serving_size_norm,
							nutritionFactId,
							now()
						);
					}
					summary.labelsFetched++;
				} catch (err) {
					fail('label', `detailOid ${pending.detail_oid}`, 'http', err);
				}
			}
			log(`labels fetched: ${summary.labelsFetched}`);
		}

		// ---- Phase E: hours --------------------------------------------------
		//
		// One POST per venue, and the answer is a weekly grid that changes rarely
		// -- so this is skippable on a nightly run and worth doing weekly. It
		// comes last because it is the least urgent thing on the page: a menu
		// with no hours is still useful, hours with no menu are not.
		if (!options.skipHours) {
			for (const venue of venues) {
				if (tripped()) break;
				attempts++;
				try {
					const html = await endpoints.hoursOfOperation(transport, venue.nnOid);
					const parsed = parseHours(readPanels(html).get(RAW_PANEL) ?? html);
					if (parsed.length > 0) persistHours(db, venue.unitId, parsed, now());
				} catch (err) {
					fail('hours', `unit ${venue.nnOid} (${venue.name})`, 'http', err);
				}
			}
			log(`hours: ${venues.length} venues`);
		}
	} catch (err) {
		// A phase-level throw (bootstrap failed, budget exhausted) ends the run.
		fail('run', 'crawl', 'http', err);
		summary.status = 'failed';
	}

	summary.httpRequests = transport.requestCount;
	summary.errorCount = errors;
	if (summary.status !== 'failed') {
		const rate = attempts === 0 ? 0 : errors / attempts;
		summary.status = rate > CIRCUIT_BREAK_RATE ? 'failed' : rate > 0 ? 'partial' : 'ok';
		if (errors > 0 && rate <= PARTIAL_RATE) summary.status = 'partial';
	}

	db.prepare(
		`UPDATE scrape_run SET finished_at = ?, status = ?, units_seen = ?, menus_seen = ?,
		 menus_scraped = ?, items_upserted = ?, labels_fetched = ?, http_requests = ?, error_count = ?
		 WHERE id = ?`
	).run(
		now(),
		summary.status,
		summary.unitsSeen,
		summary.menusSeen,
		summary.menusScraped,
		summary.itemsUpserted,
		summary.labelsFetched,
		summary.httpRequests,
		summary.errorCount,
		runId
	);

	return summary;
}
