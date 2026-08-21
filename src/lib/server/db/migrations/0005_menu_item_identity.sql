-- menu_item identity: the instance, not the dish name.
--
-- THE BUG THIS FIXES, measured against live data:
--
-- One menu can list the same dish name twice, in the same course, with the same
-- serving size, as two genuinely different products -- different suppliers,
-- different recipes, DIFFERENT ALLERGENS. Upstream distinguishes them by
-- detailOid and by nothing else:
--
--   Wheat Berry Bread  Slice  oid 122232301  [Gluten, Soy, Wheat]
--   Wheat Berry Bread  Slice  oid 122227896  [Corn, Gluten, Soy, Wheat]
--   Ketchup       Tablespoon  oid 122224598  [Corn, Local]
--   Ketchup       Tablespoon  oid 122235987  [Kosher]
--
-- The old key -- (menu_id, category_id, item_id, serving_size_norm) -- collapsed
-- each pair into one row via ON CONFLICT DO UPDATE, so whichever appeared LAST
-- in the markup silently overwrote the other. Every collision observed in an
-- 82-menu audit lost a real allergen difference, and the direction is arbitrary:
-- the surviving Ketchup row is the one that does NOT declare corn. Someone
-- avoiding corn was shown "no Corn declared" for a serving line that has a
-- corn-containing ketchup on it. That is an under-warning, which is the failure
-- this whole codebase is built to avoid.
--
-- detailOid is the right identity for an instance. It is stable across sessions
-- (verified) and unique per (menu, item) -- 1,237 items across 82 menus produced
-- zero duplicates within a menu. It is still never a DISH identity; `item`
-- remains the canonical dish registry, and two instances of one dish simply
-- point at the same item_id.

-- Defensive, in case an earlier scrape already collapsed rows in a way that
-- would violate the new index: keep the newest row per (menu, oid). On a
-- database written by the fixed code this deletes nothing.
DELETE FROM menu_item
WHERE id NOT IN (
  SELECT MAX(id) FROM menu_item GROUP BY menu_id, nn_detail_oid
);

DROP INDEX idx_mi_unique;
CREATE UNIQUE INDEX idx_mi_unique ON menu_item(menu_id, nn_detail_oid);
