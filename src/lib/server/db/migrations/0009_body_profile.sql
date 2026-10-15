-- Body info for the meal planner.
--
-- One row per signed-in user. Anonymous visitors keep the same fields in a
-- cookie instead (see routes/plan), so the planner works without an account --
-- this table only exists so a signed-in profile follows them between devices.
--
-- Stored metric whatever the user typed: `units` is a display preference, and
-- converting at the edges means the target maths only ever sees one system.
--
-- Weight and height are personal in a way allergens are not, so nothing else
-- reads this table: it is not joined into any browse query, and deleting the
-- account deletes it.

CREATE TABLE body_profile (
  user_id           INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  sex               TEXT    NOT NULL CHECK (sex IN ('female', 'male', 'unspecified')),
  age               INTEGER NOT NULL CHECK (age BETWEEN 14 AND 100),
  height_cm         REAL    NOT NULL CHECK (height_cm BETWEEN 120 AND 230),
  weight_kg         REAL    NOT NULL CHECK (weight_kg BETWEEN 35 AND 300),
  activity          TEXT    NOT NULL CHECK (activity IN ('sedentary', 'light', 'moderate', 'active', 'very-active')),
  goal              TEXT    NOT NULL CHECK (goal IN ('lose', 'maintain', 'gain', 'muscle')),
  meals_per_day     INTEGER NOT NULL DEFAULT 3 CHECK (meals_per_day BETWEEN 2 AND 5),
  units             TEXT    NOT NULL DEFAULT 'imperial' CHECK (units IN ('imperial', 'metric')),
  -- The user's own numbers, when they already have them. NULL = compute.
  calories_override INTEGER,
  protein_override  INTEGER,
  updated_at        INTEGER NOT NULL
) STRICT;
