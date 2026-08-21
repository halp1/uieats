# uieats — handoff

**Status: backend complete through the scraper. 167 tests green. No UI yet.**

Read this, then the plan at `~/.claude/plans/plan-app-purpose-provide-woolly-snail.md`,
then start at **What to do next**.

```bash
bun install
bun run test          # 167 tests, ~1s
bun run db:reset      # creates data/uieats.db
node scripts/scrape.ts --unit=1 --days=1 --label-budget=25   # ~18s, real data
```

---

## What this app is

UIUC publishes dining menus through **EatSmart**, a 2017-era CBORD NetNutrition
install at `https://eatsmart.housing.illinois.edu/NetNutrition/46`. Allergen
data is buried one click deep per dish, and there is no way to say "I'm
allergic to tree nuts, show me what I can eat."

uieats re-hosts that data as a fast SvelteKit app: browse a whole hall or a
single venue for any upcoming day, with every item flagged against the
allergens you registered — including sub-allergens upstream only reports as a
group (it says "Tree Nuts"; the ingredient text says "MACADAMIA NUTS").

**Decisions the user already made — do not relitigate:**

|                 |                                                                               |
| --------------- | ----------------------------------------------------------------------------- |
| Email           | Resend. `RESEND_API_KEY` is already in `.env` (gitignored).                   |
| Scrape depth    | **Full** — a nutrition label per item instance, not per recipe.               |
| Signup          | `@illinois.edu` only.                                                         |
| Extras in scope | dining hours · cross-hall search · favorites · diet filters + nutrition panel |
| UI              | shadcn-svelte, strictly black/white/grays.                                    |

---

## Done (8 commits, phases 0–3 plus half of 4)

| Area              | Where                                       | State                                                                                       |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Toolchain         | `vite.config.ts`, `package.json`            | vitest wired, deps installed, `.env.example` documents every knob                           |
| Database          | `src/lib/server/db/`                        | `node:sqlite` behind a 5-method driver; numbered `.sql` migrations on `PRAGMA user_version` |
| Schema            | `db/migrations/0001_init.sql`               | All tables STRICT. Auth, allergens, units, menus, nutrition, favorites, scrape audit        |
| Allergen seed     | `0002`, `0003`                              | 63 allergens (groups → species), 164 aliases, 25 traits                                     |
| Parsers           | `scraper/parse/`                            | 7 pure parsers, TDD against real captured fixtures, 98.9% line coverage                     |
| Transport         | `scraper/transport/`                        | Session, cookie jar, retry, rate limiter                                                    |
| Persistence       | `scraper/persist/`                          | Idempotent; "scrape twice → identical rows" is tested                                       |
| Crawl + CLI       | `scraper/crawl/run.ts`, `scripts/scrape.ts` | **Verified end-to-end against the live site**                                               |
| Allergen matching | `allergens/match.ts`                        | Ingredient + name matching with the full false-positive suite                               |

---

## What to do next, in order

### 1. `allergens/verdict.ts` — finish Phase 4 (start here; everything visual depends on it)

The single enforcement point for the safety model. Nothing else may decide
whether an item is safe.

```ts
export type Verdict =
	| 'flagged-declared' // trait icon or Contains:      -> solid black chip
	| 'flagged-likely' // ingredient keyword hit       -> black outline
	| 'flagged-possible' // item name only               -> dashed outline
	| 'no-declared' // label fetched, nothing found -> gray
	| 'unknown'; // NO label yet                 -> gray "unverified"
```

**The invariant, which must have its own test:**

> If an item has no nutrition label yet, the verdict is `unknown` for every
> allergen **except** the 18 carrying `covered_by_trait_vocabulary = 1`.
> Upstream tags those on the item row itself, so the absence of an icon is weak
> evidence. For everything else — mustard, celery, anchovy, specific nut
> species — absence of evidence is **not** evidence of absence.

`no-declared` must never render as the word "safe". Every chip carries its
evidence string (`"Contains: Milk"`, `"ingredients: MACADAMIA NUTS"`) so a user
can audit rather than trust. A cross-contact disclaimer belongs in the layout
footer and on every item page: shared fryers and serving utensils are a real
risk this data cannot capture.

