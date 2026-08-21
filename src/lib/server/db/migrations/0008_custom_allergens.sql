-- Allergens the seeded taxonomy does not have.
--
-- The 63 seeded allergens cover what upstream declares plus the common
-- omissions (mustard, celery, lupin, individual nut species). They cannot cover
-- everything a person actually reacts to -- kiwi, nightshades, buckwheat, a
-- specific additive -- and "your allergy is not on our list" is a bad answer
-- from an app whose entire purpose is telling you what you can eat.
--
-- WHY A SEPARATE TABLE, rather than rows in `allergen`:
--
-- `allergen` is a shared taxonomy with a globally unique slug, joined to
-- traits, aliases and the recursive closure. Putting user rows in it would
-- leak one person's private list into another's picker, and a user-chosen name
-- could collide with a seeded slug. Keeping them apart also keeps a hard
-- guarantee: a custom allergen can never acquire `covered_by_trait_vocabulary`,
-- so it can never soften to "no X declared" on the strength of a missing trait
-- icon. Upstream has no vocabulary for it, so the only evidence that can ever
-- exist is the ingredient text -- and with no label read, the answer is
-- `unknown`. That falls straight out of the existing model.

CREATE TABLE user_custom_allergen (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- What the user typed, shown on their chips exactly as written.
  label      TEXT    NOT NULL,
  -- Pipe-separated lowercase search terms, matching the convention in
  -- allergen_alias.negative_prefixes. Seeded from the label, then editable:
  -- "nightshade" finds nothing, "tomato|potato|aubergine|paprika" finds it.
  terms      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- One entry per name per person, case-insensitively: re-adding "Kiwi" should
-- edit the existing one rather than quietly creating a second.
CREATE UNIQUE INDEX idx_custom_allergen_unique
  ON user_custom_allergen(user_id, label COLLATE NOCASE);
CREATE INDEX idx_custom_allergen_user ON user_custom_allergen(user_id);
