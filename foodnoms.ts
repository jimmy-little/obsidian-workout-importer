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
	/** Clock time from export when present (e.g. "14:30") */
	time?: string;
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

const LZFSE_CLI_CANDIDATES = ["lzfse", "/opt/homebrew/bin/lzfse", "/usr/local/bin/lzfse"];

/**
 * Decompress full-file LZFSE using Apple's `lzfse` CLI (e.g. `brew install lzfse`).
 * Works in Obsidian desktop where Node `fs` / `child_process` are available.
 */
export function tryDecompressLzfseCli(bytes: Uint8Array): string | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { execFileSync } = require("child_process") as typeof import("child_process");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs") as typeof import("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path") as typeof import("path");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const os = require("os") as typeof import("os");
		const B = globalThis.Buffer as typeof import("buffer").Buffer | undefined;
		if (!B) return null;
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const inPath = path.join(os.tmpdir(), `foodnoms-${id}.lzfse`);
		const outPath = path.join(os.tmpdir(), `foodnoms-${id}.out`);
		fs.writeFileSync(inPath, B.from(bytes));
		try {
			let decoded = false;
			for (const bin of LZFSE_CLI_CANDIDATES) {
				try {
					execFileSync(bin, ["-decode", "-i", inPath, "-o", outPath], {
						stdio: "ignore",
						encoding: "utf8",
					});
					decoded = true;
					break;
				} catch {
					// try next binary path
				}
			}
			if (!decoded) return null;
			const out = fs.readFileSync(outPath, "utf8");
			return out.replace(/^\uFEFF/, "");
		} finally {
			try {
				fs.unlinkSync(inPath);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(outPath);
			} catch {
				/* ignore */
			}
		}
	} catch {
		return null;
	}
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Map real FoodNoms / export variants into `FoodnomsData`. */
export function normalizeFoodnomsPayload(raw: unknown): FoodnomsData | null {
	let root = asRecord(raw);
	if (!root) return null;
	// Some exports wrap payload in `data` or `payload`
	const inner = asRecord(root.data) ?? asRecord(root.payload);
	if (inner && (inner.foodEntries ?? inner.food_entries ?? inner.entries)) {
		root = inner;
	}
	const entriesRaw =
		root.foodEntries ??
		root.food_entries ??
		root.entries ??
		root.FoodEntries;
	if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) return null;

	const foodEntries: FoodEntry[] = [];
	for (const item of entriesRaw) {
		const o = asRecord(item);
		if (!o) continue;
		const name = String(o.name ?? "").trim();
		if (!name) continue;
		const foodID = String(o.foodID ?? o.foodId ?? o.food_id ?? "").trim() || "unknown";
		const source = String(o.source ?? "local");
		const quantity = Number(o.quantity);
		if (!Number.isFinite(quantity)) continue;
		const m = asRecord(o.measure) ?? {};
		const measure = {
			value: Number(m.value ?? 1),
			unit: String(m.unit ?? "serving"),
			traits: typeof m.traits === "number" ? m.traits : undefined,
		};
		const baseAmount = Number(o.baseAmount ?? o.base_amount ?? 100);
		const baseUnit = String(o.baseUnit ?? o.base_unit ?? "gram");
		const nRaw = asRecord(o.nutrients) ?? {};
		const nutrients: Record<string, number> = {};
		for (const [k, v] of Object.entries(nRaw)) {
			const num = typeof v === "number" ? v : parseFloat(String(v));
			if (Number.isFinite(num)) nutrients[k] = num;
		}
		const collectionSortIndex = Number(o.collectionSortIndex ?? o.collection_sort_index ?? 0);
		foodEntries.push({
			name,
			foodID,
			source,
			quantity,
			measure,
			baseAmount: Number.isFinite(baseAmount) ? baseAmount : 100,
			baseUnit,
			nutrients,
			brandOwner: o.brandOwner != null ? String(o.brandOwner) : undefined,
			barcode: o.barcode != null ? String(o.barcode) : undefined,
			collectionSortIndex: Number.isFinite(collectionSortIndex) ? collectionSortIndex : 0,
		});
	}
	if (foodEntries.length === 0) return null;

	const colRaw = root.foodCollections ?? root.food_collections ?? root.FoodCollections;
	const foodCollections: FoodCollection[] = [];
	if (Array.isArray(colRaw)) {
		for (const c of colRaw) {
			const cr = asRecord(c);
			if (!cr) continue;
			const n = String(cr.name ?? "").trim();
			if (n)
				foodCollections.push({
					name: n,
					collectionType: typeof cr.collectionType === "number" ? cr.collectionType : undefined,
					version: typeof cr.version === "number" ? cr.version : undefined,
					traits: typeof cr.traits === "number" ? cr.traits : undefined,
				});
		}
	}

	const out: FoodnomsData = {
		version: typeof root.version === "number" ? root.version : undefined,
		contentType: typeof root.contentType === "number" ? root.contentType : undefined,
		foodCollections: foodCollections.length ? foodCollections : undefined,
		foodEntries,
	};
	if (typeof root.date === "string") out.date = root.date;
	if (typeof root.loggedAt === "string") out.loggedAt = root.loggedAt;
	else if (typeof root.loggedAt === "number" && Number.isFinite(root.loggedAt)) {
		(out as Record<string, unknown>).loggedAtTimestamp = root.loggedAt;
	}
	if (typeof root.createdAt === "string") out.createdAt = root.createdAt;
	else if (typeof root.createdAt === "number" && Number.isFinite(root.createdAt)) {
		(out as Record<string, unknown>).createdAtTimestamp = root.createdAt;
	}
	const stringTimeFields = [
		"time",
		"mealTime",
		"meal_time",
		"logged_at",
		"updatedAt",
		"timestamp",
	] as const;
	for (const k of stringTimeFields) {
		const v = root[k];
		if (typeof v === "string" && v.trim()) (out as Record<string, unknown>)[k] = v;
		else if (k === "timestamp" && typeof v === "number" && Number.isFinite(v)) {
			(out as Record<string, unknown>).timestamp = v;
		}
	}
	if (typeof root.time === "string" && root.time.trim()) out.time = root.time.trim();
	return out;
}

