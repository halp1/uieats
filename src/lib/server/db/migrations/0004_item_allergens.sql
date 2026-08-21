-- Item-name allergen inference, and umbrella ingredient terms.
--
-- WHY A SEPARATE TABLE FROM nutrition_allergen:
--
-- nutrition_allergen hangs off nutrition_fact, which only exists once a label
-- has been fetched. But a name-derived guess ("Peanut Sauce" -> peanuts) is
-- available from the menu scrape alone, and it is at its MOST useful precisely
-- while the label is still missing -- that is the window where a user has
-- nothing else to go on. Keying it to the canonical item instead means every
-- instance of the dish inherits it immediately, on every menu, for free.
--
-- It stays the weakest signal in the model: verdict.ts renders it as
-- `flagged-possible`, and per the design it may only ever ADD a warning, never
-- clear one.

CREATE TABLE item_allergen (
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  allergen_id INTEGER NOT NULL REFERENCES allergen(id) ON DELETE CASCADE,
  confidence  TEXT    NOT NULL CHECK (confidence IN ('possible')),
  evidence    TEXT,
  PRIMARY KEY (item_id, allergen_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_ia_allergen ON item_allergen(allergen_id);

-- Distinguishes "checked the name, found nothing" from "never checked".
--
-- Without this the name pass could only ever run on a freshly-inserted item, so
-- deploying it over an existing database would leave every dish already in the
-- registry permanently unmatched -- and an empty item_allergen would be
-- indistinguishable from a clean result. Nulling this column is also how a
-- change to the `name` aliases gets re-applied to the back catalogue.
ALTER TABLE item ADD COLUMN name_checked_at INTEGER;
CREATE INDEX idx_item_unchecked ON item(id) WHERE name_checked_at IS NULL;

-- Pipe-separated umbrella terms found in the ingredient list ("SPICES",
-- "NATURAL FLAVOR", "MODIFIED FOOD STARCH"). These are not allergen hits --
-- flagging them as such would warn on nearly every dish and teach users to
-- ignore warnings. What they do is weaken the meaning of "not found": the
-- ingredient list declined to say. verdict.ts surfaces that as an advisory
-- attached to an otherwise-unflagged verdict.
ALTER TABLE nutrition_fact ADD COLUMN hidden_sources TEXT;
