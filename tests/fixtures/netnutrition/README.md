# NetNutrition fixtures

Real responses captured from
`https://eatsmart.housing.illinois.edu/NetNutrition/46`, **captured 2026-08-20**.

These files are the expectations for every parser test. `manifest.json` records
a digest of each one, and `assertFixturesUnchanged()` fails loudly if a file is
edited by accident — otherwise a stray reformat would quietly rewrite what the
tests assert.

Re-capture with `node scripts/capture-fixtures.ts`, then regenerate the manifest
with `node scripts/write-fixture-manifest.ts` and re-check every expectation by
hand. Do not run capture in CI.

## What each file is

| File                               | Endpoint                                             | Why it is here                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `landing.html`                     | `GET /46`                                            | 12 top-level units are embedded here, so unit discovery costs no extra request                                                                                                        |
| `select-unit-1.hall.json`          | `Unit/SelectUnitFromUnitsList` `unitOid=1`           | Ikenberry: the **hall** branch, returning `childUnitsPanel` with 9 venues and Open badges. Includes `Don's Chophouse` (apostrophe inside a single-quoted attribute)                   |
| `select-childunit-2.menulist.json` | `Unit/SelectUnitFromChildUnitsList` `unitOid=2`      | Baked Expectations' menu list. Skips Sunday 16 August, which is the case that breaks any parser assuming contiguous dates                                                             |
| `itempanel-1440348.json`           | `Menu/SelecUnitAndtMenu` `unitOid=2&menuOid=1440348` | Item grid with a category, three dishes, and multi-icon trait rows. `Blondie Bars` / detailOid `122098028` is the cross-source anchor                                                 |
| `itempanel-1440351.json`           | same, `menuOid=1440351`                              | A second date at the same venue. Contains `White Chocolate Macadamia Nut Cookie`, declared only as `Tree Nuts`                                                                        |
| `label-122098028.html`             | `NutritionDetail/ShowItemNutritionLabel`             | Raw HTML despite the JSON-looking siblings. Carries the `NA` trans-fat trap, an empty Vitamin A cell, `< 1g` fibre, six sub-recipe components, and the authoritative `Contains:` line |

| `itempanel-nocategory.json`        | `Menu/SelecUnitAndtMenu` `unitOid=18` `menuOid=1440624` | Upstream's **unnamed course**: a real group row labelled `None` with the sentinel category id **-1234**. A digits-only oid pattern read that as `null`, so the heading was skipped and both dishes under it (`Cocktail Sauce`, `Fried Popcorn Shrimp`) were silently dropped from the menu |

## Synthesized, not captured

| File                   | Provenance                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itempanel-empty.json` | Derived from `itempanel-1440348.json` by keeping the header, the table's `<thead>` and the trailing nav markup verbatim, and dropping the item rows. No zero-item menu appeared in any capture window; every byte here is still upstream's, only the date and venue strings in the header were changed. |

Re-capture it for real if a genuinely empty menu ever turns up during term --
upstream may render an explicit empty state rather than a bare table, and this
fixture asserts only that the parser survives the shape it can currently be
shown.

## Upstream quirks these fixtures encode

- A **bodyless POST returns HTTP 411**; always send at least `_=1`.
- Content-Type is misreported, so sniff by attempting `JSON.parse` and falling
  back to raw HTML.
- Upstream answers **HTTP 200 with an error page** when it is unhealthy, so
  status codes alone do not detect an outage.
- The action name `Menu/SelecUnitAndtMenu` is misspelled **upstream**. That is
  not a typo in this repo.
- Trait icon _filenames_ are inconsistent (`coconut_2.png`, `halal16.png`,
  `jain_b_16.png`). Key on the `title` attribute.
- Item rows carry `data-detailoid`; the anchor's `onclick` calls
  `getItemNutritionLabelOnClick`, not the bare function, and the markup emits
  `tabindex="0"onclick=` with no separating space.
