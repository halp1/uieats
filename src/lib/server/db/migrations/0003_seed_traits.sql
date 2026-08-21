-- Upstream's 25 trait icons, keyed on the `title` attribute.
--
-- Key on title, NOT on the icon filename: upstream's filenames are inconsistent
-- (coconut_2.png, halal16.png, jain_b_16.png, Sesame16.png, vegan24.png), so
-- icon_src is recorded for drift detection only.
--
-- The same 18 strings appear in the label's "Contains:" line, so the
-- 'contains' aliases below are the identical vocabulary.

INSERT INTO trait (slug, label, icon_src, is_diet) VALUES
  ('alcohol',             'Alcohol',             'alcohol.png',          0),
  ('coconut',             'Coconut',             'coconut_2.png',        0),
  ('corn',                'Corn',                'corn.png',             0),
  ('eggs',                'Eggs',                'eggs.png',             0),
  ('fish',                'Fish',                'fish.png',             0),
  ('gelatin',             'Gelatin',             'gelatin.png',          0),
  ('gluten',              'Gluten',              'gluten.png',           0),
  ('milk',                'Milk',                'milk.png',             0),
  ('msg',                 'MSG',                 'msg.png',              0),
  ('peanuts',             'Peanuts',             'peanuts.png',          0),
  ('pork',                'Pork',                'pork.png',             0),
  ('red-dye',             'Red Dye',             'red dye.png',          0),
  ('sesame',              'Sesame',              'Sesame16.png',         0),
  ('shellfish',           'Shellfish',           'shellfish.png',        0),
  ('soy',                 'Soy',                 'soy.png',              0),
  ('sulfites',            'Sulfites',            'sulfites.png',         0),
  ('tree-nuts',           'Tree Nuts',           'tree_nuts.png',        0),
  ('wheat',               'Wheat',               'wheat.png',            0),
  ('halal',               'Halal',               'halal16.png',          1),
  ('jain',                'Jain',                'jain_b_16.png',        1),
  ('kosher',              'Kosher',              'kosher.png',           1),
  ('local',               'Local',               'local16.png',          1),
  ('sustainable-seafood', 'Sustainable Seafood', 'Sustainable_Fish.png', 1),
  ('vegan',               'Vegan',               'vegan24.png',          1),
  ('vegetarian',          'Vegetarian',          'vegetarian24.png',     1);

-- Trait -> allergen. Note 'gluten' maps to the gluten-grains GROUP while
-- 'wheat' maps to the wheat leaf beneath it; upstream emits both independently.
INSERT INTO trait_allergen (trait_id, allergen_id)
SELECT t.id, a.id
FROM trait t
JOIN (SELECT 'alcohol' AS trait, 'alcohol' AS slug UNION ALL
      SELECT 'coconut',   'coconut'   UNION ALL
      SELECT 'corn',      'corn'      UNION ALL
      SELECT 'eggs',      'eggs'      UNION ALL
      SELECT 'fish',      'fish'      UNION ALL
      SELECT 'gelatin',   'gelatin'   UNION ALL
      SELECT 'gluten',    'gluten-grains' UNION ALL
      SELECT 'milk',      'milk'      UNION ALL
      SELECT 'msg',       'msg'       UNION ALL
      SELECT 'peanuts',   'peanuts'   UNION ALL
      SELECT 'pork',      'pork'      UNION ALL
      SELECT 'red-dye',   'red-dye'   UNION ALL
      SELECT 'sesame',    'sesame'    UNION ALL
      SELECT 'shellfish', 'shellfish' UNION ALL
      SELECT 'soy',       'soy'       UNION ALL
      SELECT 'sulfites',  'sulfites'  UNION ALL
      SELECT 'tree-nuts', 'tree-nuts' UNION ALL
      SELECT 'wheat',     'wheat'     UNION ALL
      SELECT 'halal',     'halal'     UNION ALL
      SELECT 'jain',      'jain'      UNION ALL
      SELECT 'kosher',    'kosher'    UNION ALL
      SELECT 'local',     'local'     UNION ALL
      SELECT 'sustainable-seafood', 'sustainable-seafood' UNION ALL
      SELECT 'vegan',      'vegan'      UNION ALL
      SELECT 'vegetarian', 'vegetarian') m ON m.trait = t.slug
JOIN allergen a ON a.slug = m.slug;

-- 'trait' and 'contains' aliases share one vocabulary, so seed both from the
-- trait table rather than repeating the strings.
INSERT INTO allergen_alias (allergen_id, alias, match_kind, requires_word_boundary, negative_prefixes)
SELECT ta.allergen_id, LOWER(t.label), 'trait', 1, NULL
FROM trait t JOIN trait_allergen ta ON ta.trait_id = t.id;

INSERT INTO allergen_alias (allergen_id, alias, match_kind, requires_word_boundary, negative_prefixes)
SELECT ta.allergen_id, LOWER(t.label), 'contains', 1, NULL
FROM trait t JOIN trait_allergen ta ON ta.trait_id = t.id
WHERE t.is_diet = 0;
