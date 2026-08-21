# Deploying uieats on Coolify

## What you are deploying

One container, two processes, one volume.

```
                    ┌─────────────────────────────────┐
   Coolify proxy ──▶│ node build/index.js   (:3000)   │  reads
                    │                                 │
   Coolify cron ───▶│ node scripts/scrape.ts (nightly)│  writes
                    └──────────────┬──────────────────┘
                                   │
                        /app/data/uieats.db   ← persistent volume, local disk
```

The web process **never** scrapes. That is a design decision, not an oversight:
Coolify can run more than one instance of a resource, and an in-process
scheduler would mean two scrapers fighting over one SQLite file, with a hung
scrape taking the web server down. See `ops/README.md`.

Scraping is a scheduled task instead, and concurrent runs are already safe — the
second run fails to claim a single-row `scrape_lock` and exits 0 quietly. Tested
locally; no `flock` needed.

---

## Three settings that are not optional

Get these wrong and the site will look like it works. That is what makes them
worth reading before you start.

### 1. `ORIGIN` — without it, nothing can be submitted

Every interaction in this app is a SvelteKit form action: signing in, entering
your code, saving allergens, saving a dish, signing out. SvelteKit checks the
`Origin` header against the URL it thinks it is serving, and behind a reverse
proxy it cannot work that URL out on its own.

Measured against the real build:

| `ORIGIN`                     | `POST /auth/login`                |
| ---------------------------- | --------------------------------- |
| unset                        | **403** — even from the same host |
| `https://uieats.example.com` | 303 (works)                       |

Pages render fine either way, so this presents as "the login button does
nothing" rather than as a misconfiguration. Set `ORIGIN` to the exact public
URL — scheme included, no trailing slash.

It also fixes passkeys for free. The WebAuthn relying party is derived from the
request URL rather than configured, so a correct `ORIGIN` gives a correct RP id
automatically — and a wrong one is not an error, it is credentials that silently
stop working.

### 2. A persistent volume at `/app/data`

The SQLite database holds every account, every registered allergen and every
saved dish. A container filesystem is ephemeral, so without a volume all of that
is destroyed on the next deploy — silently, because the app will simply migrate
a fresh empty database and carry on.

- Mount path: `/app/data`
- Must be **local disk**. WAL mode is unsafe over NFS, and the scraper writes
  while the web process reads.

`DATABASE_PATH` then needs no value: it defaults to `<cwd>/data/uieats.db`, and
the working directory is `/app`.

### 3. The cron must fire at 04:15 **America/Chicago**

The university publishes menus against local calendar days. A schedule
interpreted as UTC fires at 22:15 or 23:15 Central _the previous evening_ —
before upstream has published anything — and the offset changes twice a year
with daylight saving.

The app itself is immune to this: `campusToday()` pins the zone explicitly and
returns the same answer in a UTC container and a Tokyo one (verified). It is only
the _schedule_ that needs care. The image sets `TZ=America/Chicago` so a cron
expression written in campus time means campus time.

**Check which clock your Coolify instance schedules against** — there is an
instance-level timezone in Coolify's settings, and per-resource scheduled tasks
follow it. If it is not America/Chicago, either change it or use the container
cron fallback at the end of this document.

---

## Step by step

### 1. Point Coolify at the repository

- **New Resource → Application → Public/Private Repository**
- **Build Pack: `Dockerfile`.** Not Nixpacks.

  The repo has a `Dockerfile` written for this. Nixpacks would need to give you
  Node 26 specifically — the database driver is Node's built-in `node:sqlite`,
  and the scraper CLI relies on Node's native TypeScript type-stripping — and it
  would also need to keep the source tree next to the build output, which the
  next paragraph explains. The Dockerfile makes both explicit instead of hoping.

