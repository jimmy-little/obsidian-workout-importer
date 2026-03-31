# Pulse Plugin — FoodNoms Importer Spec

## Overview

Add a nutrition import feature to the Pulse Obsidian plugin that watches a vault folder for `.foodnoms` files, parses them, and creates structured nutrition notes with rich frontmatter for Dataview/Bases querying.

This follows the same import pattern as the existing AutoExport CSV workout importer.

---

## Background & Context

`.foodnoms` files are exported from the FoodNoms iOS app via the share sheet → Files. The format is **LZFSE-compressed JSON** (Apple's compression algorithm). Once decompressed, the data is a clean JSON object containing a meal name, collection metadata, and an array of food entries with full nutrient detail.

**Desktop-only limitation:** The `lzfse` npm package requires a compiled native binary. This importer will only function on macOS desktop. iOS/mobile Obsidian does not support native npm binaries. This is acceptable — the phone is a capture device; all processing happens on desktop.

**Workflow:**
1. User logs a meal in FoodNoms on iPhone
2. Taps Share → Save to Files → drops into `_inbox/foodnoms/` in iCloud-synced vault
3. On desktop, Pulse detects the new file, parses it, creates a nutrition note
4. `.foodnoms` file is archived after successful import

---

## Dependencies

```
lzfse  (npm)  — LZFSE decompression
```

No other new dependencies required. Uses existing Obsidian plugin APIs for file watching, vault write, and frontmatter handling.

---

## Folder Structure

```
_inbox/
  foodnoms/          ← drop .foodnoms files here
_archive/
  foodnoms/          ← processed files moved here
Nutrition/           ← generated notes land here (configurable)
```

All folder paths should be configurable in Pulse plugin settings.

---

## File Parsing

### Decompression

```typescript
import lzfse from 'lzfse';
import { readFile } from 'fs/promises';

async function parseFoodnomsFile(filePath: string): Promise<FoodnomsData> {
  const raw = await readFile(filePath);
  const decompressed = lzfse.decompress(raw);
  return JSON.parse(decompressed.toString('utf8'));
}
```

### Source JSON Shape

```typescript
interface FoodnomsData {
  version: number;
  contentType: number;
  foodCollections: FoodCollection[];
  foodEntries: FoodEntry[];
}

interface FoodCollection {
  name: string;          // "Dinner", "Breakfast", etc.
  collectionType: number;
  version: number;
  traits: number;
}

interface FoodEntry {
  name: string;
  foodID: string;        // e.g. "foodnoms:usda:2705954" or "local:UUID"
  source: string;        // "usda", "fn", "local"
  quantity: number;
  measure: {
    value: number;
    unit: string;        // "ounce", "gram", "tablespoon", "serving", "cup"
    traits: number;
  };
  baseAmount: number;
  baseUnit: string;
  nutrients: NutrientMap;
  brandOwner?: string;
  barcode?: string;
  collectionSortIndex: number;
}

interface NutrientMap {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fatSaturated?: number;
  fatMonounsaturated?: number;
  fatPolyunsaturated?: number;
  fatTrans?: number;
  fiber?: number;
  sugars?: number;
  sugarsAdded?: number;
  sodium?: number;
  cholesterol?: number;
  potassium?: number;
  calcium?: number;
  iron?: number;
  // ...additional micronutrients present in USDA-sourced entries
}
```

### Nutrient Scaling

Nutrients in the JSON are per `baseAmount` (usually per 100g). Scale to actual consumed amount:

```typescript
function scaleNutrients(entry: FoodEntry): NutrientMap {
  // Actual grams consumed = quantity × measure.value (when unit is weight-based)
  // For serving-based units, baseAmount IS the serving size
  const ratio = (entry.quantity * entry.measure.value) / entry.baseAmount;
  
  return Object.fromEntries(
    Object.entries(entry.nutrients).map(([k, v]) => [k, Math.round(v * ratio * 10) / 10])
  );
}
```

**Note:** Verify scaling logic against the Dinner sample file (762 cal total, 6oz chicken breast). The existing parsed data can be used as a ground-truth test case.

---

## Output Note Schema

### Filename

```
YYYY-MM-DD Dinner.md
YYYY-MM-DD Breakfast.md
```

If a note for that date+meal already exists, prompt the user (same merge/skip/overwrite pattern as workout importer).

### Frontmatter

```yaml
---
date: 2026-03-31
meal: Dinner
type: nutrition

# Meal totals (sum of all entries, scaled)
calories: 762
protein: 105
carbs: 44
fat: 18
fiber: 6
sodium: 908
sugar: 6

# Per-item detail (for granular querying)
items:
  - name: Chicken Breast (Skinless)
    food_id: foodnoms:usda:2705954
    quantity: 6
    unit: oz
    calories: 490
    protein: 96
    carbs: 0
    fat: 13
  - name: Italian Vegetable Blend
    food_id: local:83F8D65D-E9B8-4B0D-BCB2-15204C26EFD3
    quantity: 150
    unit: g
    calories: 54
    protein: 2
    carbs: 11
    fat: 0
  # ...etc

# Flat name list for simple contains() queries
item_names:
  - Chicken Breast (Skinless)
  - Italian Vegetable Blend
  - Lightly Seasoned Quinoa & Garden Vegetable
  - Olive Oil
  - Organic Greek Yogurt Plain Nonfat
  - Whey Protein Creamy Chocolate

imported_from: Dinner.foodnoms
imported_at: 2026-03-31T21:15:00
source: foodnoms
---
```

### Note Body

Keep minimal — the data is in frontmatter. Just a simple summary table for human readability:

```markdown
## Dinner — March 31, 2026

| Food | Qty | Cal | P | C | F |
|------|-----|-----|---|---|---|
| Chicken Breast (Skinless) | 6 oz | 490 | 96g | 0g | 13g |
| Italian Vegetable Blend | 150g | 54 | 2g | 11g | 0g |
| ... | | | | | |
| **Total** | | **762** | **105g** | **44g** | **18g** |
```

---

## Import Flow

1. **File watcher** monitors `_inbox/foodnoms/` for new `.foodnoms` files
2. On new file detected:
   a. Attempt decompression + parse
   b. If parse fails, show error notice, leave file in inbox
3. **Determine target note path** from date + meal name
4. **Check for existing note:**
   - If none exists → create new note
   - If exists → prompt: Merge / Skip / Overwrite (same as workout importer)
5. **Write note** to configured nutrition folder
6. **Archive** source `.foodnoms` file to `_archive/foodnoms/YYYY-MM/`
7. Show success notice: "Imported Dinner (762 cal, 105g protein)"

---

## Settings (Pulse Plugin Settings Tab)

```
FoodNoms Import
  ☑ Enable FoodNoms import
  Inbox folder:     [_inbox/foodnoms        ]
  Archive folder:   [_archive/foodnoms      ]
  Output folder:    [Nutrition              ]
  On duplicate:     [Ask / Merge / Skip / Overwrite] (dropdown)
  Include micronutrients in frontmatter: [ ] (off by default — adds ~20 extra fields)
```

---

## Micronutrients (Optional)

When enabled, add extended fields to frontmatter for USDA-sourced items (not all entries will have these):

```yaml
# Extended (optional, USDA entries only)
cholesterol: 96
potassium: 1161
calcium: 357
iron: 3
vitamin_a: 5
vitamin_c: 0
vitamin_d: 0
vitamin_b12: 0.27
zinc: 0.87
selenium: 23.1
```

Meal-level totals only (don't repeat per-item for micronutrients — too verbose).

---

## Test Cases

Use the provided `Dinner.foodnoms` sample as the primary test fixture.

Expected output for Dinner sample:
- 6 food entries
- Meal totals: 762 cal / 105g protein / 44g carbs / 18g fat
- `item_names` array with 6 entries
- Archived file at `_archive/foodnoms/2026-03/Dinner.foodnoms`

---

## Out of Scope (for now)

- iOS/mobile support
- FoodNoms CSV backfill importer (separate feature, separate spec)
- Editing/updating existing nutrition notes from re-imported files (merge logic TBD)
- Daily nutrition rollup notes (could be a Dataview query, not a plugin concern)