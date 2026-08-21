# uieats

UIUC dining menus with real allergen matching.

The university publishes its menus through **EatSmart**, a 2017-era CBORD
NetNutrition install. It works, but allergen data sits one click deep per dish
and there is no way to say _"I'm allergic to tree nuts, show me what I can
eat."_ A student with a real allergy opens a nutrition label for every single
item on the line.

uieats re-hosts that data: browse a whole hall or a single venue for any
upcoming day, with every dish flagged against the allergens you registered —
including the ones upstream only reports as a group. It says "Tree Nuts"; the
ingredient text says `MACADAMIA NUTS`. It says nothing at all about mustard,
celery or anchovy; the ingredient text often does.

```bash
bun install
bun run db:migrate
node scripts/scrape.ts --days=0 --label-budget=100   # ~50s of real data
bun run dev
```

No network handy? `bun run db:seed-demo` builds a database from checked-in
captures, through the real persistence layer.

## What it does that upstream cannot

- **A whole hall at once.** Nine venues, every meal, one page. Upstream needs
  eighteen round trips and a label click per dish.
- **Allergens you chose, on every row.** Including sub-allergens upstream
  reports only as a group, and allergens it has no vocabulary for at all.
- **`unknown` as a first-class answer.** An item with no label fetched is
  _unverified_, never _clear_. See below — this is the whole design.
- **Cross-hall search**, a diet filter, saved dishes, and a nutrition panel that
  prints `—` where upstream left a value blank rather than pretending it is `0`.

## The safety model

Everything visual reads its severity from one pure function,
`src/lib/server/allergens/verdict.ts`. It is the single place that decides
whether a dish is a problem for a user, and it has the most tests in the repo.

| Evidence                       | Verdict            | Chip                    |
| ------------------------------ | ------------------ | ----------------------- |
| Trait icon, or `Contains:`     | `flagged-declared` | solid black             |
| Keyword in the ingredient text | `flagged-likely`   | black outline           |
| The dish name only             | `flagged-possible` | dashed outline          |
| Read, and not found            | `no-declared`      | hairline grey           |
| Nothing read that could show   | `unknown`          | hatched, _"unverified"_ |

**The invariant.** With no nutrition label fetched, the verdict is `unknown` for
every allergen except the 18 carrying `covered_by_trait_vocabulary = 1`.
Upstream tags those on the item row itself, so a missing icon is weak evidence.
For mustard, celery, anchovy or a specific nut species, absence of evidence is
not evidence of absence.

`no-declared` never renders as the word "safe". Every chip carries the evidence
string that produced it — `Contains: Milk`, `ingredients: MACADAMIA NUTS` — so a
user can audit rather than trust. A cross-contact disclaimer sits in the footer
of every page and in full on every dish: shared fryers and serving utensils are
a real risk no label records.

Severity is encoded through **form, not hue** — filled, outlined, dashed,
hatched, hairline, each with its own icon. That survives a greyscale screen and
colour-blindness, which red/amber/green does not.

## Layout

```
src/lib/dates.ts              America/Chicago wall clock, everywhere
src/lib/policy.ts             who may hold an account (@illinois.edu)
src/lib/components/           AllergenChip, VenueMenu, ItemRow, NutritionPanel…
src/lib/server/
  allergens/verdict.ts        THE safety model. Start here.
  allergens/match.ts          ingredient + name matching, false positives first
  auth/                       login codes, sessions, passkeys
  db/                         5-method driver over node:sqlite, .sql migrations
  queries/                    one loader per browse level, all set-based
  scraper/  parse/            pure: string in, plain object out
            transport/        session, cookies, rate limit, circuit breaker
            persist/          idempotent
            crawl/run.ts      phases A-E
src/routes/                   +page.server.ts + +page.svelte, no client fetching
ops/                          systemd units, cron, and why the app never scrapes
tests/                        parser fixtures, fake transport, safety properties
```

## Commands

```bash
bun run dev / build / preview / check / lint / format
bun run test / test:watch / test:cov      # coverage gate: 90% lines on
                                          # parse/** and allergens/**
bun run test:live                         # six real requests, opt-in
bun run db:migrate / db:reset / db:seed-demo

node scripts/scrape.ts                    # full crawl (~90 min first run)
node scripts/scrape.ts --unit=1 --days=1 --label-budget=25    # tight loop
node scripts/scrape.ts --no-labels --no-hours
node scripts/capture-fixtures.ts          # re-capture upstream; never in CI
node scripts/write-fixture-manifest.ts    # after re-capturing
```

## Deploying

`DEPLOY.md` covers Coolify specifically, with a `Dockerfile` in the repo.
`ops/README.md` covers a plain host with systemd or cron. Both start from the
same rule: the web process never scrapes.

## Etiquette

3 concurrent requests, ≥150 ms apart (~6 req/s), an identifying User-Agent, and
a circuit breaker above a 50% error rate. uieats serves its own pages `noindex`,
matching what upstream serves — this is a utility for students, not an SEO
mirror of university content. `ops/README.md` has the rest.

Not affiliated with or endorsed by the University of Illinois.
