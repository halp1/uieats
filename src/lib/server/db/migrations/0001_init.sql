-- uieats initial schema.
--
-- Conventions:
--   * Every table is STRICT. Without an ORM this is the only thing stopping a
--     stray string landing in an INTEGER column.
--   * Timestamps are INTEGER unix seconds. Dates are TEXT 'YYYY-MM-DD', which
--     sorts lexically and joins straight to a route param.
--   * Upstream NetNutrition ids live in nn_* columns and are never a primary
--     key -- see the note on menu identity below.

-- ===========================================================================
-- Auth
-- ===========================================================================

CREATE TABLE user (
  id                INTEGER PRIMARY KEY,
  email             TEXT    NOT NULL UNIQUE,   -- stored lowercased + trimmed
  email_verified_at INTEGER,
  display_name      TEXT,
  created_at        INTEGER NOT NULL,
  last_login_at     INTEGER
) STRICT;

-- id is hex(sha256(token)). The raw token exists only in the user's cookie, so
-- a database leak does not hand over live sessions.
CREATE TABLE user_session (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
) STRICT;
CREATE INDEX idx_session_user    ON user_session(user_id);
CREATE INDEX idx_session_expires ON user_session(expires_at);

-- Keyed by email rather than user_id: signup and login are the same flow, and
-- the account may not exist yet when the code is issued.
CREATE TABLE login_code (
  id          INTEGER PRIMARY KEY,
  email       TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,          -- hex(sha256(id || ':' || code))
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT
) STRICT;
CREATE INDEX idx_login_code_email ON login_code(email, expires_at);

CREATE TABLE webauthn_credential (
  id           TEXT    PRIMARY KEY,      -- base64url credential id
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  public_key   BLOB    NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                     -- JSON array
  device_type  TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;
CREATE INDEX idx_cred_user ON webauthn_credential(user_id);

CREATE TABLE webauthn_challenge (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER REFERENCES user(id) ON DELETE CASCADE,  -- NULL: discoverable login
  challenge  TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('registration', 'authentication')),
  expires_at INTEGER NOT NULL
) STRICT;

-- ===========================================================================
-- Allergen taxonomy
-- ===========================================================================