Write `tests/allergens/verdict.test.ts` covering every
`(hasLabel, hasTraits, coveredByTraitVocab)` combination, plus a property test
that no code path returns anything reading as "safe" without a label.

### 2. Wire matching into the scrape

`allergens/match.ts` exists but nothing calls it. In
`scraper/persist/nutrition.ts → persistLabel`, after the `Contains:` mapping,
run `matchIngredients(db, label.ingredientsText, declaredIds)` and insert the
results into `nutrition_allergen`. Pass the declared ids so a species under a
declared group is rated `likely` rather than `possible`.

### 3. UI (Phase 5) — the largest remaining chunk

```
+layout.svelte / +layout.server.ts    shell, nav, footer (freshness + disclaimer)
+page.server.ts                       redirect -> /d/{campusToday()}
d/[date]/                             all halls for a date
d/[date]/[hall]/                      WHOLE HALL — every venue that day
d/[date]/[hall]/[venue]/              single venue
item/[slug]/                          nutrition, ingredients, allergen evidence
search/                               cross-hall search + allergen filter
```

Build `src/lib/server/queries/menus.ts` first:

```ts
getMenusForScope(db, { date, hallId, venueId?, userId? })
```

The venue route passes `venueId` (array of one), the hall route omits it (array
of N). Both render the same `<VenueMenu>` component. One query, one shape, two
skins — "whole hall at once" then costs nothing extra. Do it as a single
statement joining `menu → menu_category → menu_item → item`, grouped in
TypeScript. **Not N+1.**

Everything is `+page.server.ts` + `+page.svelte`. No `+page.ts`, no client
fetching — the DB is local and synchronous.

shadcn-svelte setup: `bun run prepare`, then hand-write `components.json` with
`tailwind.css` pointing at the existing **`src/routes/layout.css`** (not
`src/app.css`) and `baseColor: "neutral"` — the only genuinely hueless base.
Then `bunx shadcn-svelte@latest add button card badge dialog dropdown-menu input
input-otp label select separator sheet skeleton switch table tabs tooltip alert
checkbox sonner`.

shadcn's `--destructive` is red, which the brief rules out. **Encode allergen
severity through form, not hue** — solid fill / outline / dashed / gray, each
with a distinct Lucide icon.

### 4. Auth (Phase 6), then extras (7–8), then ops (9)

Schema is already in place: `user`, `user_session`, `login_code`,
`webauthn_credential`, `webauthn_challenge`. Email-code flow first, passkeys
after. `@illinois.edu` enforced at request-code time with a deliberately
generic response so the endpoint does not leak which addresses exist. Hold the
email in a short-lived HttpOnly cookie between request and verify — never in
the URL.

---

## Things that will bite you

These each cost real debugging time. They are all encoded in tests, so you will
only meet them if you change the relevant code.

1. **`Accept-Language` must be a real language tag.** undici defaults it to
   `*`; this ASP.NET app parses that as a culture, throws, and serves its
   "NetNutrition Start-up Error" page **with HTTP 200** — so it reads as a site
   outage rather than a client bug. curl works only because it sends no
   `Accept-Language` at all. I lost twenty minutes to this believing the site
   was down.

2. **The nutrition-label endpoint is session-stateful.** It answers only for
   the menu currently selected in the session and returns a ~350-byte stub
   otherwise (`detailOid 122098120`: 359 bytes, then 8,214 after selecting its
   menu). Phase D walks menu by menu, selecting each once. The first live run
   silently stored 15 empty labels before this was found.

3. **Node's type-stripping cannot desugar TypeScript parameter properties.**
   `constructor(private readonly x: T)` fails at load under plain `node`, while
   vitest's esbuild accepts it — so 144 tests passed while the CLI could not
   start. An eslint rule now bans them in everything the CLI imports.

4. **`fetch` does not replay cookies across redirects.** The landing URL 302s
   to itself and sets the session cookies on the redirect response, so an
   automatic follow arrives session-less. Redirects are followed by hand.

5. **A bodyless POST returns HTTP 411.** Empty bodies are sent as `_=1`.