export function parseFoodnomsJsonText(jsonText: string): FoodnomsData | null {
	try {
		const raw = JSON.parse(jsonText.trim().replace(/^\uFEFF/, ""));
		return normalizeFoodnomsPayload(raw);
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
	const cliJson = tryDecompressLzfseCli(bytes);
	if (cliJson) {
		const d = parseFoodnomsJsonText(cliJson);
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

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Meal clock time in 24h `HH:mm` from export fields only (no file mtime).
 * Uses ISO timestamps, plain clock strings, or numeric epoch (ms or s).
 */
export function resolveMealTime24h(data: FoodnomsData): string | null {
	const d = data as Record<string, unknown>;
	const toHHmm = (date: Date): string | null => {
		if (isNaN(date.getTime())) return null;
		return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	};
	const fromIsoLike = (s: unknown): string | null => {
		if (typeof s !== "string" || !s.trim()) return null;
		const date = new Date(s.trim());
		return toHHmm(date);
	};
	const fromClock = (s: unknown): string | null => {
		if (typeof s !== "string") return null;
		const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
		if (!m) return null;
		const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
		const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
		return `${pad2(h)}:${pad2(min)}`;
	};
	// Explicit clock fields first
	for (const key of ["time", "mealTime", "meal_time"] as const) {
		const t = fromClock(d[key]);
		if (t) return t;
	}
	// ISO strings (loggedAt, createdAt, etc.)
	for (const key of ["loggedAt", "createdAt", "updatedAt", "logged_at", "timestamp"] as const) {
		const t = fromIsoLike(d[key]);
		if (t) return t;
	}
	// date may include time: 2026-03-31T15:30:00
	if (typeof data.date === "string" && data.date.includes("T")) {
		const t = fromIsoLike(data.date);
		if (t) return t;
	}
	// Numeric epoch (FoodNoms / Apple sometimes use seconds)
	const ts = d.loggedAtTimestamp ?? d.createdAtTimestamp ?? d.timestamp;
	if (typeof ts === "number" && Number.isFinite(ts)) {
		const ms = ts > 1e12 ? ts : ts * 1000;
		const t = toHHmm(new Date(ms));
		if (t) return t;
	}
	return null;
}

/** Local `Date` for path templates: meal calendar day + optional clock time from export. */
export function mealDateForPathExpansion(dateIso: string, data: FoodnomsData): Date {
	const parts = dateIso.split("-").map(Number);
	const y = parts[0];
	const mo = parts[1];
	const d = parts[2];
	if (!y || !mo || !d) return new Date();
	const dt = new Date(y, mo - 1, d);
	const t = resolveMealTime24h(data);
	if (t) {
		const hm = t.split(":").map(Number);
		if (Number.isFinite(hm[0]) && Number.isFinite(hm[1])) {
			dt.setHours(hm[0]!, hm[1]!, 0, 0);
		}
	}
	return dt;
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