CREATE TABLE allergen (
  id        INTEGER PRIMARY KEY,
  slug      TEXT    NOT NULL UNIQUE,
  label     TEXT    NOT NULL,
  parent_id INTEGER REFERENCES allergen(id),
  kind      TEXT    NOT NULL CHECK (kind IN ('group', 'leaf', 'diet')),
  -- True only for the 17 allergens upstream tags with a trait icon on every
  -- item row. ONLY these may ever reach a "no declared X" verdict from the
  -- absence of an icon; for anything else, absence of evidence is not
  -- evidence of absence. See allergens/verdict.ts.
  covered_by_trait_vocabulary INTEGER NOT NULL DEFAULT 0,
  sort      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_allergen_parent ON allergen(parent_id);

CREATE TABLE allergen_alias (
  id          INTEGER PRIMARY KEY,
  allergen_id INTEGER NOT NULL REFERENCES allergen(id) ON DELETE CASCADE,
  alias       TEXT    NOT NULL,          -- lowercase
  match_kind  TEXT    NOT NULL CHECK (match_kind IN ('trait','contains','ingredient','name')),
  requires_word_boundary INTEGER NOT NULL DEFAULT 1,
  -- Pipe-separated preceding words that VETO a match. Without this, "cocoa
  -- butter" and "peanut butter" both read as milk.
  negative_prefixes TEXT
) STRICT;
CREATE UNIQUE INDEX idx_alias_unique ON allergen_alias(match_kind, alias, allergen_id);
CREATE INDEX idx_alias_kind ON allergen_alias(match_kind);

CREATE TABLE user_allergen (
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  allergen_id INTEGER NOT NULL REFERENCES allergen(id) ON DELETE CASCADE,
  severity    TEXT    NOT NULL DEFAULT 'avoid' CHECK (severity IN ('avoid', 'severe')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, allergen_id)
) STRICT, WITHOUT ROWID;

-- ===========================================================================
-- Catalog: halls, venues, hours
-- ===========================================================================

-- One self-referential table, mirroring upstream exactly: a unit with children
-- is a hall, a unit with a parent is a venue, a unit with neither returns a
-- menu list directly (e.g. Field of Greens, oid 32).
CREATE TABLE unit (
  id            INTEGER PRIMARY KEY,
  nn_oid        INTEGER NOT NULL UNIQUE,
  parent_id     INTEGER REFERENCES unit(id),
  name          TEXT    NOT NULL,        -- 'Ikenberry Dining Center (Ike)'
  short_name    TEXT,                    -- 'Ike', from the trailing parens
  slug          TEXT    NOT NULL,        -- assigned once; changing it breaks links
  kind          TEXT    NOT NULL CHECK (kind IN ('hall', 'venue', 'standalone')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_unit_slug   ON unit(COALESCE(parent_id, 0), slug);
CREATE INDEX        idx_unit_parent ON unit(parent_id, sort);

CREATE TABLE unit_hours (
  id         INTEGER PRIMARY KEY,
  unit_id    INTEGER NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  ordinal    INTEGER NOT NULL DEFAULT 0,  -- venues can have split hours
  opens      TEXT,                        -- 'HH:MM' local, NULL when closed
  closes     TEXT,
  is_closed  INTEGER NOT NULL DEFAULT 0,
  raw        TEXT    NOT NULL,
  scraped_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_hours_unique ON unit_hours(unit_id, weekday, ordinal);

-- The Open/Closed badge upstream renders is a point-in-time observation, not a
-- fact about the venue, so it lives apart from unit_hours.
CREATE TABLE unit_status (
  unit_id     INTEGER PRIMARY KEY REFERENCES unit(id) ON DELETE CASCADE,
  is_open     INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
) STRICT;

-- ===========================================================================
-- Menus
-- ===========================================================================

-- MENU IDENTITY, the decision most likely to be got wrong:
--   (unit_id, service_date, meal) is the identity.
--   nn_oid is a MUTABLE FETCH HANDLE and gets a plain index.
-- Upstream republishes menus under new oids. Making nn_oid unique too throws
-- on the second scrape after that happens; upserting on the natural key and
-- overwriting nn_oid re-scrapes cleanly instead.
CREATE TABLE menu (
  id              INTEGER PRIMARY KEY,
  unit_id         INTEGER NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  service_date    TEXT    NOT NULL,     -- 'YYYY-MM-DD', America/Chicago wall clock
  meal            TEXT    NOT NULL,     -- raw upstream string
  meal_sort       INTEGER NOT NULL DEFAULT 99,
  nn_oid          INTEGER NOT NULL,
  header_raw      TEXT,
  item_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at   INTEGER NOT NULL,
  last_scraped_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_menu_identity  ON menu(unit_id, service_date, meal);
CREATE INDEX        idx_menu_oid       ON menu(nn_oid);
CREATE INDEX        idx_menu_date      ON menu(service_date, meal_sort);
CREATE INDEX        idx_menu_unit_date ON menu(unit_id, service_date);

CREATE TABLE menu_category (
  id             INTEGER PRIMARY KEY,
  menu_id        INTEGER NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  nn_category_id INTEGER NOT NULL,      -- the 12 in toggleCourseItems(this, 12)
  name           TEXT    NOT NULL,
  sort           INTEGER NOT NULL,
  scrape_run_id  INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_cat_unique ON menu_category(menu_id, nn_category_id);

-- Canonical dish registry, deduped across every menu in the system.
-- name_norm must be normalized CONSERVATIVELY (lowercase, collapse whitespace,
-- decode entities, strip trailing punctuation -- no stemming, no stopword
-- removal, no stripping parentheticals). Two different dishes colliding here
-- would make one inherit the other's allergens: a safety bug, not a data bug.
CREATE TABLE item (
  id            INTEGER PRIMARY KEY,
  name_norm     TEXT    NOT NULL UNIQUE,
  name_display  TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  first_seen_at INTEGER NOT NULL
) STRICT;

-- Content-addressed nutrition. Every menu_item gets its own real label fetch,
-- but identical labels collapse onto one row here, so ~31k instances store as
-- ~3k facts.
CREATE TABLE nutrition_fact (
  id                INTEGER PRIMARY KEY,
  content_hash      TEXT    NOT NULL UNIQUE,  -- sha256 of the normalized label body
  serving_size_text TEXT,
  serving_grams     REAL,
  calories          REAL,
  cal_from_fat      REAL,
  total_fat_g       REAL,
  sat_fat_g         REAL,
  trans_fat_g       REAL,   -- upstream renders 'NA' here; that must become NULL, not 0
  poly_fat_g        REAL,
  mono_fat_g        REAL,
  cholesterol_mg    REAL,
  sodium_mg         REAL,
  potassium_mg      REAL,
  total_carb_g      REAL,
  fiber_g           REAL,
  fiber_is_lt       INTEGER NOT NULL DEFAULT 0,  -- upstream '< 1g' -> 0.5 with this set
  sugars_g          REAL,
  protein_g         REAL,
  vit_a_dv          REAL,
  vit_c_dv          REAL,
  calcium_dv        REAL,
  iron_dv           REAL,
  ingredients_text  TEXT,
  contains_text     TEXT,
  first_seen_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE recipe_ingredient (
  id                INTEGER PRIMARY KEY,
  nutrition_fact_id INTEGER NOT NULL REFERENCES nutrition_fact(id) ON DELETE CASCADE,
  sort              INTEGER NOT NULL,
  component_name    TEXT    NOT NULL,   -- 'Mix Cake Yellow Gold Medal'
  ingredient_text   TEXT                -- the parenthesized body
) STRICT;
CREATE INDEX idx_ri_fact ON recipe_ingredient(nutrition_fact_id, sort);

-- Matching runs once per distinct label rather than once per instance.
CREATE TABLE nutrition_allergen (
  nutrition_fact_id INTEGER NOT NULL REFERENCES nutrition_fact(id) ON DELETE CASCADE,
  allergen_id       INTEGER NOT NULL REFERENCES allergen(id) ON DELETE CASCADE,
  source            TEXT    NOT NULL CHECK (source IN ('contains', 'ingredient', 'name')),
  confidence        TEXT    NOT NULL CHECK (confidence IN ('declared', 'likely', 'possible')),
  evidence          TEXT,   -- the exact matched substring, surfaced in the UI
  PRIMARY KEY (nutrition_fact_id, allergen_id, source)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_na_allergen ON nutrition_allergen(allergen_id);

CREATE TABLE menu_item (
  id                INTEGER PRIMARY KEY,
  menu_id           INTEGER NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  category_id       INTEGER NOT NULL REFERENCES menu_category(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL REFERENCES item(id),
  -- Stable across sessions, but unique per (menu, item): a durable cache key,
  -- never a dish identity.
  nn_detail_oid     INTEGER NOT NULL,
  serving_size      TEXT,
  serving_size_norm TEXT,
  sort              INTEGER NOT NULL,
  nutrition_fact_id INTEGER REFERENCES nutrition_fact(id),
  label_fetched_at  INTEGER,            -- NULL => still in the backfill queue
  scrape_run_id     INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_mi_unique  ON menu_item(menu_id, category_id, item_id, COALESCE(serving_size_norm, ''));
CREATE INDEX        idx_mi_item    ON menu_item(item_id);
CREATE INDEX        idx_mi_menu    ON menu_item(menu_id, sort);
CREATE INDEX        idx_mi_backfill ON menu_item(label_fetched_at) WHERE label_fetched_at IS NULL;

-- ===========================================================================
-- Traits (the icons on the item grid)
-- ===========================================================================

-- Keyed on the title attribute. Icon FILENAMES are inconsistent upstream
-- (coconut_2.png, halal16.png, jain_b_16.png), so src is stored for drift
-- detection only.
CREATE TABLE trait (
  id       INTEGER PRIMARY KEY,
  slug     TEXT    NOT NULL UNIQUE,
  label    TEXT    NOT NULL UNIQUE,
  icon_src TEXT,
  is_diet  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE trait_allergen (
  trait_id    INTEGER NOT NULL REFERENCES trait(id) ON DELETE CASCADE,
  allergen_id INTEGER NOT NULL REFERENCES allergen(id) ON DELETE CASCADE,
  PRIMARY KEY (trait_id, allergen_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE menu_item_trait (
  menu_item_id INTEGER NOT NULL REFERENCES menu_item(id) ON DELETE CASCADE,
  trait_id     INTEGER NOT NULL REFERENCES trait(id) ON DELETE CASCADE,
  PRIMARY KEY (menu_item_id, trait_id)
) STRICT, WITHOUT ROWID;

-- ===========================================================================
-- User features
-- ===========================================================================

CREATE TABLE favorite (
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_favorite_item ON favorite(item_id);

-- ===========================================================================
-- Scrape audit
-- ===========================================================================

CREATE TABLE scrape_run (
  id              INTEGER PRIMARY KEY,
  kind            TEXT    NOT NULL,     -- 'full' | 'menus' | 'nutrition' | 'hours'
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  units_seen      INTEGER NOT NULL DEFAULT 0,
  menus_seen      INTEGER NOT NULL DEFAULT 0,
  menus_scraped   INTEGER NOT NULL DEFAULT 0,
  items_upserted  INTEGER NOT NULL DEFAULT 0,
  labels_fetched  INTEGER NOT NULL DEFAULT 0,
  http_requests   INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  notes           TEXT
) STRICT;
CREATE INDEX idx_run_status ON scrape_run(status, started_at);

CREATE TABLE scrape_error (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES scrape_run(id) ON DELETE CASCADE,
  phase        TEXT    NOT NULL,
  target       TEXT,
  kind         TEXT    NOT NULL,        -- 'http' | 'parse' | 'persist' | 'invariant'
  message      TEXT    NOT NULL,
  http_status  INTEGER,
  body_excerpt TEXT,
  at           INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_err_run ON scrape_error(run_id);

CREATE TABLE scrape_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  acquired_at INTEGER NOT NULL,
  pid         INTEGER NOT NULL,
  host        TEXT
) STRICT;

-- The nutrition backfill work queue.
CREATE VIEW v_pending_labels AS
SELECT mi.id            AS menu_item_id,
       mi.nn_detail_oid AS detail_oid,
       m.nn_oid         AS menu_oid,
       m.service_date   AS service_date,
       mi.item_id       AS item_id,
       COALESCE(mi.serving_size_norm, '') AS serving_size_norm
FROM menu_item mi
JOIN menu m ON m.id = mi.menu_id
WHERE mi.label_fetched_at IS NULL;
