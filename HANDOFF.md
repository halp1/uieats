# uieats — handoff

**Status: complete and working end to end. 354 tests green. Phases 0–9 done.**

Read `README.md` for what the app is and how the safety model works, then
`ops/README.md` for running it. This file is only what a next session needs that
those two do not say.

```bash
bun install
bun run test          # 354 tests, ~1s
bun run check         # 0 errors
bun run lint
bun run build && node build/index.js     # verified: serves

bun run db:migrate
node scripts/scrape.ts --days=0 --label-budget=100   # ~50s of real data
bun run dev
```

Offline alternative: `bun run db:seed-demo` builds a database from checked-in
captures **through the real persistence layer**, so it doubles as an end-to-end
exercise of that layer.

---

## What was verified, not assumed

Everything below was actually run, not reasoned about.

| Check                        | Result                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Live scrape, all 12 units    | 36 venues, 133 menus, 1,639 items, 205 labels, 0 errors                       |
| Allergen engine on real data | finds mustard, celery, anchovy, shrimp, barley — **none** declared upstream   |
| Group → species resolution   | `Contains: Tree Nuts` + prose `MACADAMIA NUTS` ⇒ `Tree Nuts — Macadamia`      |
| Full auth flow               | request → wrong code rejected → correct code → account → allergens → chips    |
| Favourites                   | saved, appears under "On today", allergen filter hides it                     |
| Live smoke test              | `LIVE_SCRAPE_TEST=1 bun run test:live` green against the real site            |
| Production build             | `node build/index.js` serves; migrations resolve                              |
| Responsive                   | no horizontal overflow at 375px on any page, with `sm:` classes still active  |
| Screenshot review            | strictly greyscale; the five severity forms are distinct at a glance          |
| Concurrent scrape            | second run exits 0 quietly on the lock; a lock >1h old is reclaimed           |
| Date arithmetic              | month, year, leap-year and both DST transitions, all in `tests/dates.test.ts` |

---

## Three decisions a next session should not undo without reading this

**1. The verdict tier keys on evidence SOURCE, not on the stored `confidence`.**

`match.ts` rates an ingredient hit `likely` when a parent group was declared and
`possible` otherwise. That is useful nuance for the evidence text, but as a
verdict input it would demote mustard and celery to the weakest tier purely
because upstream has no vocabulary in which to declare them. An ingredient list
naming `MUSTARD SEED` is strong evidence regardless of what upstream chose to
tag. See the comment on `VERDICT_FOR_SOURCE`.

**2. `unknown` also fires when a label exists but carries no ingredient list.**

The plan's table only covered "no label". But for an allergen outside upstream's
vocabulary, an empty ingredient list means the one place it could have appeared
was never populated — so "not found" would be a claim about nothing.

**3. Menu-wide unknowns are hoisted out of the rows.**

Celery and mustard were rendering "unverified" on all 24 rows of a menu. That is
honest and it becomes wallpaper — the exact "teach users to ignore warnings"
failure the design exists to prevent. `VenueMenu.hoistedUnknowns` states it once
per menu instead. Anything unknown on only _some_ dishes stays on its row,
because there the difference between rows is the signal.

The same reasoning removed the per-verdict umbrella-term advisory from the item
page: it is a property of the label, not of each allergen, so five verdicts
printed it five times. The Ingredients section says it once.

---

## Known gaps

- **Open-hours parsing is still inferred, not observed.** Every capture was
  taken out of term, when upstream renders `Closed` for all seven days.
  `parse/hours.ts` handles two plausible layouts and preserves unrecognised text
  in `raw`. The UI now treats an all-closed week as _upstream declining to
  publish_ rather than as a claim, because rendering "Closed today" above a
  published breakfast menu put two of our own statements in contradiction.
  **Re-capture during term and tighten `hours.test.ts`.**
- **`itempanel-empty.json` is synthesized**, not captured — no zero-item menu
  appeared in any capture window. Derived from a real panel by dropping the item
  rows; documented as such in the fixture README. Re-capture for real if one
  turns up, because upstream may render an explicit empty state.
