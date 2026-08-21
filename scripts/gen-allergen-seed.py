# Generates 0002_seed_allergens.sql. Kept as a generator because hand-writing
# ~200 INSERTs is where typos live; the emitted SQL is the artifact that ships.
import io

out = io.StringIO()
W = out.write

W("""-- Allergen taxonomy seed.
--
-- DESIGN NOTE -- why ingredient-text matching is deliberately narrow:
--
-- Upstream's "Contains:" line is authoritative for the 18 allergens in its own
-- vocabulary (verified: the item-grid trait icons and the label's Contains:
-- list agree exactly, 28/28 across 10 venues). Re-deriving milk/eggs/soy from
-- ingredient prose would add false positives and no information.
--
-- So ingredient matching runs ONLY where upstream gives us nothing:
--   1. resolving a group to a species  (Contains: "Tree Nuts" -> MACADAMIA NUTS)
--   2. allergens outside upstream's vocabulary (mustard, celery, lupin)
--
-- That is also why `covered_by_trait_vocabulary` exists: for those 18, the
-- absence of a trait icon is weak evidence of absence. For everything else it
-- is no evidence at all, and verdict.ts must return `unknown`.

""")

# (slug, label, parent, kind, covered, aliases_ingredient, aliases_name)
# aliases: list of (alias, negative_prefixes|None)
A = []
def add(slug, label, parent=None, kind='leaf', covered=0, ing=(), nm=()):
    A.append(dict(slug=slug, label=label, parent=parent, kind=kind,
                  covered=covered, ing=list(ing), nm=list(nm)))

# --- covered by upstream's trait/Contains vocabulary (18) -------------------
add('milk',      'Milk',     kind='leaf',  covered=1)
add('eggs',      'Eggs',     kind='leaf',  covered=1)
add('peanuts',   'Peanuts',  kind='leaf',  covered=1, nm=[('peanut',None)])
add('soy',       'Soy',      kind='leaf',  covered=1)
add('sesame',    'Sesame',   kind='leaf',  covered=1, nm=[('sesame',None),('tahini',None)])
add('corn',      'Corn',     kind='leaf',  covered=1)
add('coconut',   'Coconut',  kind='leaf',  covered=1, nm=[('coconut',None)])
add('sulfites',  'Sulfites', kind='leaf',  covered=1)
add('msg',       'MSG',      kind='leaf',  covered=1)
add('gelatin',   'Gelatin',  kind='leaf',  covered=1)
add('alcohol',   'Alcohol',  kind='leaf',  covered=1)
add('red-dye',   'Red Dye',  kind='leaf',  covered=1)
add('pork',      'Pork',     kind='leaf',  covered=1, nm=[('pork',None),('bacon',None),('ham',None)])

# Tree nuts: group + species. NEVER alias bare "nut" -- that is what makes
# nutmeg, nutritional yeast and butternut squash read as tree nuts.
add('tree-nuts', 'Tree Nuts', kind='group', covered=1, ing=[
    ('tree nut',None),('tree nuts',None),('mixed nuts',None),('nut butter',None),
    ('praline',None),('nougat',None),('nut topping',None)])
for s,l,ing,neg in [
    ('almond','Almond',['almond','almonds','marzipan','frangipane'],None),
    ('walnut','Walnut',['walnut','walnuts'],None),
    ('pecan','Pecan',['pecan','pecans'],None),
    ('cashew','Cashew',['cashew','cashews'],None),
    ('pistachio','Pistachio',['pistachio','pistachios'],None),
    ('hazelnut','Hazelnut',['hazelnut','hazelnuts','filbert','filberts','gianduja'],None),
    ('macadamia','Macadamia',['macadamia','macadamias'],None),
    ('brazil-nut','Brazil Nut',['brazil nut','brazil nuts'],None),
    ('pine-nut','Pine Nut',['pine nut','pine nuts','pignoli'],None),
    # "water chestnut" is an aquatic vegetable, not a tree nut.
    ('chestnut','Chestnut',['chestnut','chestnuts'],'water'),
]:
    add(s,l,parent='tree-nuts',kind='leaf',covered=0,
        ing=[(a,neg) for a in ing], nm=[(ing[0],neg)])

