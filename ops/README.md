# Running uieats

Two processes, one database, and one rule: **the web process never scrapes.**

> Deploying to Coolify? Read `../DEPLOY.md` instead — same rule, but containers
> move where the volume, the cron and the `ORIGIN` setting live.

```
adapter-node ──reads──┐
                      ├── data/uieats.db  (WAL, local disk)
cron / systemd ─writes┘
```

## Why the scrape is a cron job and not in the app

adapter-node under a process manager can run several instances. An in-process
scheduler would then mean several scrapers fighting over one SQLite file, a hung
scrape taking the web server down with it, and a dev restart re-triggering the
whole thing. The web process reports on data freshness and never repairs it.

Concurrency is still guarded, because a timer can fire while the last run is
going: `scripts/scrape.ts` claims a single-row `scrape_lock`, and a run that
cannot claim it exits 0 quietly. A lock older than an hour is assumed dead.

## Install

```bash
# 1. Code and a service account
useradd --system --home /srv/uieats uieats
git clone <repo> /srv/uieats && cd /srv/uieats
bun install --production=false     # svelte-kit build needs the dev deps
bun run build

# 2. Environment. RESEND_API_KEY is what switches login emails from the
#    console to real delivery, so a missing key is a working dev setup and a
#    broken production one -- set it deliberately.
install -d -m 0750 -o uieats -g uieats /etc/uieats
cp .env.example /etc/uieats/env && chmod 0640 /etc/uieats/env

# 3. Database. `data/` must be on LOCAL DISK: WAL over NFS is unsafe, and the
#    scraper writes while the web process reads.
install -d -m 0750 -o uieats -g uieats /srv/uieats/data
sudo -u uieats bun run db:migrate

# 4. Nightly scrape
cp ops/uieats-scrape.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now uieats-scrape.timer

# 5. First full crawl, in the foreground, so you can watch it
sudo -u uieats node scripts/scrape.ts
```

The first run is roughly 90 minutes: ~2,300 menu fetches plus ~31,000 nutrition
labels at the 6 req/s politeness cap. Steady state is ~10 minutes a night,
because `detailOid` is stable across sessions and already-fetched labels are
skipped. `kill -9` mid-run is safe — the backfill queue is
`label_fetched_at IS NULL`, so the next run resumes where it stopped.

## Checks

```bash
# What the last runs did
sqlite3 data/uieats.db \
  'SELECT id, status, menus_scraped, labels_fetched, error_count,
          datetime(started_at,"unixepoch") FROM scrape_run ORDER BY id DESC LIMIT 5;'

# What went wrong, if anything
sqlite3 data/uieats.db \
  'SELECT phase, kind, target, message FROM scrape_error
   WHERE run_id = (SELECT MAX(id) FROM scrape_run) LIMIT 20;'

# Is upstream still shaped the way the parsers expect? Five real requests.
LIVE_SCRAPE_TEST=1 bun run test:live
```

The app itself says how fresh its data is, in the footer of every page, and
switches to a warning past 30 hours. The web process also logs once at boot if
no successful run has finished inside that window. Neither ever starts a scrape.

## Etiquette, which is not optional

This is an unauthenticated scrape of a university server with no API contract.
The IP can be blocked, and that would be a reasonable thing for them to do.

- 3 concurrent requests, ≥150 ms between starts (~6 req/s), 20 s timeout.
- An identifying `User-Agent` with a contact URL.
- Circuit-break above a 50% error rate — never keep hammering a site that is
  already unwell.
- `SCRAPER_DRY_RUN=1` and `SCRAPER_MAX_REQUESTS=N` are the kill switches.
- uieats serves its own pages `noindex`, matching what upstream serves. This is
  a utility for students, not an SEO mirror of university content.

If the volume ever becomes a problem, `RECIPE_MODE=dedupe` collapses nutrition
to one label per normalized (dish, serving size) — about a tenth of the
requests, at the cost of assuming a dish is identical wherever it appears.
