/**
 * FoodNoms `.foodnoms` import: LZFSE-style wrapper (often uncompressed `bvx-` + JSON) and nutrition math.
 */

const TEXT_DECODER = new TextDecoder();

export interface FoodnomsData {
	version?: number;
	contentType?: number;
	foodCollections?: FoodCollection[];
	foodEntries?: FoodEntry[];
	/** Some exports may include an explicit date */
	date?: string;
	loggedAt?: string;
	createdAt?: string;
	[key: string]: unknown;
}

export interface FoodCollection {
	name: string;
	collectionType?: number;
	version?: number;
	traits?: number;
}

export interface FoodEntry {
	name: string;
	foodID: string;
	source: string;
	quantity: number;
	measure: {
		value: number;
		unit: string;
		traits?: number;
	};
	baseAmount: number;
	baseUnit: string;
	nutrients: Record<string, number>;
	brandOwner?: string;
	barcode?: string;
	collectionSortIndex: number;
}

export interface ScaledItemRow {
	name: string;
	food_id: string;
	quantity: number;
	unit: string;
	calories: number;
	protein: number;
	carbs: number;
	fat: number;
	fiber?: number;
	sodium?: number;
	sugars?: number;
}

const CORE_MACRO_KEYS = new Set([
	"calories",
	"protein",
	"carbs",
	"fat",
	"fiber",
	"sodium",
	"sugars",
	"sugar",
]);

function findBvxEndMarker(bytes: Uint8Array): number {
	for (let i = bytes.length - 4; i >= 8; i--) {
		if (bytes[i] === 0x62 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x78 && bytes[i + 3] === 0x24) {
			return i;
		}
	}
	return -1;
}

/** Extract JSON text from `bvx-` uncompressed LZFSE block or return null. */
export function extractLzfseUncompressedJsonText(bytes: Uint8Array): string | null {
	if (bytes.length < 12) return null;
	const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
	if (magic !== "bvx-") return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const uncompressedSize = view.getUint32(4, true);
	const jsonStart = 8;
	const jsonEnd = jsonStart + uncompressedSize;
	if (jsonEnd <= bytes.length) {
		return TEXT_DECODER.decode(bytes.subarray(jsonStart, jsonEnd));
	}
	const endMarker = findBvxEndMarker(bytes);
	if (endMarker === -1) return null;
	return TEXT_DECODER.decode(bytes.subarray(jsonStart, endMarker));
}

/** Try Node `lzfse` native module (desktop only); return UTF-8 JSON text or null. */
export function tryDecompressLzfseNode(bytes: Uint8Array): string | null {
	try {
		// Optional dependency; mark external in esbuild. Unavailable on mobile / without native build.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const lzfse = require("lzfse") as { decompress: (b: Buffer) => Buffer };
		const B = globalThis.Buffer as typeof import("buffer").Buffer | undefined;
		if (!B) return null;
		const out = lzfse.decompress(B.from(bytes));
		return out.toString("utf8");
	} catch {
		return null;
	}
}

export function parseFoodnomsJsonText(jsonText: string): FoodnomsData | null {
	try {
		const data = JSON.parse(jsonText) as FoodnomsData;
		if (!Array.isArray(data.foodEntries) || data.foodEntries.length === 0) return null;
		return data;
	} catch {
		return null;
	}
}

export function parseFoodnomsFromBytes(bytes: Uint8Array): FoodnomsData | null {
	const wrapped = extractLzfseUncompressedJsonText(bytes);
	if (wrapped) {
		const d = parseFoodnomsJsonText(wrapped);
		if (d) return d;
	}
	const nodeJson = tryDecompressLzfseNode(bytes);
	if (nodeJson) {
		const d = parseFoodnomsJsonText(nodeJson);
		if (d) return d;
	}
	try {
		const t = TEXT_DECODER.decode(bytes);
		return parseFoodnomsJsonText(t);
	} catch {
		return null;
	}
}

export function scaleNutrients(entry: FoodEntry): Record<string, number> {
	const denom = entry.baseAmount;
	if (!Number.isFinite(denom) || denom === 0) return { ...entry.nutrients };
	const ratio = (Number(entry.quantity) * Number(entry.measure?.value ?? 1)) / denom;
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(entry.nutrients)) {
		if (typeof v !== "number" || !Number.isFinite(v)) continue;
		out[k] = Math.round(v * ratio * 10) / 10;
	}
	return out;
}