add('fish','Fish', kind='group', covered=1)
for s,l,ing in [
    ('salmon','Salmon',['salmon']), ('tuna','Tuna',['tuna']),
    ('cod','Cod',['cod','codfish']), ('tilapia','Tilapia',['tilapia']),
    ('pollock','Pollock',['pollock','pollack']),
    # Hidden in Worcestershire and Caesar dressing -- the reason this row exists.
    ('anchovy','Anchovy',['anchovy','anchovies','worcestershire']),
]:
    add(s,l,parent='fish',kind='leaf',ing=[(a,None) for a in ing], nm=[(ing[0],None)])

add('shellfish','Shellfish', kind='group', covered=1)
add('crustacean','Crustacean', parent='shellfish', kind='group')
for s,l,ing in [('shrimp','Shrimp',['shrimp','prawn','prawns']),('crab','Crab',['crab','crabmeat']),
                ('lobster','Lobster',['lobster']),('crawfish','Crawfish',['crawfish','crayfish'])]:
    add(s,l,parent='crustacean',kind='leaf',ing=[(a,None) for a in ing], nm=[(ing[0],None)])
add('mollusk','Mollusk', parent='shellfish', kind='group')
for s,l,ing in [('clam','Clam',['clam','clams']),('mussel','Mussel',['mussel','mussels']),
                ('oyster','Oyster',['oyster','oysters']),('scallop','Scallop',['scallop','scallops']),
                ('squid','Squid',['squid','calamari']),('octopus','Octopus',['octopus'])]:
    add(s,l,parent='mollusk',kind='leaf',ing=[(a,None) for a in ing], nm=[(ing[0],None)])

# Upstream emits BOTH a Gluten and a Wheat trait, so wheat is a member of the
# group AND individually selectable.
add('gluten-grains','Gluten Grains', kind='group', covered=1)
add('wheat','Wheat', parent='gluten-grains', kind='leaf', covered=1)
for s,l,ing in [('barley','Barley',['barley','malted barley']),('rye','Rye',['rye','rye flour']),
                ('malt','Malt',['malt','malt extract','maltodextrin']),('spelt','Spelt',['spelt']),
                ('triticale','Triticale',['triticale']),('semolina','Semolina',['semolina','durum']),
                ('farro','Farro',['farro','bulgur','couscous','seitan'])]:
    add(s,l,parent='gluten-grains',kind='leaf',ing=[(a,None) for a in ing])

# --- outside upstream's vocabulary: ingredient text is the ONLY signal ------
add('mustard','Mustard', kind='leaf', covered=0,
    ing=[('mustard',None),('mustard seed',None),('dijon',None)], nm=[('mustard',None)])
add('celery','Celery', kind='leaf', covered=0,
    ing=[('celery',None),('celery seed',None),('celeriac',None)], nm=[('celery',None)])
add('lupin','Lupin', kind='leaf', covered=0,
    ing=[('lupin',None),('lupine',None),('lupini',None)])

# --- diets: positive tags, never an avoidance warning ----------------------
for s,l in [('vegan','Vegan'),('vegetarian','Vegetarian'),('halal','Halal'),
            ('kosher','Kosher'),('jain','Jain'),('local','Local'),
            ('sustainable-seafood','Sustainable Seafood')]:
    add(s,l,kind='diet',covered=0)

def q(v):
    if v is None: return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"

ids = {a['slug']: i+1 for i, a in enumerate(A)}

W("INSERT INTO allergen (id, slug, label, parent_id, kind, covered_by_trait_vocabulary, sort) VALUES\n")
rows = []
for i, a in enumerate(A):
    pid = ids[a['parent']] if a['parent'] else 'NULL'
    rows.append(f"  ({ids[a['slug']]}, {q(a['slug'])}, {q(a['label'])}, {pid}, {q(a['kind'])}, {a['covered']}, {i+1})")
W(",\n".join(rows) + ";\n\n")

# Aliases. 'contains'/'trait' aliases are seeded in 0003 alongside the trait
# table; here we only seed the free-text matchers.
alias_rows = []
for a in A:
    for alias, neg in a['ing']:
        alias_rows.append(f"  ({ids[a['slug']]}, {q(alias)}, 'ingredient', 1, {q(neg)})")
    for alias, neg in a['nm']:
        alias_rows.append(f"  ({ids[a['slug']]}, {q(alias)}, 'name', 1, {q(neg)})")

W("INSERT INTO allergen_alias (allergen_id, alias, match_kind, requires_word_boundary, negative_prefixes) VALUES\n")
W(",\n".join(alias_rows) + ";\n")

open('src/lib/server/db/migrations/0002_seed_allergens.sql','w').write(out.getvalue())
print(f"allergens={len(A)} aliases={len(alias_rows)}")