- **`item.name_checked_at` is a one-shot.** Editing the `name` aliases in
  `allergen_alias` does not re-run inference over the back catalogue. `UPDATE
item SET name_checked_at = NULL` is the intended way to force it; there is no
  CLI flag for that yet.
- **Nutrition labels older than 90 days are never re-fetched.** The plan wanted
  a tail re-fetch (formulations change); the backfill queue is still only
  `label_fetched_at IS NULL`.
- **No CI.** The suite, `check`, `lint`, `build` and the live smoke test are all
  runnable, but nothing runs them on a schedule. The live smoke test is what
  should run nightly — it exists precisely to catch upstream drift.
- **No first full production scrape.** Only a `--days=0` slice has been run
  against the live site. The first full crawl is ~90 minutes; the estimate of
  ~2,234 menus and ~31k items is from the plan's enumeration, not measured by
  this code.

---

## Things that will bite you

All of these are encoded in tests, so you will only meet them if you change the
relevant code. The first eight are inherited and still true; the rest are new.

1. **`Accept-Language` must be a real language tag.** undici defaults it to `*`;
   this ASP.NET app parses that as a culture, throws, and serves its
   "NetNutrition Start-up Error" page **with HTTP 200** — so it reads as a site
   outage rather than a client bug.
2. **The nutrition-label endpoint is session-stateful.** It answers only for the
   menu currently selected in the session, returning a ~350-byte stub otherwise.
   Phase D walks menu by menu, selecting each once.
3. **Node's type-stripping cannot desugar TypeScript parameter properties.**
   `constructor(private readonly x: T)` fails under plain `node` while vitest's
   esbuild accepts it — so tests pass while the CLI cannot start. An eslint rule
   bans them in everything the CLI imports.
4. **`fetch` does not replay cookies across redirects.** Redirects are followed
   by hand.
5. **A bodyless POST returns HTTP 411.** Empty bodies are sent as `_=1`.
6. **Menu identity is `(unit_id, service_date, meal)`, never `nn_oid`.**
7. **Dates are America/Chicago wall clock.** Use `campusToday()` from
   `$lib/dates`. Never construct a `Date` from an upstream date string.
8. **`NA` and empty cells become `null`, never `0`.** Trans fat renders `NA`;
   Calcium genuinely renders `0%`.
9. **Nothing in a component may import runtime code from `$lib/server`.** The
   build guard rejects it — correctly. Pure shared code lives in `$lib/dates.ts`
   and `$lib/policy.ts`. `server/` is a boundary, not a junk drawer. This does
   not show up in `dev`, only in `build`.
10. **The `.sql` migrations do not survive bundling.** `migrate.ts` searches
    module-relative first, then `<cwd>/src/lib/server/db/migrations`, with a
    `MIGRATIONS_DIR` override. This only fails when the built artifact starts,
    so **run `node build/index.js` before believing a deploy works.**
11. **`vite dev` does not load `.env` into `process.env`.** Vite exposes it via
    `import.meta.env`. That is why login codes print to the console in dev and go
    out through Resend in production — convenient, but it is a consequence, not
    a feature. Export vars in your shell to test the production path.
12. **A plain mutated `Set` or `URLSearchParams` is invisible to Svelte
    reactivity.** The allergen picker's counts silently stopped updating until it
    used `SvelteSet`. eslint's `svelte/prefer-svelte-reactivity` catches it; the
    two suppressions in the codebase are local string builders and say so.
13. **`deactivateUnitsNotSeen` is guarded on `!onlyUnits && errors === 0`.** A
    `--unit=1` run legitimately never sees the other eleven units, and a unit
    missed to a timeout is not a unit that closed. Both guards have a test.