function sumNutrientObjects(rows: Record<string, number>[]): Record<string, number> {
	const acc: Record<string, number> = {};
	for (const row of rows) {
		for (const [k, v] of Object.entries(row)) {
			if (typeof v !== "number" || !Number.isFinite(v)) continue;
			acc[k] = (acc[k] ?? 0) + v;
		}
	}
	for (const k of Object.keys(acc)) {
		acc[k] = Math.round(acc[k]! * 10) / 10;
	}
	return acc;
}

export function mealNameFromData(data: FoodnomsData): string {
	const c = data.foodCollections?.[0];
	if (c?.name?.trim()) return c.name.trim();
	return "Meal";
}

export function resolveMealDate(data: FoodnomsData, fileMtimeMs: number): string {
	const tryParse = (s: unknown): string | null => {
		if (typeof s !== "string" || !s.trim()) return null;
		const t = s.trim().slice(0, 10);
		if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
		const d = new Date(s);
		if (!isNaN(d.getTime())) {
			const y = d.getFullYear();
			const m = (d.getMonth() + 1).toString().padStart(2, "0");
			const day = d.getDate().toString().padStart(2, "0");
			return `${y}-${m}-${day}`;
		}
		return null;
	};
	return (
		tryParse(data.date) ??
		tryParse(data.loggedAt) ??
		tryParse(data.createdAt) ??
		(() => {
			const d = new Date(fileMtimeMs);
			const y = d.getFullYear();
			const m = (d.getMonth() + 1).toString().padStart(2, "0");
			const day = d.getDate().toString().padStart(2, "0");
			return `${y}-${m}-${day}`;
		})()
	);
}

export function buildScaledItems(data: FoodnomsData): { items: ScaledItemRow[]; totals: Record<string, number> } {
	const entries = [...(data.foodEntries ?? [])].sort(
		(a, b) => (a.collectionSortIndex ?? 0) - (b.collectionSortIndex ?? 0)
	);
	const scaledList: Record<string, number>[] = [];
	const items: ScaledItemRow[] = [];
	for (const e of entries) {
		const n = scaleNutrients(e);
		scaledList.push(n);
		const unit = (e.measure?.unit ?? "").toLowerCase();
		const qty = Number(e.quantity);
		const mv = Number(e.measure?.value ?? 1);
		let displayQty = qty;
		let displayUnit = unit;
		if (unit === "gram" || unit === "g") {
			displayQty = qty * mv;
			displayUnit = "g";
		} else if (unit === "ounce" || unit === "oz") {
			displayQty = qty * mv;
			displayUnit = "oz";
		} else {
			displayQty = qty * mv;
			displayUnit = unit || "serving";
		}
		items.push({
			name: e.name,
			food_id: e.foodID,
			quantity: Math.round(displayQty * 100) / 100,
			unit: displayUnit,
			calories: n.calories ?? 0,
			protein: n.protein ?? 0,
			carbs: n.carbs ?? 0,
			fat: n.fat ?? 0,
			fiber: n.fiber,
			sodium: n.sodium,
			sugars: n.sugars ?? n.sugar,
		});
	}
	const totals = sumNutrientObjects(scaledList);
	return { items, totals };
}

