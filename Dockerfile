# uieats — production image.
#
# Two things drive the shape of this file, and both were measured rather than
# assumed:
#
#   1. `bun run build` does NOT bundle production dependencies. Copying only
#      `build/` into a clean image gets you
#      "Cannot find package '@simplewebauthn/server'" on boot. node_modules has
#      to be there.
#   2. The runtime needs the SOURCE TREE as well as the build output. The
#      scraper is a separate CLI (`node scripts/scrape.ts`) that Node
#      type-strips at load, and `db/migrate.ts` reads the numbered .sql files
#      off disk. Neither survives bundling.
#
# Bun installs and builds; Node runs. That split is not cosmetic: the database
# driver is Node's built-in `node:sqlite`, and the scraper CLI depends on Node's
# native TypeScript type-stripping. Running the server under Bun would put both
# on untested ground.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# Lockfile first, so a source-only change does not re-resolve dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# `vite build` runs svelte-kit sync itself, but doing it explicitly means a
# missing .svelte-kit fails here with a clear message rather than inside Vite.
RUN bun run prepare && bun run build

# ---------------------------------------------------------------------------
# Production dependencies, on their own so dev deps never reach the runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
# Node 26 is a hard requirement, not a preference: `node:sqlite` with STRICT
# tables, and type-stripping for the scraper CLI. If this tag does not resolve,
# try node:26-bookworm-slim -- but do not drop to 22 or 24, because the app will
# fail at runtime in ways the build will not catch.
FROM node:26-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# adapter-node's default. Coolify reads EXPOSE to wire up its proxy.
ENV PORT=3000
# Not for the app -- campusToday() pins America/Chicago itself and is container
# timezone independent (verified). This is for anything that reads the system
# clock, cron included, so a schedule written in campus time means campus time.
ENV TZ=America/Chicago

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
# The source tree, for the scraper CLI and the .sql migrations.
COPY src ./src
COPY scripts ./scripts
# Captured upstream responses, so `bun run db:seed-demo`-equivalent
# (`node scripts/seed-demo.ts`) can prove the whole persistence stack works
# without making a single request to the university.
COPY tests/fixtures ./tests/fixtures

# The SQLite database lives here and MUST be a mounted volume: a container
# filesystem is ephemeral, and losing this loses every account, allergen and
# saved dish. It must also be local disk -- WAL is unsafe over NFS, and the
# scraper writes while the web process reads.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Deliberately left as root. Coolify creates its volumes root-owned, and SQLite
# in WAL mode needs to write the DIRECTORY (-wal and -shm sidecars), not just
# the file -- so a non-root user hits "attempt to write a readonly database" on
# a fresh volume. See DEPLOY.md for how to harden this if you want to.

# Follows the redirect from / to /d/<today>, so this exercises the database and
# the volume mount rather than only proving a socket is open. Uses fetch instead
# of curl because the slim image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