- **Port: `3000`** (adapter-node's default; `EXPOSE`d in the image).

Two things about that image are worth knowing, because both were found by
running the built artifact rather than by reading the code:

- `bun run build` does **not** bundle production dependencies. An image with only
  `build/` in it dies on boot with
  `Cannot find package '@simplewebauthn/server'`.
- The runtime needs the **source tree**, not just the build output. The scraper
  is a separate CLI that Node type-strips at load, and the migrator reads the
  numbered `.sql` files off disk — neither survives bundling.

### 2. Add the persistent volume

**Storages → Add → Volume Mount**

| Field       | Value         |
| ----------- | ------------- |
| Name        | `uieats-data` |
| Destination | `/app/data`   |

### 3. Environment variables

| Variable             | Value                                      | Why                                                                                                  |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ORIGIN`             | `https://uieats.example.com`               | **Required.** Without it every form action 403s. Exact public URL, no trailing slash.                |
| `RESEND_API_KEY`     | `re_...`                                   | **Required in production.** Without it login codes print to the container log instead of being sent. |
| `MAIL_FROM`          | `uieats <login@yourdomain>`                | Must be a domain verified in Resend.                                                                 |
| `SCRAPER_USER_AGENT` | `uieats/1.0 (+https://uieats.example.com)` | Identifies you to the university. Make the contact URL real.                                         |
| `ADDRESS_HEADER`     | `x-forwarded-for`                          | Otherwise every login attempt is recorded as coming from the proxy.                                  |
| `XFF_DEPTH`          | `1`                                        | How many proxies to trust in that header. Coolify's is one.                                          |
| `TZ`                 | `America/Chicago`                          | Already set in the image; listed so you can see it and not override it.                              |
| `SCRAPE_DAYS_AHEAD`  | `21` (default)                             | Each extra day is ~110 more menus.                                                                   |

`ORIGIN` and `RESEND_API_KEY` are the two that change behaviour rather than
tune it; the rest are adjustments. `.env.example` lists every variable that has
any effect and marks which are read by the app and which by adapter-node — if a
name is not in there, setting it does nothing.

> **A note on `RESEND_API_KEY`.** With no key the app falls back to printing
> codes to stdout. That is deliberately convenient in development and quietly
> broken in production: sign-in appears to work, and the code never arrives.
> Set it, then actually complete one sign-in before telling anyone the site is
> up.

### 4. Deploy, then check before adding data

```bash
# In Coolify: Deploy. Then open a terminal into the container.
node -e "const {getDb}=await import('./src/lib/server/db/index.ts'); \
         console.log('schema version', getDb().pragma('user_version'))"
```

You want `schema version 4`. The app migrates itself on first database access,
so a number here means the volume is mounted, writable, and the `.sql` files were
found.

### 5. Prove the stack works without touching the university

```bash
node scripts/seed-demo.ts
```

This builds a realistic database out of captured upstream responses, pushed
through the same persistence layer the live scraper uses — so it exercises
parsing, persistence and allergen matching end to end with zero network traffic.
Browse the site, sign in, register an allergen, confirm chips appear.

Then clear it out before the real thing:

```bash
node scripts/db-reset.ts
```

### 6. The first real scrape, by hand

The first crawl is roughly **90 minutes**: ~2,300 menu fetches plus ~31,000
nutrition labels at the 6 req/s politeness cap. Run it in a terminal where you
can watch it, not as a scheduled task that might hit a timeout:

```bash
node scripts/scrape.ts
```

Killing it is safe. The backfill queue is `label_fetched_at IS NULL`, so the next
run resumes exactly where it stopped. If you would rather start small:

```bash
node scripts/scrape.ts --days=0 --label-budget=200   # about a minute
```

Steady state after that is ~10 minutes a night, because `detailOid` is stable
across sessions and already-fetched labels are skipped.

### 7. The nightly schedule

**Scheduled Tasks → Add**

| Field     | Value                    |
| --------- | ------------------------ |
| Name      | `nightly-scrape`         |
| Command   | `node scripts/scrape.ts` |
| Frequency | `15 4 * * *`             |

04:15 is after upstream's overnight publish and before breakfast service, so the
soonest meals have labels by the time anyone looks. Re-read setting 3 above about
which timezone that expression is interpreted in.

The task also sweeps expired sessions, spent login codes and used WebAuthn
challenges on its way out, so there is nothing else to schedule.

---

## Verifying the deploy

```bash
# Did the last runs work?
node -e "const {getDb}=await import('./src/lib/server/db/index.ts');
console.table(getDb().prepare(\`SELECT id, status, menus_scraped, labels_fetched,
  error_count, datetime(started_at,'unixepoch') AS started
  FROM scrape_run ORDER BY id DESC LIMIT 5\`).all())"

# What went wrong, if anything?
node -e "const {getDb}=await import('./src/lib/server/db/index.ts');
console.table(getDb().prepare(\`SELECT phase, kind, target, message FROM scrape_error
  WHERE run_id = (SELECT MAX(id) FROM scrape_run) LIMIT 20\`).all())"

# Is upstream still shaped the way the parsers expect? Six real requests.
LIVE_SCRAPE_TEST=1 npx vitest run tests/scraper/live.smoke.test.ts
```

That last one is the check worth automating. Upstream is a 2017-era ASP.NET app
with no version, no API contract and no changelog; the smoke test asserts shape
invariants only ("at least eight units", never "twelve named these") so its job
is to tell you upstream changed before a user does.

The app reports on itself too. Every page footer carries how fresh the menu data
is and switches to a warning past 30 hours, and the web process logs once at boot
if no successful run has finished inside that window. It never starts a scrape.

---

## Troubleshooting

| Symptom                                                               | Cause                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pages load, but sign-in / save / logout do nothing (403 in dev tools) | `ORIGIN` unset or not matching the public URL exactly.                                                                                  |
| Container exits: `Cannot find package '@simplewebauthn/server'`       | The image has `build/` without `node_modules`. Build with the provided Dockerfile.                                                      |
| Container exits: `Could not find the migrations directory`            | The source tree is missing from the runtime image. The error lists every path it looked in; `MIGRATIONS_DIR` overrides it.              |
| `SQLITE_READONLY` / `attempt to write a readonly database`            | The volume is not writable by the container user. See the hardening note below.                                                         |
| Everything works, then a deploy empties the site                      | No volume at `/app/data`. The app migrated a fresh empty database and said nothing, because an empty database is a legitimate state.    |
| Login codes never arrive                                              | `RESEND_API_KEY` unset — check the container log, the code is printed there — or `MAIL_FROM` is not a Resend-verified domain.           |
| Menus are a day behind                                                | The cron is being interpreted in the wrong timezone. See setting 3.                                                                     |
| Passkeys enrol, then stop working                                     | `ORIGIN` changed, so the relying-party id changed. Existing credentials are bound to the old hostname and cannot be migrated.           |
| A scheduled scrape logs "another scrape is running" and exits         | Working as intended — the previous run is still going. A lock older than an hour is treated as dead and reclaimed.                      |
| `scrape_run.status` is `partial`                                      | Some work items failed; `scrape_error` says which. Under 20% is normal for a flaky upstream. `failed` means it circuit-broke above 50%. |

### Hardening the container user

The image runs as root, deliberately. Coolify creates volumes owned by root, and
SQLite in WAL mode has to write the _directory_ (the `-wal` and `-shm` sidecars),
not just the database file — so a non-root user hits a readonly database on a
fresh volume.

If you would rather not run as root, add to the Dockerfile:

```dockerfile
RUN chown -R node:node /app/data
USER node
```

...and then fix the ownership of the existing volume from the host, once:

```bash
docker run --rm -v uieats-data:/data alpine chown -R 1000:1000 /data
```

Do it in that order. `USER node` alone will look fine until the first write.

---

## Updating

Push to the tracked branch; Coolify rebuilds and restarts. Migrations apply
themselves on the first database access after boot, inside a transaction that
also bumps `user_version` — so a crash mid-file cannot leave a half-applied
schema, and re-running is a no-op.

Deployments are not zero-downtime. The scraper and the web process share one
SQLite file, and two containers overlapping during a rolling restart would have
two writers. Accept the few seconds.

## Backups

Coolify's managed backups cover databases it provisions, not arbitrary volumes,
so this one is on you. **Do not `cp` the file** — in WAL mode a plain copy can
catch a torn state, and it will leave the `-wal` sidecar behind.

`VACUUM INTO` writes a consistent snapshot while the database is live, and needs
nothing that is not already in the image (verified: a 970KB snapshot of a 2,235
row database, reopened and read back):

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/app/data/uieats.db',{readOnly:true});
db.exec(\"VACUUM INTO '/tmp/uieats-$(date +%F).db'\");
db.close(); console.log('ok')"
```

Written to `/tmp`, not into `/app/data`, on purpose: a snapshot sitting on the
volume it is a backup of survives a mistake but not the volume being lost, which
is the failure it exists for. Copy it off:

```bash
docker cp <container>:/tmp/uieats-$(date +%F).db ./
```

Nothing in this database cannot be re-scraped except `user`, `user_allergen`,
`favorite` and `webauthn_credential` — which are the only rows a person would
actually miss. That is a few kilobytes, so back up daily and do not think about
it again.

---

## Fallback: cron inside the container

If your Coolify instance schedules in a timezone you cannot change, run cron in
the container instead and let `TZ` (already `America/Chicago` in the image) do
the work. `ops/crontab.example` has the entry:

```cron
CRON_TZ=America/Chicago
15 4 * * * cd /app && /usr/local/bin/node scripts/scrape.ts >> /proc/1/fd/1 2>&1
```

`>> /proc/1/fd/1` sends the output to the container's stdout so it lands in
Coolify's logs rather than in a file nobody reads. This needs `cron` installed
and started in the image, which the provided Dockerfile does not do — prefer the
scheduled task if you can.

---

## What has not been tested

Being straight about the boundary of what I verified:

- **The image has never been built.** No Docker daemon was available here. Every
  claim about the app's runtime requirements in the `Dockerfile` was measured by
  running the built artifact locally — production dependencies are needed,
  migrations must be on disk, `ORIGIN` is mandatory, the healthcheck passes
  through the redirect — but the layer mechanics, the `node:26-slim` tag
  resolving, and `bun install --production` are all first-run-and-see. Expect to
  iterate once.
- **No full production scrape has ever run.** Only a `--days=0` slice against the
  live site (133 menus, 1,639 items, 205 labels, 0 errors, ~50s). The ~90 minute
  and ~31,000 label figures come from enumerating upstream, not from this code
  having done it.
- **Coolify's own behaviour** — which timezone scheduled tasks use, whether it
  root-owns volumes on your version — is from documentation and general
  experience, not from your instance. The two places that matters are flagged
  above.

## One last thing

This is an unauthenticated scrape of a university server that has no API
contract and never agreed to any of it. The politeness limits in
`ops/README.md` are not tuning parameters: 3 concurrent requests, ≥150ms apart,
an identifying User-Agent with a contact address that works, and a circuit
breaker at a 50% error rate. Put a real contact URL in `SCRAPER_USER_AGENT`
before the first full run, so that if this ever becomes a problem for them,
someone can reach you instead of blocking the IP.