function yamlEscape(s: string): string {
	if (/[:#\n"|']/.test(s) || s.includes("\\")) return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	return s;
}

export function formatItemsYamlBlock(items: ScaledItemRow[]): string {
	const lines: string[] = ["items:"];
	for (const it of items) {
		lines.push(`  - name: ${yamlEscape(it.name)}`);
		lines.push(`    food_id: ${yamlEscape(it.food_id)}`);
		lines.push(`    quantity: ${it.quantity}`);
		lines.push(`    unit: ${yamlEscape(it.unit)}`);
		lines.push(`    calories: ${it.calories}`);
		lines.push(`    protein: ${it.protein}`);
		lines.push(`    carbs: ${it.carbs}`);
		lines.push(`    fat: ${it.fat}`);
	}
	return lines.join("\n") + "\n";
}

export function formatItemNamesYaml(names: string[]): string {
	const lines = ["item_names:"];
	for (const n of names) {
		lines.push(`  - ${yamlEscape(n)}`);
	}
	return lines.join("\n") + "\n";
}

/** Meal-level micronutrient keys (totals only), excluding core macros. */
export function micronutrientTotals(
	totals: Record<string, number>,
	include: boolean
): Record<string, number> {
	if (!include) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(totals)) {
		if (CORE_MACRO_KEYS.has(k)) continue;
		if (typeof v === "number" && Number.isFinite(v) && v !== 0) {
			out[k] = Math.round(v * 100) / 100;
		}
	}
	return out;
}

export function formatNutritionTableBody(meal: string, dateIso: string, items: ScaledItemRow[], totals: Record<string, number>): string {
	const prettyDate = new Date(dateIso + "T12:00:00").toLocaleDateString(undefined, {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	const header = `## ${meal} — ${prettyDate}\n\n`;
	const rows: string[] = [
		"| Food | Qty | Cal | P | C | F |",
		"|------|-----|-----|---|---|---|",
	];
	for (const it of items) {
		const qtyStr = `${it.quantity} ${it.unit}`.trim();
		rows.push(
			`| ${it.name.replace(/\|/g, "\\|")} | ${qtyStr.replace(/\|/g, "\\|")} | ${it.calories} | ${it.protein}g | ${it.carbs}g | ${it.fat}g |`
		);
	}
	const cal = Math.round(totals.calories ?? 0);
	const p = Math.round(totals.protein ?? 0);
	const c = Math.round(totals.carbs ?? 0);
	const f = Math.round(totals.fat ?? 0);
	rows.push(`| **Total** | | **${cal}** | **${p}g** | **${c}g** | **${f}g** |`);
	return header + rows.join("\n") + "\n";
}

export function sanitizeNoteFileComponent(name: string): string {
	return name.replace(/[<>:"/\\|?*]/g, "-").trim() || "Meal";
}

/** Sum macros from item rows (used after merge). */
export function totalsFromScaledItems(items: ScaledItemRow[]): Record<string, number> {
	const acc: Record<string, number> = {
		calories: 0,
		protein: 0,
		carbs: 0,
		fat: 0,
		fiber: 0,
		sodium: 0,
		sugars: 0,
	};
	for (const it of items) {
		acc.calories += it.calories;
		acc.protein += it.protein;
		acc.carbs += it.carbs;
		acc.fat += it.fat;
		if (it.fiber != null) acc.fiber += it.fiber;
		if (it.sodium != null) acc.sodium += it.sodium;
		if (it.sugars != null) acc.sugars += it.sugars;
	}
	for (const k of Object.keys(acc)) {
		acc[k] = Math.round(acc[k]! * 10) / 10;
	}
	return acc;
}

/**
 * Parse `items` / `item_names` blocks produced by this plugin (for merge).
 */
export function parseStoredNutritionFrontmatter(fmText: string): {
	items: ScaledItemRow[];
	names: string[];
} {
	const items: ScaledItemRow[] = [];
	const names: string[] = [];
	const itemsMatch = fmText.match(/^items:\n([\s\S]*?)(?=^[a-z_]+:)/m);
	if (itemsMatch) {
		const block = itemsMatch[1].trimEnd();
		const segments = ("\n" + block).split(/\n  - name:\s*/);
		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i];
			const nl = seg.indexOf("\n");
			const nameRaw = (nl === -1 ? seg : seg.slice(0, nl)).trim();
			const rest = nl === -1 ? "" : seg.slice(nl);
			const row: Partial<ScaledItemRow> = { name: yamlUnquote(nameRaw) };
			for (const line of rest.split("\n")) {
				const m = line.match(/^\s+([a-z_]+):\s*(.+)$/);
				if (!m) continue;
				const key = m[1];
				let val = m[2].trim();
				val = yamlUnquote(val);
				if (key === "food_id") row.food_id = val;
				else if (key === "unit") row.unit = val;
				else if (key === "quantity") row.quantity = parseFloat(val);
				else if (key === "calories") row.calories = parseFloat(val);
				else if (key === "protein") row.protein = parseFloat(val);
				else if (key === "carbs") row.carbs = parseFloat(val);
				else if (key === "fat") row.fat = parseFloat(val);
			}
			if (row.name && row.food_id != null && row.quantity != null && row.unit != null) {
				items.push(row as ScaledItemRow);
			}
		}
	}
	const namesMatch = fmText.match(/^item_names:\n([\s\S]*?)(?=^[a-z_]+:)/m);
	if (namesMatch) {
		for (const line of namesMatch[1].split("\n")) {
			const m = line.match(/^\s*-\s+(.+)$/);
			if (!m) continue;
			names.push(yamlUnquote(m[1].trim()));
		}
	}
	return { items, names };
}

function yamlUnquote(val: string): string {
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		return val.slice(1, -1).replace(/\\"/g, '"');
	}
	return val;
}
