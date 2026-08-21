-- Cross-contact advisories, told apart from ingredients.
--
-- THE BUG: "Assorted Dinner Rolls" is flour, water, yeast and salt, and the app
-- warned for tree nuts. Its label ends
--
--   MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.
--
-- and the ingredient matcher scanned the whole text, so an advisory about
-- shared equipment was recorded as though the prose named tree nuts as an
-- ingredient. 75 of 830 stored labels carry such a clause.
--
-- This is the OVER-warning direction, which is why it matters rather than being
-- merely untidy: a chip that fires on a dish with no nuts in it is how users
-- learn to stop reading the chips, and then the real warnings stop working too.
--
-- It must not become invisible either. "May contain" is exactly the information
-- a severe allergy needs, and whether to act on it is the user's call, not
-- ours. So it becomes its own source, rendered with its own form and its own
-- words -- "May contain Tree Nuts" -- rather than being folded into either
-- "contains" or "not declared".

ALTER TABLE nutrition_fact ADD COLUMN may_contain_text TEXT;

-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt.
-- Existing rows carry over unchanged; the ones that are wrong (an advisory
-- recorded as source='ingredient') are corrected by scripts/rematch-allergens.ts,
-- which re-derives them from the stored ingredient text without re-fetching
-- anything from upstream.
CREATE TABLE nutrition_allergen_new (
  nutrition_fact_id INTEGER NOT NULL REFERENCES nutrition_fact(id) ON DELETE CASCADE,
  allergen_id       INTEGER NOT NULL REFERENCES allergen(id) ON DELETE CASCADE,
  -- 'may-contain' is upstream's own advisory: declared, but about possibility
  -- rather than content.
  source            TEXT    NOT NULL CHECK (source IN ('contains', 'ingredient', 'name', 'may-contain')),
  confidence        TEXT    NOT NULL CHECK (confidence IN ('declared', 'likely', 'possible')),
  evidence          TEXT,
  PRIMARY KEY (nutrition_fact_id, allergen_id, source)
) STRICT, WITHOUT ROWID;

INSERT INTO nutrition_allergen_new (nutrition_fact_id, allergen_id, source, confidence, evidence)
SELECT nutrition_fact_id, allergen_id, source, confidence, evidence FROM nutrition_allergen;

DROP TABLE nutrition_allergen;
ALTER TABLE nutrition_allergen_new RENAME TO nutrition_allergen;
CREATE INDEX idx_na_allergen ON nutrition_allergen(allergen_id);