14. **An oid can be negative.** Upstream marks a course with no name using the
    sentinel `toggleCourseItems(this, -1234)`, labelled `None`. `extractOid`'s
    pattern was `(\d+)`, which returns `null` for it — so the heading never
    arrived and persistence dropped every dish underneath. Fixed, fixtured
    (`itempanel-nocategory.json`) and tested, but the shape of the mistake is
    the lesson: a parser that cannot read a value fails _silently_ here, and the
    only symptom is food missing from a menu.
15. **`menu_item` identity is `(menu_id, nn_detail_oid)`, not the dish name.**
    One menu can list the same name twice, same course, same serving size, as
    two different products with different allergens — upstream distinguishes
    them by `detailOid` alone. Keying on the name collapsed them and kept
    whichever came last in the markup. `item` remains the canonical DISH
    registry; two instances of one dish share an `item_id`.
16. **Upstream retires past days, and nothing used to remove them.** Its menu
    list ran 2026-08-21..09-17 on the 21st; the 20th was simply gone. The sweep
    in `persistMenu` is scoped to menus a run actually parsed (deliberately —
    a network failure must not erase data), so a menu that fell out of the
    window was never touched again, and its items sat in the label queue
    forever. The endpoint answers **0 bytes** for a retired menu, and because
    the queue is `service_date ASC` they sorted FIRST — so every run began by
    failing, reported `partial`, and would eventually have crossed the 50%
    circuit breaker and aborted the real work behind them. Fixed by
    `pruneMenusBefore(db, from)` plus a `notBefore` gate on the queue.
17. **Compare against the live site, not against the parsers.** Both bugs above
    passed every test in the repo and were invisible in the database. They only
    showed up as a count mismatch against upstream. There is an audit script
    pattern for this in the session history worth rebuilding if numbers ever
    look off: walk every venue, parse each menu, and diff parsed-item-count
    against stored-item-count.
18. **A `partial` run is a signal, not noise.** All three bugs above showed up
    first as a status or a count that was slightly off, and each was easy to
    read as "flaky upstream". None of them were.

---

## Upstream reference (all measured, not assumed)

Base: `https://eatsmart.housing.illinois.edu/NetNutrition/46`

| Purpose          | Call                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Unit list        | Embedded in the landing HTML — no extra request                                               |
| Hall → venues    | `Unit/SelectUnitFromUnitsList` `unitOid` → `childUnitsPanel`, **or `menuPanel` if childless** |
| Venue → menus    | `Unit/SelectUnitFromChildUnitsList` `unitOid`                                                 |
| Menu → items     | `Menu/SelecUnitAndtMenu` `unitOid`+`menuOid` — the typo is **upstream's**                     |
| Item → nutrition | `NutritionDetail/ShowItemNutritionLabel` `detailOid`+`menuOid` (raw HTML)                     |
| Hours            | `Unit/GetHoursOfOperationMarkup` `unitOid` (raw HTML)                                         |

- **12 top-level units → 36 leaf venues.** 8 of the 12 are **standalone** and
  return a menu list directly. A hall-only crawler drops two thirds of campus.
- `"Build Your Own"` appears under 4 unit oids with identical menu sets. Fetched
  once, persisted per venue — deduping the _persistence_ would make it vanish
  from three of its four halls.
- Upstream puts two different things in the `meal` field: real sittings, and
  all-day stations (`Beverages`, `Waffle Bar`). `mealSort` scores the former and
  leaves the rest at 99; the hall view's tab bar separates them on that basis.
- `detailOid` is **stable across sessions** but unique per (menu, item): a
  durable cache key, never a dish identity.
- Grid trait icons **equal** the label's `Contains:` set (28/28 measured).
  `tests/scraper/cross-source.test.ts` guards this.

**Etiquette (non-negotiable):** 3 concurrent, ≥150 ms between request starts
(~6 req/s), identifying User-Agent, circuit-break above 50% errors. There is no
`robots.txt` (404) but the app serves `X-Robots-Tag: noindex,nofollow`; uieats
serves its own pages `noindex` too and its `robots.txt` disallows everything.
This is an unauthenticated scrape of a university server with no API contract —
the IP can be blocked, and that would be reasonable.