6. **Menu identity is `(unit_id, service_date, meal)`, never `nn_oid`.**
   Upstream republishes menus under new oids; treating the oid as identity
   gives you duplicates or a UNIQUE violation on the next scrape.

7. **Dates are America/Chicago wall clock.** Use `campusToday()` from
   `src/lib/server/time.ts`. Never construct a `Date` from an upstream date
   string — a UTC server would roll to tomorrow's menu at 7pm Central.

8. **`NA` and empty cells become `null`, never `0`.** Trans fat renders `NA`;
   Calcium genuinely renders `0%`. Collapsing those states would assert
   something upstream never said.

9. **Do not create `svelte.config.js`.** Kit options come from
   `vite.config.ts`; Kit warns and _ignores_ a config file when that is the
   case. shadcn-svelte resolves `$lib` from `.svelte-kit/tsconfig.json`.

10. **Nothing under `scraper/**` may import `$lib`/`$app`/`$env`** — the CLI
    runs outside Vite. Enforced by eslint. `parse/**` additionally may not
    touch I/O, `process.env`, or `Date`; that purity is what makes the fixture
    tests meaningful.

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

- **12 top-level units → 36 leaf venues → 2,234 menus → ~31,000 item instances.**
- 8 of the 12 top-level units are **standalone** (no children) and return a menu
  list directly. A hall-only crawler drops all of them.
- `"Build Your Own"` appears under 4 unit oids (10, 21, 28, 31) with identical
  menu sets. Fetch once, persist per venue — deduping the _persistence_ would
  make it vanish from three of its four halls.
- `detailOid` is **stable across sessions** but unique per (menu, item): a
  durable cache key, never a dish identity. This is what makes "full" nutrition
  affordable — first run ~90 min, nightly ~10 min.
- Grid trait icons **equal** the label's `Contains:` set (28/28 measured), and
  the grid additionally carries diet tags the label omits.
  `tests/scraper/cross-source.test.ts` guards this.

**Etiquette (non-negotiable):** 3 concurrent, ≥150 ms between request starts
(~6 req/s), identifying User-Agent, circuit-break above 50% errors. There is no
`robots.txt` (404) but the app serves `X-Robots-Tag: noindex,nofollow` — serve
uieats' own menu pages `noindex` too. This is an unauthenticated scrape of a
university server with no API contract; the IP can be blocked.

---

## Known gaps

- **`verdict.ts` does not exist.** Highest priority.
- **`match.ts` is not wired into the scrape** — it is tested but never called.
- **Open-hours parsing is inferred, not observed.** Every capture was taken out
  of term, when upstream renders `Closed` for every day. `parse/hours.ts`
  handles two plausible layouts and preserves unrecognised text in `raw`.
  Re-capture during term and tighten `hours.test.ts`.
- **`itempanel-empty.json` fixture is missing** — no zero-item menu was found
  while capturing. Synthesize one or find one during term.
- **No live smoke test yet** (`tests/scraper/live.smoke.test.ts`, gated on
  `LIVE_SCRAPE_TEST`). The plan wants five real requests asserting shape
  invariants only, as upstream-drift detection.
- **No cron/systemd unit, no staleness banner** (Phase 9).
- **Upstream goes down.** It served its start-up error page for ~10 minutes
  during this session. `scripts/capture-fixtures.ts` refuses to overwrite good
  fixtures with error pages — it had already clobbered four before that guard
  existed.

---

## Commands

```bash
bun run dev / build / check / lint / format
bun run test / test:watch / test:cov          # coverage gate: 90% lines on parse/** and allergens/**
bun run db:reset / db:migrate

node scripts/scrape.ts                        # full crawl
node scripts/scrape.ts --unit=1 --days=2      # tight loop while iterating
node scripts/scrape.ts --no-labels --label-budget=50
node scripts/capture-fixtures.ts              # re-capture upstream (never in CI)
node scripts/write-fixture-manifest.ts        # after re-capturing
```

`scripts/gen-allergen-seed.py` regenerates `0002_seed_allergens.sql`. Edit the
generator, not the SQL — but only for a _new_ migration; `0002` has shipped.
