import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import JSZip from "jszip";

interface KeyMapping {
	jsonKey: string;
	yamlKey: string;
	rounding?: number; // Number of decimal places (0 = whole numbers, 1 = tenths, etc.)
}

interface WorkoutTemplate {
	workoutType: string;
	templatePath: string;
}

interface AdditionalFrontMatter {
	key: string;
	value: string;
}

interface WorkoutImporterSettings {
	keyMappings: KeyMapping[];
	templates: WorkoutTemplate[];
	defaultTemplatePath: string;
	saveDestination: string; // Template path with variables: {YYYY}, {MM}, {YYYYMMDD-HHMM}, {name}
	additionalFrontMatter: AdditionalFrontMatter[];
	scanFolderPath: string; // Folder to scan for JSON/CSV (empty = whole vault)
	deleteSourceAfterImport: boolean; // Move source file to vault .trash after successful processing
	statsNotePathTemplate: string; // Path for health/stats notes: {year}, {month}, {date}
	statsNoteBodyTemplatePath: string; // Optional note whose content is used as body below frontmatter for new stats notes
	mapTileStyle: "osm" | "carto-dark" | "maptiler-fiord"; // Basemap style for route maps
	maptilerApiKey: string; // Required for MapTiler Fiord style (free key at maptiler.com)
}

// --- AutoExport JSON structure (Health AutoExport) ---
export interface AutoExportParsed {
	workouts: any[];
	metrics?: any[];
	sleepAnalysis?: any[];
}

export function parseAutoExportJson(jsonText: string): AutoExportParsed {
	const raw = JSON.parse(jsonText) as Record<string, unknown>;
	const data = raw.data as Record<string, unknown> | undefined;

	const workouts = Array.isArray(data?.workouts) ? data.workouts : [];
	const metrics = Array.isArray(data?.metrics) ? data.metrics : undefined;
	const sleepAnalysis = Array.isArray(raw.sleep_analysis) ? raw.sleep_analysis : undefined;

	return { workouts, metrics, sleepAnalysis };
}

export function isAutoExportJson(parsed: AutoExportParsed): boolean {
	return parsed.workouts.length > 0 || (parsed.metrics?.length ?? 0) > 0 || (parsed.sleepAnalysis?.length ?? 0) > 0;
}

// --- FITINDEX / RENPHO CSV structure (scale body composition) ---
export interface FITINDEXRow {
	date: string; // YYYY-MM-DD
	time: string;
	weightKg?: number;
	weightLb?: number;
	bmi?: number;
	bodyFatPct?: number;
	bodyFatMassLb?: number; // RENPHO: Body Fat Mass(lb)
	fatFreeWeightKg?: number;
	fatFreeWeightLb?: number;
	subcutaneousFatPct?: number;
	visceralFat?: number;
	bodyWaterPct?: number;
	bodyWaterMassLb?: number; // RENPHO: Body Water Mass(lb)
	musclePct?: number; // RENPHO: Muscle Percentage(%)
	skeletalMusclePct?: number;
	muscleMassKg?: number;
	muscleMassLb?: number;
	boneMassKg?: number;
	boneMassLb?: number;
	proteinPct?: number;
	proteinMassLb?: number; // RENPHO: Protein Mass(lb)
	bmrKcal?: number;
	metabolicAge?: number;
	whr?: number; // RENPHO: Waist-to-Hip Ratio
	optimalWeightLb?: number; // RENPHO: Optimal Weight(lb)
	weightLevel?: string; // RENPHO: e.g. "Obesity level Ⅰ"
	bodyType?: string; // RENPHO: e.g. "Overweight"
	[key: string]: string | number | undefined;
}

/** Parse date from "MM/DD/YYYY", "MM/DD/YY", "MM/DD/YYYY, HH:MM:SS", or "YYYY-MM-DD" -> YYYY-MM-DD */
function parseFITINDEXDate(raw: string): string {
	const mmddyyyy = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (mmddyyyy) {
		const [, m, d, y] = mmddyyyy;
		return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
	}
	const mmddyy = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
	if (mmddyy) {
		const [, m, d, y2] = mmddyy;
		const y = parseInt(y2, 10) < 50 ? `20${y2}` : `19${y2}`;
		return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
	}
	const yyyymmdd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return yyyymmdd ? yyyymmdd[1] + "-" + yyyymmdd[2] + "-" + yyyymmdd[3] : "";
}

/** Normalize header/key for comparison: trim, collapse spaces, remove BOM */
function norm(s: string): string {
	return (s ?? "").trim().replace(/\s+/g, " ").replace(/^\uFEFF/, "");
}

/** FITINDEX column order for user's CSV: 0=Time, 1=Weight(lb), 2=BMI, 3=Body Fat(%), 4=Fat-free(lb), 5=Subcutaneous(%), 6=Visceral, 7=Body Water(%), 8=Skeletal Muscle(%), 9=Muscle Mass(lb), 10=Bone Mass(lb), 11=Protein(%), 12=BMR, 13=Metabolic Age, 14=Remarks */
function applyFITINDEXByIndex(row: FITINDEXRow, values: string[]): void {
	const raw = (i: number) => values[i]?.trim().replace(/^["']|["']$/g, "") ?? "";
	if (values.length < 14) return;
	const dateStr = parseFITINDEXDate(raw(0));
	if (dateStr) row.date = dateStr;
	row.time = raw(0);
	if (row.weightLb == null) row.weightLb = parseNum(raw(1));
	if (row.bmi == null) row.bmi = parseNum(raw(2));
	if (row.bodyFatPct == null) row.bodyFatPct = parseNum(raw(3));
	if (row.fatFreeWeightLb == null) row.fatFreeWeightLb = parseNum(raw(4));
	if (row.subcutaneousFatPct == null) row.subcutaneousFatPct = parseNum(raw(5));
	if (row.visceralFat == null) row.visceralFat = parseNum(raw(6));
	if (row.bodyWaterPct == null) row.bodyWaterPct = parseNum(raw(7));
	if (row.skeletalMusclePct == null) row.skeletalMusclePct = parseNum(raw(8));
	if (row.muscleMassLb == null) row.muscleMassLb = parseNum(raw(9));
	if (row.boneMassLb == null) row.boneMassLb = parseNum(raw(10));
	if (row.proteinPct == null) row.proteinPct = parseNum(raw(11));
	if (row.bmrKcal == null) row.bmrKcal = parseNum(raw(12));
	if (row.metabolicAge == null) row.metabolicAge = parseNum(raw(13));
}

/** Parse body composition CSV (FITINDEX or RENPHO). When indexFallback is true (FITINDEX), also apply column-index fallback. */
export function parseFITINDEXCsv(csvText: string, options?: { indexFallback?: boolean }): FITINDEXRow[] {
	const indexFallback = options?.indexFallback !== false;
	const lines = csvText.trim().split(/\r?\n/).filter((line) => line.trim());
	if (lines.length < 2) return [];

	const headerLine = lines[0].replace(/^\uFEFF/, "");
	const headers = headerLine.split(",").map((h) => h.trim());
	const rows: FITINDEXRow[] = [];

	for (let i = 1; i < lines.length; i++) {
		const values = parseCsvLine(lines[i]);
		const row: FITINDEXRow = { date: "", time: "" };

		for (let c = 0; c < headers.length && c < values.length; c++) {
			const key = norm(headers[c]);
			const raw = values[c]?.trim() ?? "";
			// Date (RENPHO: separate column e.g. "3/14/26")
			if (key === "Date") {
				const parsed = parseFITINDEXDate(raw);
				if (parsed) row.date = parsed;
			} else if (key === "Time" || key === "Time of Measurement") {
				row.time = raw.replace(/^["']|["']$/g, "");
				if (!row.date) row.date = parseFITINDEXDate(row.time) || (row.time.match(/^\d{4}-\d{2}-\d{2}/) ? row.time.slice(0, 10) : "");
			} else if (key === "Weight (kg)") row.weightKg = parseNum(raw);
			else if (key === "Weight(lb)" || key === "Weight (lb)") row.weightLb = parseNum(raw);
			else if (key === "BMI") row.bmi = parseNum(raw);
			else if (key === "Body Fat (%)" || key === "Body Fat(%)" || key === "Body Fat Percentage (%)" || key === "Body Fat Percentage(%)") row.bodyFatPct = parseNum(raw);
			else if (key === "Body Fat Mass(lb)" || key === "Body Fat Mass (lb)") row.bodyFatMassLb = parseNum(raw);
			else if (key === "Fat-free Body Weight (kg)") row.fatFreeWeightKg = parseNum(raw);
			else if (key === "Fat-free Body Weight(lb)" || key === "Fat-free Body Weight (lb)" || key === "Fat-Free Mass (lb)" || key === "Fat-Free Mass(lb)") row.fatFreeWeightLb = parseNum(raw);
			else if (key === "Subcutaneous Fat (%)" || key === "Subcutaneous Fat(%)") row.subcutaneousFatPct = parseNum(raw);
			else if (key === "Visceral Fat") row.visceralFat = parseNum(raw);
			else if (key === "Body Water (%)" || key === "Body Water(%)" || key === "Body Water Percentage (%)" || key === "Body Water Percentage(%)") row.bodyWaterPct = parseNum(raw);
			else if (key === "Body Water Mass(lb)" || key === "Body Water Mass (lb)") row.bodyWaterMassLb = parseNum(raw);
			else if (key === "Muscle Percentage (%)" || key === "Muscle Percentage(%)") row.musclePct = parseNum(raw);
			else if (key === "Skeletal Muscle (%)" || key === "Skeletal Muscle(%)" || key === "Skeletal Muscle Percentage (%)" || key === "Skeletal Muscle Percentage(%)") row.skeletalMusclePct = parseNum(raw);
			else if (key === "Muscle Mass (kg)") row.muscleMassKg = parseNum(raw);
			else if (key === "Muscle Mass(lb)" || key === "Muscle Mass (lb)" || key === "Skeletal Muscle Mass(lb)" || key === "Skeletal Muscle Mass (lb)") row.muscleMassLb = parseNum(raw);
			else if (key === "Bone Mass (kg)") row.boneMassKg = parseNum(raw);
			else if (key === "Bone Mass(lb)" || key === "Bone Mass (lb)") row.boneMassLb = parseNum(raw);
			else if (key === "Protein (%)" || key === "Protein(%)" || key === "Protein Percentage (%)" || key === "Protein Percentage(%)") row.proteinPct = parseNum(raw);
			else if (key === "Protein Mass(lb)" || key === "Protein Mass (lb)") row.proteinMassLb = parseNum(raw);
			else if (key === "BMR (kcal)" || key === "BMR(kcal)") row.bmrKcal = parseNum(raw);
			else if (key === "Metabolic Age") row.metabolicAge = parseNum(raw);
			else if (key === "WHR (Waist-to-Hip Ratio)" || key === "WHR") row.whr = parseNum(raw);
			else if (key === "Optimal Weight(lb)" || key === "Optimal Weight (lb)") row.optimalWeightLb = parseNum(raw);
			else if (key === "Weight Level") row.weightLevel = raw.replace(/^["']|["']$/g, "").trim() || undefined;
			else if (key === "Body Type") row.bodyType = raw.replace(/^["']|["']$/g, "").trim() || undefined;
		}

		// Fallback: map by column index (FITINDEX column order only)
		if (indexFallback) applyFITINDEXByIndex(row, values);

		if (row.date) rows.push(row);
	}

	return rows;
}

function parseNum(s: string): number | undefined {
	const t = (s ?? "").trim().replace(/^["']|["']$/g, "");
	if (t === "" || t === "--" || t === "−" || t === "–") return undefined;
	const n = parseFloat(t);
	return isNaN(n) ? undefined : n;
}

function parseCsvLine(line: string): string[] {
	const result: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
		} else if ((ch === "," && !inQuotes) || ch === "\n") {
			result.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	result.push(current);
	return result;
}

export function isFITINDEXCsvFileName(fileName: string): boolean {
	return fileName.toUpperCase().includes("FITINDEX") && fileName.toLowerCase().endsWith(".csv");
}

/** RENPHO scale body composition CSV (e.g. RENPHO Health-Jimmy.csv). */
export function isRENPHOCsvFileName(fileName: string): boolean {
	return fileName.toUpperCase().includes("RENPHO") && fileName.toLowerCase().endsWith(".csv");
}

/** HealthAutoExport Workouts CSV (e.g. Workouts-20260101_000000-20260216_235959.csv). */
export function isHealthAutoExportWorkoutsCsv(fileName: string): boolean {
	return fileName.startsWith("Workouts-") && fileName.toLowerCase().endsWith(".csv");
}

/** Parse "HH:MM:SS" or "H:MM:SS" to seconds. */
function parseDurationToSeconds(s: string): number {
	const parts = (s || "").trim().split(":").map((p) => parseInt(p, 10) || 0);
	if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return parts[0] || 0;
}

/** Parse HealthAutoExport Workouts CSV into workout objects for processWorkout. */
export function parseHealthAutoExportWorkoutsCsv(csvText: string): any[] {
	const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim());
	if (lines.length < 2) return [];
	const headerLine = lines[0];
	const headers = parseCsvLine(headerLine).map((h) => h.trim().toLowerCase());
	const col = (name: string) => headers.findIndex((h) => h.includes(name.toLowerCase()));
	const idxType = col("workout type") >= 0 ? col("workout type") : 0;
	const idxStart = col("start") >= 0 ? col("start") : 1;
	const idxEnd = col("end") >= 0 ? col("end") : 2;
	const idxDuration = col("duration") >= 0 ? col("duration") : 3;
	const idxActiveEnergy = col("active energy") >= 0 ? col("active energy") : 4;
	const idxRestingEnergy = col("resting energy") >= 0 ? col("resting energy") : -1;
	const idxIntensity = col("intensity") >= 0 ? col("intensity") : -1;
	const idxMaxHr = headers.findIndex((h) => h.includes("max") && h.includes("heart"));
	const idxAvgHr = headers.findIndex((h) => h.includes("avg") && h.includes("heart"));
	const idxDistance = col("distance") >= 0 ? col("distance") : -1;
	const idxSteps = col("step count") >= 0 ? col("step count") : -1;
	const idxFlights = col("flights") >= 0 ? col("flights") : -1;
	const idxLocation = col("location") >= 0 ? col("location") : -1;
	const workouts: any[] = [];
	for (let i = 1; i < lines.length; i++) {
		const values = parseCsvLine(lines[i]);
		const get = (idx: number) => (idx >= 0 && values[idx] !== undefined ? values[idx].trim() : "");
		const getNum = (idx: number) => (idx >= 0 && values[idx] !== undefined ? parseFloat(values[idx]) : undefined);
		const name = get(idxType) || "Unknown";
		const start = get(idxStart);
		if (!start) continue;
		const end = get(idxEnd);
		const durationStr = get(idxDuration);
		const durationSec = durationStr ? parseDurationToSeconds(durationStr) : undefined;
		const activeKcal = getNum(idxActiveEnergy);
		const workout: any = {
			name,
			start,
			end: end || undefined,
			duration: durationSec,
			activeEnergyBurned: activeKcal != null ? { qty: activeKcal, units: "kcal" } : undefined,
			calories: activeKcal,
		};
		if (getNum(idxRestingEnergy) != null) workout.restingEnergy = { qty: getNum(idxRestingEnergy), units: "kcal" };
		if (getNum(idxIntensity) != null) workout.intensity = { qty: getNum(idxIntensity), units: "kcal/hr·kg" };
		if (getNum(idxMaxHr) != null) workout.heartRateMax = getNum(idxMaxHr);
		if (getNum(idxAvgHr) != null) workout.heartRateAvg = getNum(idxAvgHr);
		if (getNum(idxDistance) != null) workout.distance = { qty: getNum(idxDistance), units: "km" };
		if (getNum(idxSteps) != null) workout.stepCount = getNum(idxSteps);
		if (getNum(idxFlights) != null) workout.flightsClimbed = getNum(idxFlights);
		if (get(idxLocation)) workout.location = get(idxLocation);
		workouts.push(workout);
	}
	return workouts;
}

// --- Stats notes path (template from settings) ---
const DEFAULT_STATS_PATH_TEMPLATE = "60 Logs/{year}/Stats/{month}/{date}.md";

// --- Routes: track data + map PNG stored by workoutId (stable even if note is renamed) ---
const ROUTES_FOLDER = "routes";

export interface RoutePoint {
	lat: number;
	lon: number;
	speed: number; // m/s
}

// TODO: If this plugin is ever distributed beyond personal use, add a check to prevent mixing
// JSON (Health AutoExport) and CSV (HealthAutoExport Workouts CSV) workout sources in the same vault.

// --- Activity icons for Apple-style workout banners (98 Assets/images/activityIcons/*.png) ---
const ACTIVITY_ICONS_FOLDER = "98 Assets/images/activityIcons";
const WORKOUT_TYPE_TO_ICON: Record<string, string> = {
	"traditional strength training": "strength",
	"core training": "core",
	"indoor run": "running",
	"outdoor run": "running",
	"running": "running",
	"run": "running",
	"walking": "walking",
	"outdoor walk": "walking",
	"walk": "walking",
	"indoor cycling": "cycling",
	"outdoor cycling": "cycling",
	"cycling": "cycling",
	"spin": "spin",
	"hiit": "hiit",
	"high intensity interval training": "hiit",
	"yoga": "yoga",
	"rowing": "rowing",
	"swimming": "swim",
	"swim": "swim",
	"elliptical": "elliptical",
	"stair": "stair",
	"stairs": "stair",
	"stair climbing": "stair",
	"dance": "dance",
	"hiking": "hiking",
	"hike": "hiking",
	"mind & body": "mindbody",
	"mind and body": "mindbody",
	"cooldown": "cooldown",
	"sauna": "sauna",
	"functional strength": "functionalstrength",
	"functional strength training": "functionalstrength",
	"body fit": "bodyfit",
	"body fitness": "bodyfit",
	"asana": "asana",
	"freeletics": "freeletics",
	"fitbod": "fitbod",
	"other": "other",
	"bodyfit": "bodyfit",
};

/** Build stats note path from template. Variables: {year}, {month}, {date} (YYYY-MM-DD). */
export function getStatsNotePath(date: Date, pathTemplate: string): string {
	const template = pathTemplate?.trim() || DEFAULT_STATS_PATH_TEMPLATE;
	const year = date.getFullYear().toString();
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const dateStr =
		date.getFullYear() +
		"-" +
		(date.getMonth() + 1).toString().padStart(2, "0") +
		"-" +
		date.getDate().toString().padStart(2, "0");
	return template.replace(/\{year\}/g, year).replace(/\{month\}/g, month).replace(/\{date\}/g, dateStr);
}

/** Generate a stable UUID from workout identity (name + start). Same workout always gets same id. */
export function workoutIdFromWorkout(workout: { name?: string; start?: string }): string {
	const name = (workout?.name ?? "").trim() || "Unknown";
	const start = (workout?.start ?? "").toString().trim().slice(0, 19);
	const key = `${name}|${start}`;
	// Simple hash -> 32 hex chars, format as UUID 8-4-4-4-12
	let h = 0;
	for (let i = 0; i < key.length; i++) {
		const c = key.charCodeAt(i);
		h = (h << 5) - h + c;
		h = h >>> 0;
	}
	const hex = (h >>> 0).toString(16).padStart(8, "0");
	// Second 8 from string hash
	let h2 = 5381;
	for (let i = 0; i < key.length; i++) h2 = (h2 * 33) ^ key.charCodeAt(i);
	const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
	const hex3 = (key.length + h + h2).toString(16).padStart(8, "0").slice(-8);
	const hex4 = (h ^ h2).toString(16).padStart(8, "0").slice(-8);
	return `${hex}-${hex2.slice(0, 4)}-${hex2.slice(4, 8)}-${hex3}-${hex4}${hex.slice(0, 4)}`;
}

/** Convert snake_case to camelCase; used for frontmatter keys (e.g. body_fat_percentage -> bodyFatPercentage). */
function toCamelCase(s: string): string {
	const parts = s.split("_").filter(Boolean);
	if (parts.length === 0) return s;
	let out = parts[0].toLowerCase();
	for (let i = 1; i < parts.length; i++) {
		const w = parts[i];
		out += w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "";
	}
	return out;
}

/** Map AutoExport metric names to normalized camelCase frontmatter keys (template-friendly). Unmapped names use toCamelCase. */
const AUTOEXPORT_METRIC_TO_FRONTMATTER: Record<string, string> = {
	step_count: "steps",
	active_energy: "activeCalories",
	apple_exercise_time: "exerciseMinutes",
	walking_running_distance: "distance",
	flights_climbed: "flights",
	vo2_max: "vo2Max",
	blood_oxygen_saturation: "bloodOxygen",
	weight_body_mass: "weight",
	body_mass_index: "bmi",
	body_fat_percentage: "bfp",
	lean_body_mass: "lbm",
	apple_sleeping_wrist_temperature: "wristTemp",
	heart_rate_variability: "hrv",
	resting_heart_rate: "restingHr",
	respiratory_rate: "respiratoryRate",
	heart_rate: "hr",
};

/** Only for aligning FITINDEX columns to same frontmatter keys as AutoExport (same concept = same key). */
const FITINDEX_ALIGNMENT: Record<string, string> = {
	"Weight (kg)": "weight",
	"BMI": "bmi",
	"Body Fat (%)": "bfp",
	"Fat-free Body Weight (kg)": "lbm",
};

const KG_TO_LB = 2.20462;

export function parseFrontmatter(content: string): { frontmatter: Record<string, string | number>; body: string } {
	const frontmatter: Record<string, string | number> = {};
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	const body = match ? match[2] : content;
	const fmText = match ? match[1] : "";
	for (const line of fmText.split(/\r?\n/)) {
		const colon = line.indexOf(":");
				if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const raw = line.slice(colon + 1).trim();
		if (raw === "" || raw === '""' || raw === "''") {
			frontmatter[key] = "";
			continue;
		}
		const num = parseFloat(raw);
		if (!isNaN(num) && raw === num.toString()) {
			frontmatter[key] = num;
		} else {
			frontmatter[key] = raw.replace(/^["']|["']$/g, "").replace(/\\"/g, '"');
		}
	}
	return { frontmatter, body };
}

/** Only include keys with a non-blank value (no empty string, undefined, or null). */
function frontmatterWithoutBlanks(fm: Record<string, string | number>): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const [k, v] of Object.entries(fm)) {
		if (v === undefined || v === null) continue;
		if (typeof v === "string" && v.trim() === "") continue;
		out[k] = v;
	}
	return out;
}

export function stringifyFrontmatter(fm: Record<string, string | number>): string {
	const lines: string[] = [];
	for (const [k, v] of Object.entries(fm)) {
		if (v === undefined || v === null) continue;
		if (typeof v === "number") {
			lines.push(`${k}: ${v}`);
		} else {
			const s = String(v);
			const needsQuotes = s.includes(":") || s.includes('"') || s.includes("\n") || s.includes(" ");
			lines.push(needsQuotes ? `${k}: "${s.replace(/"/g, '\\"')}"` : `${k}: ${s}`);
		}
	}
	return lines.join("\n") + "\n";
}

const DEFAULT_SETTINGS: WorkoutImporterSettings = {
	keyMappings: [
		{ jsonKey: "name", yamlKey: "name" },
		{ jsonKey: "duration", yamlKey: "duration", rounding: 0 },
		{ jsonKey: "activeEnergyBurned.qty", yamlKey: "calories", rounding: 0 },
		{ jsonKey: "intensity.qty", yamlKey: "intensity", rounding: 1 },
		{ jsonKey: "start", yamlKey: "start" },
		{ jsonKey: "end", yamlKey: "end" },
	],
	templates: [],
	defaultTemplatePath: "",
	saveDestination: "{YYYY}/{MM}/{YYYYMMDD-HHMM}-{name}.md",
	additionalFrontMatter: [],
	scanFolderPath: "",
	deleteSourceAfterImport: true,
	statsNotePathTemplate: "60 Logs/{year}/Stats/{month}/{date}.md",
	statsNoteBodyTemplatePath: "",
	mapTileStyle: "maptiler-fiord",
	maptilerApiKey: "",
};

export default class WorkoutImporterPlugin extends Plugin {
	settings: WorkoutImporterSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon(
			"dumbbell",
			"Pulse",
			() => {
				this.scanAndImport();
			}
		);
		ribbonIconEl.addClass("my-plugin-ribbon-class");

		this.addCommand({
			id: "scan-health-workout-imports",
			name: "Scan for Health and Workout Imports",
			callback: () => {
				this.scanAndImport();
			},
		});

		this.addCommand({
			id: "update-banner-this-page",
			name: "Update banner for this page",
			callback: () => {
				this.updateBannerForActiveNote();
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WorkoutImporterSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Decompress a ZIP in the vault into baseFolder/{zipBasename}/. Extracts only text files (csv, json, gpx, xml, txt, md). */
	async expandZipToVault(zipFile: TFile, baseFolder: string): Promise<void> {
		const zipBasename = zipFile.basename;
		const extractRoot = baseFolder ? `${baseFolder}/${zipBasename}` : zipBasename;
		const url = this.app.vault.getResourcePath(zipFile);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Failed to read zip: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		const zip = await JSZip.loadAsync(arrayBuffer);
		const textExtensions = new Set(["csv", "json", "gpx", "xml", "txt", "md"]);
		for (const [entryPath, entry] of Object.entries(zip.files) as [string, { dir: boolean; async(s: string): Promise<string> }][]) {
			if (entry.dir) continue;
			const normalized = entryPath.replace(/\\/g, "/").replace(/\/+/g, "/");
			if (normalized.includes("..")) continue;
			const ext = (normalized.split(".").pop() || "").toLowerCase();
			if (!textExtensions.has(ext)) continue;
			const content = await entry.async("string");
			const vaultPath = baseFolder ? `${extractRoot}/${normalized}` : `${zipBasename}/${normalized}`;
			const parts = vaultPath.split("/");
			for (let i = 1; i < parts.length; i++) {
				const dirPath = parts.slice(0, i).join("/");
				if (!this.app.vault.getAbstractFileByPath(dirPath)) {
					await this.app.vault.createFolder(dirPath);
				}
			}
			try {
				await this.app.vault.create(vaultPath, content);
			} catch (e) {
				// File may already exist (e.g. re-run); skip
				if (!String(e).includes("already exists")) throw e;
			}
		}
	}

	async scanAndImport(): Promise<void> {
		const folder = this.settings.scanFolderPath?.trim() || "";
		let allFiles = this.app.vault.getFiles();
		// Decompress any ZIPs in scope first so we can process their contents
		const inScope = (f: TFile) => !folder || f.path === folder || f.path.startsWith(folder + "/");
		const zips = allFiles.filter((f) => inScope(f) && (f.extension || "").toLowerCase() === "zip");
		for (const zipFile of zips) {
			try {
				await this.expandZipToVault(zipFile, folder);
				allFiles = this.app.vault.getFiles();
				if (this.settings.deleteSourceAfterImport) {
					await this.app.vault.trash(zipFile, false);
				}
			} catch (err) {
				new Notice(`Failed to extract ${zipFile.name}: ${err}`);
			}
		}
		const toProcess = allFiles.filter((f) => {
			if (!inScope(f)) return false;
			const ext = (f.extension || "").toLowerCase();
			if (ext === "json") return true;
			if (ext === "csv" && isFITINDEXCsvFileName(f.name)) return true;
			if (ext === "csv" && isRENPHOCsvFileName(f.name)) return true;
			if (ext === "csv" && isHealthAutoExportWorkoutsCsv(f.name)) return true;
			return false;
		});
		if (toProcess.length === 0) {
			new Notice(
				folder
					? `No JSON, FITINDEX/RENPHO CSV, or Workouts CSV found in ${folder}`
					: "No JSON, FITINDEX/RENPHO CSV, or Workouts CSV found in vault"
			);
			return;
		}
		new Notice(`Scanning ${toProcess.length} file(s)...`);
		try {
			const result = await this.processVaultFiles(toProcess);
			new Notice(
				`Imported ${result.success} item(s)${
					result.errors > 0 ? ` (${result.errors} error(s))` : ""
				}`
			);
		} catch (err) {
			new Notice(`Import failed: ${err}`);
		}
	}

	async processVaultFiles(files: TFile[]): Promise<{ success: number; errors: number }> {
		let success = 0;
		let errors = 0;
		for (const file of files) {
			let processed = false;
			try {
				const text = await this.app.vault.read(file);
				const ext = (file.extension || "").toLowerCase();
				if (ext === "json") {
					let parsed: AutoExportParsed;
					try {
						parsed = parseAutoExportJson(text);
					} catch (parseErr) {
						// Invalid JSON
						console.error(`Error parsing ${file.path}:`, parseErr);
						new Notice(`Error parsing ${file.path}: invalid JSON`);
						errors++;
						continue;
					}
					if (!isAutoExportJson(parsed)) {
						// Not AutoExport format (data.workouts / data.metrics / sleep_analysis) — skip silently
						continue;
					}
					const result = await this.processJSONText(text);
					success += result.success;
					errors += result.errors;
					processed = true;
				} else if (ext === "csv" && (isFITINDEXCsvFileName(file.name) || isRENPHOCsvFileName(file.name))) {
					const rows = parseFITINDEXCsv(text, { indexFallback: isFITINDEXCsvFileName(file.name) });
					if (rows.length > 0) {
						const n = await this.processFITINDEXToStatsNotes(rows);
						success += n;
						processed = true;
					}
				} else if (ext === "csv" && isHealthAutoExportWorkoutsCsv(file.name)) {
					const workouts = parseHealthAutoExportWorkoutsCsv(text);
					for (const workout of workouts) {
						try {
							await this.processWorkout(workout);
							success++;
						} catch (error) {
							console.error("Error processing workout from Workouts CSV:", error);
							errors++;
						}
					}
					processed = workouts.length > 0;
				}
				if (processed && this.settings.deleteSourceAfterImport) {
					await this.app.vault.trash(file, false);
				}
			} catch (error) {
				console.error(`Error processing ${file.path}:`, error);
				new Notice(`Error processing ${file.path}: ${error}`);
				errors++;
			}
		}
		return { success, errors };
	}

	async processJSONText(jsonText: string, imageData?: string): Promise<{ success: number; errors: number }> {
		let success = 0;
		let errors = 0;
		try {
			const parsed = parseAutoExportJson(jsonText);
			if (!isAutoExportJson(parsed)) {
				throw new Error("Invalid AutoExport JSON: expected data.workouts, data.metrics, or sleep_analysis");
			}
			const { workouts, metrics, sleepAnalysis } = parsed;
			for (const workout of workouts) {
				try {
					// Pass imageData only for first workout so it gets the photo; others get generated banners
					const isFirst = workouts.indexOf(workout) === 0;
					await this.processWorkout(workout, isFirst ? imageData : undefined);
					success++;
				} catch (error) {
					console.error("Error processing workout:", error);
					errors++;
				}
			}
			if (metrics?.length) {
				try {
					const n = await this.processMetricsToStatsNotes(metrics);
					success += n;
				} catch (err) {
					console.error("Error processing metrics to stats notes:", err);
					errors++;
				}
			}
			if (sleepAnalysis?.length) {
				try {
					const n = await this.processSleepToStatsNotes(sleepAnalysis);
					success += n;
				} catch (err) {
					console.error("Error processing sleep to stats notes:", err);
					errors++;
				}
			}
		} catch (error) {
			console.error("Error parsing JSON:", error);
			throw new Error(`Invalid JSON: ${error}`);
		}
		return { success, errors };
	}

	async getStatsNoteBodyTemplateContent(): Promise<string> {
		const path = (this.settings.statsNoteBodyTemplatePath ?? "").trim();
		if (!path) return "";
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !("content" in file)) return "";
		try {
			return await this.app.vault.read(file as TFile);
		} catch {
			return "";
		}
	}

	async getOrCreateStatsNote(date: Date): Promise<{ path: string; frontmatter: Record<string, string | number>; body: string }> {
		const path = getStatsNotePath(date, this.settings.statsNotePathTemplate ?? DEFAULT_STATS_PATH_TEMPLATE);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && "content" in existing) {
			const content = await this.app.vault.read(existing as TFile);
			const { frontmatter, body } = parseFrontmatter(content);
			return { path, frontmatter, body };
		}
		// Ensure all parent folders exist (recursive)
		const pathParts = path.split("/");
		if (pathParts.length > 1) {
			for (let i = 1; i < pathParts.length; i++) {
				const folderPath = pathParts.slice(0, i).join("/");
				if (!this.app.vault.getAbstractFileByPath(folderPath)) {
					await this.app.vault.createFolder(folderPath);
				}
			}
		}
		const dateStr =
			date.getFullYear() +
			"-" +
			(date.getMonth() + 1).toString().padStart(2, "0") +
			"-" +
			date.getDate().toString().padStart(2, "0");
		const bodyTemplate = await this.getStatsNoteBodyTemplateContent();
		const initialFrontmatter: Record<string, string | number> = { date: dateStr };
		const initialContent =
			"---\n" + stringifyFrontmatter(initialFrontmatter) + "---\n\n" + (bodyTemplate || "");
		try {
			await this.app.vault.create(path, initialContent);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const isAlreadyExists = /already exists/i.test(errMsg);
			// When "File already exists", the file may not be in the vault index yet — retry briefly
			for (let attempt = 0; attempt < 5; attempt++) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file && "content" in file) {
					const content = await this.app.vault.read(file as TFile);
					const parsed = parseFrontmatter(content);
					return { path, frontmatter: parsed.frontmatter, body: parsed.body };
				}
				if (!isAlreadyExists) break;
				await new Promise((r) => setTimeout(r, 30 + attempt * 20));
			}
			// Try finding by filename in parent folder (path normalization)
			const parentPath = pathParts.slice(0, -1).join("/");
			const fileName = pathParts[pathParts.length - 1];
			const folder = this.app.vault.getAbstractFileByPath(parentPath);
			if (folder && "children" in folder) {
				const found = (folder as TFolder).children.find((f: any) => f.name === fileName);
				if (found && "content" in found) {
					const content = await this.app.vault.read(found as TFile);
					const parsed = parseFrontmatter(content);
					return { path: found.path, frontmatter: parsed.frontmatter, body: parsed.body };
				}
			}
			// Last resort: scan all files (handles path normalization / "File already exists" index lag)
			const byPath = this.app.vault.getFiles().find((f) => f.path === path || f.path.endsWith("/" + fileName));
			if (byPath) {
				const content = await this.app.vault.read(byPath);
				const parsed = parseFrontmatter(content);
				return { path: byPath.path, frontmatter: parsed.frontmatter, body: parsed.body };
			}
			throw err instanceof Error ? err : new Error(`Could not create stats note at ${path}: ${err}`);
		}
		return { path, frontmatter: initialFrontmatter, body: bodyTemplate || "" };
	}

	async mergeAndWriteStatsNote(path: string, updates: Record<string, string | number>, body: string): Promise<void> {
		let existing = this.app.vault.getAbstractFileByPath(path) as TFile | null;
		let frontmatter: Record<string, string | number>;
		let bodyOut = body;
		if (existing) {
			const content = await this.app.vault.read(existing);
			const parsed = parseFrontmatter(content);
			frontmatter = { ...parsed.frontmatter };
			// Apply every update so values always overwrite template placeholders
			for (const [k, v] of Object.entries(updates)) {
				if (v !== undefined && v !== null) frontmatter[k] = v;
			}
			bodyOut = parsed.body;
		} else {
			frontmatter = { ...updates };
		}
		const filtered = frontmatterWithoutBlanks(frontmatter);
		const out = "---\n" + stringifyFrontmatter(filtered) + "---\n\n" + (bodyOut || "");
		if (existing) {
			await this.app.vault.modify(existing, out);
		} else {
			try {
				await this.app.vault.create(path, out);
			} catch (createErr) {
				const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
				// File may exist but not in index yet — retry briefly then read and modify
				for (let attempt = 0; attempt < 5; attempt++) {
					existing = this.app.vault.getAbstractFileByPath(path) as TFile | null;
					if (existing) {
						const content = await this.app.vault.read(existing);
						const parsed = parseFrontmatter(content);
						frontmatter = { ...parsed.frontmatter };
						for (const [k, v] of Object.entries(updates)) {
							if (v !== undefined && v !== null) frontmatter[k] = v;
						}
						bodyOut = parsed.body;
						const filteredRetry = frontmatterWithoutBlanks(frontmatter);
						const mergedOut = "---\n" + stringifyFrontmatter(filteredRetry) + "---\n\n" + (bodyOut || "");
						await this.app.vault.modify(existing, mergedOut);
						return;
					}
					if (!/already exists/i.test(errMsg)) break;
					await new Promise((r) => setTimeout(r, 30 + attempt * 20));
				}
				throw createErr instanceof Error ? createErr : new Error(`Could not create stats note at ${path}`);
			}
		}
	}

	async processMetricsToStatsNotes(metrics: any[]): Promise<number> {
		const byDate = new Map<string, Record<string, string | number>>();
		const collect = (dateStr: string, key: string, value: string | number) => {
			if (!byDate.has(dateStr)) byDate.set(dateStr, {});
			byDate.get(dateStr)![key] = value;
		};
		for (const m of metrics) {
			const name = m.name;
			if (!name) continue;
			const key = AUTOEXPORT_METRIC_TO_FRONTMATTER[String(name)] ?? toCamelCase(String(name));
			const points = Array.isArray(m.data) ? m.data : (m.date != null ? [m] : []);
			for (const p of points) {
				const dateStr = p.date ? String(p.date).trim().slice(0, 10) : "";
				if (!dateStr || dateStr.length < 10) continue;
				const qty = p.qty;
				if (qty === undefined || qty === null) continue;
				const num = typeof qty === "number" ? qty : parseFloat(String(qty));
				if (isNaN(num)) continue;
				// Round to 2 decimals for stable frontmatter (avoid long floats)
				const value = Math.round(num * 100) / 100;
				collect(dateStr, key, value);
			}
		}
		let count = 0;
		for (const [dateStr, updates] of byDate) {
			try {
				if (Object.keys(updates).length === 0) continue;
				const [y, m, d] = dateStr.split("-").map(Number);
				const date = new Date(y, m - 1, d);
				const { path } = await this.getOrCreateStatsNote(date);
				await this.mergeAndWriteStatsNote(path, updates, "");
				count++;
			} catch (err) {
				console.error(`Error writing stats note for ${dateStr}:`, err);
			}
		}
		return count;
	}

	async processSleepToStatsNotes(sleepAnalysis: any[]): Promise<number> {
		let count = 0;
		for (const s of sleepAnalysis) {
			try {
				const endStr = s.sleepEnd ?? s.inBedEnd;
				if (!endStr) continue;
				const dateStr = String(endStr).trim().slice(0, 10);
				if (dateStr.length < 10) continue;
				const [y, m, d] = dateStr.split("-").map(Number);
				const date = new Date(y, m - 1, d);
				const updates: Record<string, string | number> = {};
				if (s.sleepStart != null) updates["sleepStartTime"] = String(s.sleepStart);
				if (s.sleepEnd != null) updates["sleepEndTime"] = String(s.sleepEnd);
				if (s.inBedStart != null) updates["inBedStart"] = String(s.inBedStart);
				if (s.inBedEnd != null) updates["inBedEnd"] = String(s.inBedEnd);
				if (typeof s.totalSleep === "number") updates["timeAsleep"] = s.totalSleep;
				if (typeof s.deep === "number") updates["deepSleep"] = s.deep;
				if (typeof s.core === "number") updates["sleepCore"] = s.core;
				if (typeof s.rem === "number") updates["remSleep"] = s.rem;
				if (typeof s.awake === "number") updates["sleepAwake"] = s.awake;
				if (s.source != null) updates["source"] = String(s.source);
				const { path } = await this.getOrCreateStatsNote(date);
				await this.mergeAndWriteStatsNote(path, updates, "");
				count++;
			} catch (err) {
				console.error("Error writing sleep stats note:", err);
			}
		}
		return count;
	}

	async processFITINDEXToStatsNotes(rows: FITINDEXRow[]): Promise<number> {
		let count = 0;
		for (const row of rows) {
			try {
				if (!row.date) continue;
				const [y, m, d] = row.date.split("-").map(Number);
				const date = new Date(y, m - 1, d);
				const updates: Record<string, string | number> = {};
				if (row.weightLb != null) updates["weight"] = Math.round(row.weightLb * 100) / 100;
				else if (row.weightKg != null) updates["weight"] = Math.round(row.weightKg * KG_TO_LB * 100) / 100;
				if (row.bmi != null) updates["bmi"] = row.bmi;
				if (row.bodyFatPct != null) updates["bfp"] = row.bodyFatPct;
				if (row.fatFreeWeightLb != null) updates["lbm"] = Math.round(row.fatFreeWeightLb * 100) / 100;
				else if (row.fatFreeWeightKg != null) updates["lbm"] = Math.round(row.fatFreeWeightKg * KG_TO_LB * 100) / 100;
				if (row.subcutaneousFatPct != null) updates["subcutaneousFat"] = row.subcutaneousFatPct;
				if (row.visceralFat != null) updates["visceralFat"] = row.visceralFat;
				if (row.bodyWaterPct != null) updates["bodyWater"] = row.bodyWaterPct;
				if (row.skeletalMusclePct != null) updates["skeletalMuscle"] = row.skeletalMusclePct;
				if (row.muscleMassLb != null) updates["muscleMass"] = Math.round(row.muscleMassLb * 100) / 100;
				else if (row.muscleMassKg != null) updates["muscleMass"] = Math.round(row.muscleMassKg * KG_TO_LB * 100) / 100;
				if (row.boneMassLb != null) updates["boneMass"] = Math.round(row.boneMassLb * 100) / 100;
				else if (row.boneMassKg != null) updates["boneMass"] = Math.round(row.boneMassKg * KG_TO_LB * 100) / 100;
				if (row.proteinPct != null) updates["protein"] = row.proteinPct;
				if (row.bmrKcal != null) updates["bmr"] = row.bmrKcal;
				if (row.metabolicAge != null) updates["metabolicAge"] = row.metabolicAge;
				// RENPHO-only / extra fields
				if (row.bodyFatMassLb != null) updates["bodyFatMass"] = Math.round(row.bodyFatMassLb * 100) / 100;
				if (row.musclePct != null) updates["musclePct"] = row.musclePct;
				if (row.proteinMassLb != null) updates["proteinMass"] = Math.round(row.proteinMassLb * 100) / 100;
				if (row.bodyWaterMassLb != null) updates["bodyWaterMass"] = Math.round(row.bodyWaterMassLb * 100) / 100;
				if (row.whr != null) updates["whr"] = row.whr;
				if (row.optimalWeightLb != null) updates["optimalWeight"] = Math.round(row.optimalWeightLb * 100) / 100;
				if (row.weightLevel != null && row.weightLevel !== "") updates["weightLevel"] = row.weightLevel;
				if (row.bodyType != null && row.bodyType !== "") updates["bodyType"] = row.bodyType;
				const { path } = await this.getOrCreateStatsNote(date);
				await this.mergeAndWriteStatsNote(path, updates, "");
				count++;
			} catch (err) {
				console.error(`Error writing FITINDEX stats for ${row.date}:`, err);
			}
		}
		return count;
	}

	async processWorkout(workout: any, imageData?: string): Promise<string> {
		const workoutName = workout.name || "Unknown";
		const template = this.settings.templates.find(
			(t) => t.workoutType.toLowerCase() === workoutName.toLowerCase()
		);
		const templatePath = template?.templatePath || this.settings.defaultTemplatePath;
		if (!templatePath) {
			throw new Error(`No template found for workout type "${workoutName}" and no default template set`);
		}
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath) as TFile;
		if (!templateFile) {
			throw new Error(`Template file not found: ${templatePath}`);
		}
		const templateContent = await this.app.vault.read(templateFile);
		let workoutDate = workout.start ? new Date(workout.start) : new Date();
		if (isNaN(workoutDate.getTime())) workoutDate = new Date();
		const filePath = this.generateFilePath(workoutName, workoutDate);
		const pathParts = filePath.split("/");
		if (pathParts.length > 1) {
			const folderPath = pathParts.slice(0, -1).join("/");
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
		}
		// If the ideal path already exists, update that file (re-run = update, not duplicate)
		const existingAtPath = this.app.vault.getAbstractFileByPath(filePath);
		let finalFilePath: string;
		if (existingAtPath && "content" in existingAtPath) {
			finalFilePath = filePath;
		} else {
			// New file: use (1), (2) only if we collide within this run
			let counter = 1;
			finalFilePath = filePath;
			while (this.app.vault.getAbstractFileByPath(finalFilePath)) {
				const pathParts2 = filePath.split("/");
				const fileName = pathParts2[pathParts2.length - 1];
				const folderPath = pathParts2.slice(0, -1).join("/");
				const baseName = fileName.replace(".md", "");
				const newFileName = `${baseName} (${counter}).md`;
				finalFilePath = folderPath ? `${folderPath}/${newFileName}` : newFileName;
				counter++;
			}
		}
		// Use provided image or generate a banner from workout data (Apple Fitness style)
		const imageToSave = imageData ?? (await this.generateWorkoutBannerImage(workout));
		let relativeImagePath: string | undefined;
		let savedImageExtension: string | undefined;
		if (imageToSave) {
			savedImageExtension = await this.saveImage(imageToSave, finalFilePath);
			const pathPartsImg = finalFilePath.split("/");
			const noteFileName = pathPartsImg[pathPartsImg.length - 1].replace(".md", "");
			relativeImagePath = `assets/${noteFileName}.${savedImageExtension}`;
		}
		const mappedData: Record<string, any> = {};
		for (const mapping of this.settings.keyMappings) {
			if (!mapping.jsonKey || !mapping.yamlKey) continue;
			let value = this.getNestedValue(workout, mapping.jsonKey);
			if (value !== undefined && value !== null) {
				if (mapping.rounding !== undefined && typeof value === "number") {
					value = this.applyRounding(value, mapping.rounding);
				}
				mappedData[mapping.yamlKey] = value;
			}
		}
		if (this.settings.keyMappings.length === 0) {
			Object.assign(mappedData, workout);
		}
		// Always set date from workout start (YYYY-MM-DD) in addition to start/end
		const year = workoutDate.getFullYear();
		const month = (workoutDate.getMonth() + 1).toString().padStart(2, "0");
		const day = workoutDate.getDate().toString().padStart(2, "0");
		mappedData["date"] = `${year}-${month}-${day}`;
		// Stable ID so route data (routes/{id}.json, routes/{id}.png) stays linked even if note is renamed
		mappedData["workoutId"] = workoutIdFromWorkout(workout);
		const yamlFrontmatter = this.generateYAMLFrontmatter(
			mappedData,
			templatePath,
			relativeImagePath,
			workoutName
		);
		let bodyContent = templateContent;
		const workoutId = mappedData["workoutId"] as string;
		const workoutStartKey = this.getWorkoutStartKey(workout);
		if (workoutStartKey) {
			const hrFile = this.getHeartRateCsvFile(workoutName, workoutStartKey);
			if (hrFile) {
				try {
					const hrCsv = await this.app.vault.read(hrFile);
					const { labels, data } = this.parseHeartRateCsv(hrCsv);
					const chartBlock = this.buildChartsHeartRateBlock(labels, data);
					if (chartBlock) bodyContent = (templateContent.trim() ? templateContent + "\n\n" : "") + chartBlock;
				} catch (e) {
					console.warn("Failed to read/parse Heart Rate CSV for chart:", hrFile.path, e);
				}
			}
			// Route map: find Route CSV/GPX, save data and PNG in workout dir's routes/ folder, embed
			const workoutDir = finalFilePath.includes("/") ? finalFilePath.split("/").slice(0, -1).join("/") : "";
			const routesFolder = workoutDir ? `${workoutDir}/routes` : ROUTES_FOLDER;
			const routeFile = this.getRouteFile(workoutName, workoutStartKey);
			if (routeFile && workoutId) {
				try {
					const routeText = await this.app.vault.read(routeFile);
					const points =
						routeFile.extension.toLowerCase() === "gpx"
							? this.parseRouteGpx(routeText)
							: this.parseRouteCsv(routeText);
					if (points.length >= 2) {
						await this.saveRouteData(workoutId, points, routesFolder);
						const mapDataUrl = await this.generateRouteMapImage(points);
						if (mapDataUrl) {
							const routeImagePath = `${routesFolder}/${workoutId}.png`;
							await this.saveImageToPath(mapDataUrl, routeImagePath);
							const routeSection = `\n\n## Route\n\n![[${routeImagePath}]]\n`;
							bodyContent = bodyContent.trimEnd() + routeSection;
						}
					}
				} catch (e) {
					console.warn("Failed to process route for map:", routeFile.path, e);
				}
			}
		}
		const noteContent = `---\n${yamlFrontmatter}---\n\n${bodyContent}`;
		if (existingAtPath && "content" in existingAtPath) {
			await this.app.vault.modify(existingAtPath as unknown as TFile, noteContent);
		} else {
			await this.app.vault.create(finalFilePath, noteContent);
		}
		return finalFilePath;
	}

	generateFilePath(workoutName: string, workoutDate: Date): string {
		const template = this.settings.saveDestination || "{YYYY}/{MM}/{YYYYMMDD-HHMM}-{name}.md";
		const year = workoutDate.getFullYear().toString();
		const month = (workoutDate.getMonth() + 1).toString().padStart(2, "0");
		const day = workoutDate.getDate().toString().padStart(2, "0");
		const hours = workoutDate.getHours().toString().padStart(2, "0");
		const minutes = workoutDate.getMinutes().toString().padStart(2, "0");
		const dateTimeStr = `${year}${month}${day}-${hours}${minutes}`;
		const dateTimeStrHyphenated = `${year}-${month}-${day}-${hours}${minutes}`;
		const sanitizedName = workoutName.replace(/[<>:"/\\|?*]/g, "-");
		let filePath = template
			.replace(/{YYYY}/g, year)
			.replace(/{MM}/g, month)
			.replace(/{YYYYMMDD-HHMM}/g, dateTimeStr)
			.replace(/{YYYY-MM-DD-HHMM}/g, dateTimeStrHyphenated)
			.replace(/{name}/g, sanitizedName);
		if (!filePath.endsWith(".md")) filePath += ".md";
		return filePath;
	}

	/** Workout start as YYYYMMDD_HHMMSS for matching sensor filenames (e.g. Outdoor Walk-Heart Rate-20260208_151937.csv). */
	getWorkoutStartKey(workout: { start?: string }): string {
		const start = workout?.start;
		if (!start) return "";
		const d = new Date(start);
		if (isNaN(d.getTime())) return "";
		const y = d.getFullYear();
		const m = (d.getMonth() + 1).toString().padStart(2, "0");
		const day = d.getDate().toString().padStart(2, "0");
		const h = d.getHours().toString().padStart(2, "0");
		const min = d.getMinutes().toString().padStart(2, "0");
		const s = d.getSeconds().toString().padStart(2, "0");
		return `${y}${m}${day}_${h}${min}${s}`;
	}

	/** Find Heart Rate CSV for this workout under the scan folder (same place as decompressed ZIP contents). */
	getHeartRateCsvFile(workoutName: string, workoutStartKey: string): TFile | null {
		const scanFolder = (this.settings.scanFolderPath ?? "").trim();
		const prefix = `${workoutName}-Heart Rate-`;
		const allFiles = this.app.vault.getFiles();
		for (const f of allFiles) {
			if (f.extension !== "csv" || !f.name.startsWith(prefix)) continue;
			const inScope = !scanFolder || f.path === scanFolder || f.path.startsWith(scanFolder + "/");
			if (!inScope) continue;
			const stem = f.basename.slice(prefix.length);
			if (stem === workoutStartKey || stem.startsWith(workoutStartKey.slice(0, 12))) return f;
		}
		return null;
	}

	/** Find Route CSV or GPX for this workout under the scan folder. */
	getRouteFile(workoutName: string, workoutStartKey: string): TFile | null {
		const scanFolder = (this.settings.scanFolderPath ?? "").trim();
		const prefix = `${workoutName}-Route-`;
		const allFiles = this.app.vault.getFiles();
		for (const f of allFiles) {
			const ext = (f.extension || "").toLowerCase();
			if ((ext !== "csv" && ext !== "gpx") || !f.name.startsWith(prefix)) continue;
			const inScope = !scanFolder || f.path === scanFolder || f.path.startsWith(scanFolder + "/");
			if (!inScope) continue;
			const stem = f.basename.slice(prefix.length);
			if (stem === workoutStartKey || stem.startsWith(workoutStartKey.slice(0, 12))) return f;
		}
		return null;
	}

	/** Parse HealthAutoExport Route CSV: Timestamp, Latitude, Longitude, ..., Speed (m/s). */
	parseRouteCsv(csvText: string): RoutePoint[] {
		const points: RoutePoint[] = [];
		const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim());
		if (lines.length < 2) return points;
		const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
		const idxLat = headers.findIndex((h) => h.includes("latitude") || h === "lat");
		const idxLon = headers.findIndex((h) => h.includes("longitude") || h === "lon" || h === "lng");
		const idxSpeed = headers.findIndex((h) => h.includes("speed"));
		if (idxLat < 0 || idxLon < 0) return points;
		for (let i = 1; i < lines.length; i++) {
			const values = parseCsvLine(lines[i]);
			const lat = parseFloat(values[idxLat]);
			const lon = parseFloat(values[idxLon]);
			if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
			const speed = idxSpeed >= 0 && values[idxSpeed] !== undefined ? parseFloat(values[idxSpeed]) : 0;
			points.push({ lat, lon, speed: Number.isNaN(speed) ? 0 : speed });
		}
		return points;
	}

	/** Parse GPX track: trkpt with lat, lon, and optional extensions/speed. */
	parseRouteGpx(gpxText: string): RoutePoint[] {
		const points: RoutePoint[] = [];
		const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
		const speedRegex = /<speed>([^<]+)<\/speed>/i;
		let m: RegExpExecArray | null;
		while ((m = trkptRegex.exec(gpxText)) !== null) {
			const lat = parseFloat(m[1]);
			const lon = parseFloat(m[2]);
			if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
			const inner = m[3] || "";
			const speedMatch = inner.match(speedRegex);
			const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;
			points.push({ lat, lon, speed: Number.isNaN(speed) ? 0 : speed });
		}
		return points;
	}

	/** Parse HealthAutoExport Heart Rate CSV: Date/Time, Min, Max, Avg -> labels (time) and data (BPM). */
	parseHeartRateCsv(csvText: string): { labels: string[]; data: number[] } {
		const labels: string[] = [];
		const data: number[] = [];
		const lines = csvText.trim().split(/\r?\n/);
		if (lines.length < 2) return { labels, data };
		const header = lines[0].toLowerCase();
		const avgIdx = header.includes("avg") ? header.split(",").findIndex((c) => c.includes("avg")) : -1;
		const timeIdx = header.includes("date/time") ? 0 : header.split(",").findIndex((c) => c.includes("time"));
		for (let i = 1; i < lines.length; i++) {
			const parts = lines[i].split(",").map((p) => p.trim());
			const timeStr = timeIdx >= 0 && parts[timeIdx] ? parts[timeIdx].trim().slice(11, 19) : ""; // HH:MM:SS or similar
			const label = timeStr ? timeStr.slice(0, 5) : `${i}`; // "15:34"
			let bpm = NaN;
			if (avgIdx >= 0 && parts[avgIdx] !== undefined) bpm = parseFloat(parts[avgIdx]);
			else if (parts[1] !== undefined) bpm = parseFloat(parts[1]);
			if (!Number.isNaN(bpm)) {
				labels.push(label);
				data.push(Math.round(bpm));
			}
		}
		return { labels, data };
	}

	/** Build Obsidian Charts plugin code block for a heart rate line chart (data stays in note). */
	buildChartsHeartRateBlock(labels: string[], data: number[]): string {
		if (labels.length === 0 || data.length === 0) return "";
		const labelsYaml = labels.map((l) => `  - "${l}"`).join("\n");
		const dataArray = "[" + data.join(", ") + "]";
		return `## Heart Rate\n\n\`\`\`chart\ntype: line\nlabels:\n${labelsYaml}\nseries:\n  - title: Heart Rate (BPM)\n    fill: true\n    tension: 0.3\n    data: ${dataArray}\n\`\`\`\n`;
	}

	async ensureRoutesFolder(folder: string = ROUTES_FOLDER): Promise<void> {
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
	}

	/** Save route track data to {routesFolder}/{workoutId}.json for later use. */
	async saveRouteData(workoutId: string, points: RoutePoint[], routesFolder: string = ROUTES_FOLDER): Promise<void> {
		await this.ensureRoutesFolder(routesFolder);
		const path = `${routesFolder}/${workoutId}.json`;
		const content = JSON.stringify({ workoutId, points }, null, 0);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && "content" in existing) {
			await this.app.vault.modify(existing as TFile, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	/** Save image data URL to a vault path (e.g. routes/{workoutId}.png). */
	async saveImageToPath(imageDataUrl: string, vaultPath: string): Promise<void> {
		let base64Data = imageDataUrl;
		if (imageDataUrl.startsWith("data:image/")) {
			const match = imageDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
			if (match) base64Data = match[1];
		}
		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
		const existing = this.app.vault.getAbstractFileByPath(vaultPath);
		if (existing && "path" in existing) {
			await this.app.vault.modifyBinary(existing as TFile, bytes.buffer);
		} else {
			const pathParts = vaultPath.split("/");
			for (let i = 1; i < pathParts.length; i++) {
				const dirPath = pathParts.slice(0, i).join("/");
				if (!this.app.vault.getAbstractFileByPath(dirPath)) await this.app.vault.createFolder(dirPath);
			}
			await this.app.vault.createBinary(vaultPath, bytes.buffer);
		}
	}

	/** Build tile URL for current map style (Fiord, Carto Dark, or OSM). Fiord requires MapTiler API key. */
	private getMapTileUrl(z: number, x: number, y: number): string {
		const style = this.settings.mapTileStyle ?? "maptiler-fiord";
		const key = (this.settings.maptilerApiKey ?? "").trim();
		if (style === "maptiler-fiord" && key) {
			return `https://api.maptiler.com/tiles/fiord/${z}/${x}/${y}?key=${encodeURIComponent(key)}`;
		}
		if (style === "carto-dark" || (style === "maptiler-fiord" && !key)) {
			return `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
		}
		return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
	}

	/** Generate a static map image: 16:9, edge-to-edge tiles + route polyline colored by speed (blue→red). */
	async generateRouteMapImage(points: RoutePoint[]): Promise<string> {
		if (typeof document === "undefined" || points.length < 2) return "";
		const width = 960;
		const height = 540;
		const padding = 0;
		const TILE_SIZE = 256;
		const minLat = Math.min(...points.map((p) => p.lat));
		const maxLat = Math.max(...points.map((p) => p.lat));
		const minLon = Math.min(...points.map((p) => p.lon));
		const maxLon = Math.max(...points.map((p) => p.lon));
		const latSpan = maxLat - minLat || 0.0001;
		const lonSpan = maxLon - minLon || 0.0001;
		const drawWidth = width - padding * 2;
		const drawHeight = height - padding * 2;

		// Slippy map: lon/lat to tile-relative pixel at zoom z
		const latToY = (lat: number, z: number): number => {
			const latRad = (lat * Math.PI) / 180;
			const n = Math.pow(2, z);
			return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;
		};
		const lonToX = (lon: number, z: number): number => {
			const n = Math.pow(2, z);
			return ((lon + 180) / 360) * n * TILE_SIZE;
		};
		// Zoom so route fills the frame (no margin) for readability, then we scale map to fill canvas
		const midLat = (minLat + maxLat) / 2;
		const zoomForLon = Math.log2((drawWidth / TILE_SIZE) * (360 / lonSpan));
		const zoomForLat = Math.log2((drawHeight / TILE_SIZE) * (180 / (latSpan || 0.0001)) * Math.cos((midLat * Math.PI) / 180));
		const z = Math.max(1, Math.min(19, Math.floor(Math.min(zoomForLon, zoomForLat))));
		const minTileX = Math.floor(lonToX(minLon, z) / TILE_SIZE);
		const maxTileX = Math.floor(lonToX(maxLon, z) / TILE_SIZE);
		const minTileY = Math.floor(latToY(maxLat, z) / TILE_SIZE);
		const maxTileY = Math.floor(latToY(minLat, z) / TILE_SIZE);
		const offsetX = padding - minTileX * TILE_SIZE;
		const offsetY = padding - minTileY * TILE_SIZE;
		const mapWidth = (maxTileX - minTileX + 1) * TILE_SIZE;
		const mapHeight = (maxTileY - minTileY + 1) * TILE_SIZE;
		const scale = Math.max(width / mapWidth, height / mapHeight);
		const translateX = (width - mapWidth * scale) / 2;
		const translateY = (height - mapHeight * scale) / 2;

		const speeds = points.map((p) => p.speed).filter((s) => s > 0);
		const minSpeed = speeds.length ? Math.min(...speeds) : 0;
		const maxSpeed = speeds.length ? Math.max(...speeds) : 1;
		const speedRange = maxSpeed - minSpeed || 1;
		const speedToColor = (s: number): string => {
			const t = (s - minSpeed) / speedRange;
			if (t <= 0.33) {
				const u = t / 0.33;
				return `rgb(${Math.round(0 + u * 0)}, ${Math.round(0 + u * 128)}, ${Math.round(255 - u * 128)})`;
			}
			if (t <= 0.66) {
				const u = (t - 0.33) / 0.33;
				return `rgb(${Math.round(0 + u * 255)}, 255, ${Math.round(128 - u * 128)})`;
			}
			const u = (t - 0.66) / 0.34;
			return `rgb(255, ${Math.round(255 - u * 255)}, 0)`;
		};

		const toX = (lon: number) => offsetX + lonToX(lon, z);
		const toY = (lat: number) => offsetY + latToY(lat, z);

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "";
		ctx.fillStyle = "#1a1a2e";
		ctx.fillRect(0, 0, width, height);

		// Draw map + route on offscreen canvas at native map size, then scale to fill 16:9 edge-to-edge
		const offscreen = document.createElement("canvas");
		offscreen.width = mapWidth;
		offscreen.height = mapHeight;
		const offCtx = offscreen.getContext("2d");
		if (!offCtx) return canvas.toDataURL("image/png");
		offCtx.fillStyle = "#1a1a2e";
		offCtx.fillRect(0, 0, mapWidth, mapHeight);

		const tilesToFetch: { x: number; y: number }[] = [];
		for (let tx = minTileX; tx <= maxTileX; tx++) {
			for (let ty = minTileY; ty <= maxTileY; ty++) {
				tilesToFetch.push({ x: tx, y: ty });
			}
		}
		let tilesOk = true;
		const needsOsmUserAgent = this.getMapTileUrl(z, 0, 0).startsWith("https://tile.openstreetmap.org");
		await Promise.all(
			tilesToFetch.map(async (t) => {
				const url = this.getMapTileUrl(z, t.x, t.y);
				try {
					const init: RequestInit = {};
					if (needsOsmUserAgent) {
						(init as any).headers = { "User-Agent": "ObsidianWorkoutImporter/1.0 (static map for personal notes)" };
					}
					const res = await fetch(url, init);
					if (!res.ok) {
						tilesOk = false;
						return;
					}
					const blob = await res.blob();
					const img = await createImageBitmap(blob);
					const dx = offsetX + t.x * TILE_SIZE;
					const dy = offsetY + t.y * TILE_SIZE;
					offCtx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
					img.close();
				} catch {
					tilesOk = false;
				}
			})
		);
		if (!tilesOk) {
			offCtx.fillStyle = "#1a1a2e";
			offCtx.fillRect(0, 0, mapWidth, mapHeight);
		}

		for (let i = 0; i < points.length - 1; i++) {
			const a = points[i];
			const b = points[i + 1];
			const avgSpeed = (a.speed + b.speed) / 2;
			offCtx.strokeStyle = speedToColor(avgSpeed);
			offCtx.lineWidth = 4;
			offCtx.lineCap = "round";
			offCtx.lineJoin = "round";
			offCtx.beginPath();
			offCtx.moveTo(toX(a.lon), toY(a.lat));
			offCtx.lineTo(toX(b.lon), toY(b.lat));
			offCtx.stroke();
		}

		ctx.drawImage(offscreen, 0, 0, mapWidth, mapHeight, translateX, translateY, mapWidth * scale, mapHeight * scale);
		return canvas.toDataURL("image/png");
	}

	/** Resolve workout type name to activity icon filename (no extension). Checks map first, then any icon file whose name is a substring of the workout name (or vice versa). */
	async getIconNameForWorkout(workoutName: string): Promise<string> {
		const key = (workoutName || "").toLowerCase().trim();
		if (WORKOUT_TYPE_TO_ICON[key]) return WORKOUT_TYPE_TO_ICON[key];
		for (const [pattern, icon] of Object.entries(WORKOUT_TYPE_TO_ICON)) {
			if (key.includes(pattern) || pattern.includes(key)) return icon;
		}
		// Match any icon file where the file name (no extension) is contained in the workout name or vice versa
		const folder = this.app.vault.getAbstractFileByPath(ACTIVITY_ICONS_FOLDER);
		if (folder && "children" in folder) {
			const candidates: { base: string; len: number }[] = [];
			for (const child of (folder as TFolder).children) {
				if (child instanceof TFile && child.extension === "png") {
					const base = child.basename.toLowerCase();
					if (!base) continue;
					const nameMatches = key.includes(base) || base.includes(key);
					if (nameMatches) candidates.push({ base: child.basename, len: base.length });
				}
			}
			// Prefer longest match (e.g. "fitbod" over "fit")
			if (candidates.length) {
				candidates.sort((a, b) => b.len - a.len);
				return candidates[0].base;
			}
		}
		return "other";
	}

	/** Load activity icon as image URL for canvas (vault path). Returns null if not found. */
	getActivityIconUrl(iconName: string): string | null {
		const path = `${ACTIVITY_ICONS_FOLDER}/${iconName}.png`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file && "path" in file) return this.app.vault.getResourcePath(file as TFile);
		return null;
	}

	/** Generate an Apple Fitness–style banner: dark card, circular icon, workout name, Active Calories (pink), Total Time (yellow). */
	async generateWorkoutBannerImage(workout: any): Promise<string> {
		if (typeof document === "undefined") return "";
		const name = workout?.name || "Workout";
		const durationSec = workout?.duration ?? workout?.duration_qty;
		const durationSecNum = typeof durationSec === "number" ? durationSec : 0;
		const minutes = Math.floor(durationSecNum / 60);
		const seconds = Math.floor(durationSecNum % 60);
		const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`;
		const calories = workout?.activeEnergyBurned?.qty ?? workout?.activeEnergyBurned ?? workout?.calories;
		const calNum = typeof calories === "number" ? Math.round(calories) : 0;

		const width = 640;
		const height = 200;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "";

		const iconName = await this.getIconNameForWorkout(name);
		const iconUrl = this.getActivityIconUrl(iconName);

		const drawCard = (img: HTMLImageElement | null) => {
			// Dark background (Apple-style)
			ctx.fillStyle = "#0d0d0d";
			ctx.fillRect(0, 0, width, height);

			const padding = 24;
			const circleR = 32;
			const circleY = 52;
			const gap = 16;

			// Center the icon + title group (Obsidian crops from center, so keep content centered)
			ctx.font = "bold 24px system-ui, -apple-system, sans-serif";
			const nameWidth = ctx.measureText(name).width;
			const titleGroupWidth = circleR * 2 + gap + nameWidth;
			const startX = (width - titleGroupWidth) / 2;
			const circleX = startX + circleR;
			const nameX = startX + circleR * 2 + gap;

			// Circular icon background (dark green)
			ctx.beginPath();
			ctx.arc(circleX, circleY, circleR, 0, Math.PI * 2);
			ctx.fillStyle = "#1a3d1a";
			ctx.fill();

			if (img && img.width > 0) {
				ctx.save();
				ctx.beginPath();
				ctx.arc(circleX, circleY, circleR - 3, 0, Math.PI * 2);
				ctx.closePath();
				ctx.clip();
				const iconSize = (circleR - 3) * 2;
				ctx.drawImage(img, circleX - iconSize / 2, circleY - iconSize / 2, iconSize, iconSize);
				ctx.restore();
			}

			// Workout name (bold white), centered with icon
			ctx.fillStyle = "#ffffff";
			ctx.textBaseline = "middle";
			ctx.fillText(name, nameX, circleY);

			// Divider line (full width)
			const dividerY = height - 68;
			ctx.strokeStyle = "rgba(255,255,255,0.12)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(padding, dividerY);
			ctx.lineTo(width - padding, dividerY);
			ctx.stroke();

			// Metrics row: calories right-aligned in left half, time left-aligned in right half (meet in middle)
			const metricY = dividerY + 36;
			const centerX = width / 2;
			const metricGap = 20;

			// Active Calories (right-aligned, so it meets the center)
			ctx.textAlign = "right";
			ctx.fillStyle = "rgba(255,255,255,0.6)";
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillText("Active Calories", centerX - metricGap, metricY - 20);
			ctx.fillStyle = "#ff375f";
			ctx.font = "bold 24px system-ui, sans-serif";
			const calText = calNum.toString();
			const calWidth = ctx.measureText(calText).width;
			ctx.fillText(calText, centerX - metricGap, metricY + 2);
			ctx.font = "14px system-ui, sans-serif";
			ctx.fillText("CAL", centerX - metricGap - calWidth - 8, metricY + 2);

			// Total Time (left-aligned from center)
			ctx.textAlign = "left";
			ctx.fillStyle = "rgba(255,255,255,0.6)";
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillText("Total Time", centerX + metricGap, metricY - 20);
			ctx.fillStyle = "#ffd60a";
			ctx.font = "bold 24px system-ui, sans-serif";
			ctx.fillText(timeStr, centerX + metricGap, metricY + 2);

			ctx.textAlign = "left";
		};

		if (iconUrl) {
			return new Promise((resolve) => {
				const img = new Image();
				img.onload = () => {
					drawCard(img);
					try {
						resolve(canvas.toDataURL("image/png"));
					} catch {
						resolve("");
					}
				};
				img.onerror = () => {
					drawCard(null);
					try {
						resolve(canvas.toDataURL("image/png"));
					} catch {
						resolve("");
					}
				};
				img.src = iconUrl;
			});
		}

		drawCard(null);
		try {
			return canvas.toDataURL("image/png");
		} catch {
			return "";
		}
	}

	async saveImage(imageData: string, noteFilePath: string): Promise<string> {
		let base64Data = imageData;
		let extension = "png";
		if (imageData.startsWith("data:image/")) {
			const match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
			if (match) {
				extension = match[1];
				base64Data = match[2];
			}
		}
		const pathParts = noteFilePath.split("/");
		const noteFileName = pathParts[pathParts.length - 1].replace(".md", "");
		const folderPath = pathParts.slice(0, -1).join("/");
		const assetsFolderPath = folderPath ? `${folderPath}/assets` : "assets";
		const imagePath = `${assetsFolderPath}/${noteFileName}.${extension}`;
		if (!this.app.vault.getAbstractFileByPath(assetsFolderPath)) {
			await this.app.vault.createFolder(assetsFolderPath);
		}
		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		const existingImage = this.app.vault.getAbstractFileByPath(imagePath);
		if (existingImage && "path" in existingImage) {
			await this.app.vault.modifyBinary(existingImage as TFile, bytes.buffer);
		} else {
			await this.app.vault.createBinary(imagePath, bytes.buffer);
		}
		return extension;
	}

	/** Build a minimal workout-like object from a note's frontmatter for banner generation. */
	workoutFromFrontmatter(fm: Record<string, string | number>): any {
		const name = fm.name;
		const duration = fm.duration;
		const calories = fm.calories;
		return {
			name: typeof name === "string" ? name : "Workout",
			duration: typeof duration === "number" ? duration : undefined,
			activeEnergyBurned: typeof calories === "number" ? { qty: calories } : undefined,
			calories: typeof calories === "number" ? calories : undefined,
			start: fm.startTime ?? fm.start,
		};
	}

	/** True if frontmatter looks like a workout note (has name + at least one workout metric). */
	isWorkoutNoteFrontmatter(fm: Record<string, string | number>): boolean {
		if (!fm.name || typeof fm.name !== "string") return false;
		return (
			fm.duration != null ||
			fm.calories != null ||
			fm.startTime != null ||
			fm.start != null
		);
	}

	/** Update the banner for a single workout note: regenerate image, save, update frontmatter. */
	async updateBannerForNote(file: TFile): Promise<boolean> {
		const content = await this.app.vault.read(file);
		const { frontmatter, body } = parseFrontmatter(content);
		if (!this.isWorkoutNoteFrontmatter(frontmatter)) return false;
		const workout = this.workoutFromFrontmatter(frontmatter);
		const imageDataUrl = await this.generateWorkoutBannerImage(workout);
		if (!imageDataUrl) return false;
		const ext = await this.saveImage(imageDataUrl, file.path);
		const noteBaseName = file.basename.replace(/\.md$/i, "");
		const relativeImagePath = `assets/${noteBaseName}.${ext}`;
		const merged = { ...frontmatter, banner: `[[${relativeImagePath}]]` };
		const filtered = frontmatterWithoutBlanks(merged);
		const newContent = "---\n" + stringifyFrontmatter(filtered) + "---\n\n" + (body || "");
		await this.app.vault.modify(file, newContent);
		return true;
	}

	/** Update banner for the currently active note (if it's a workout note). */
	async updateBannerForActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note.");
			return;
		}
		if (file.extension !== "md") {
			new Notice("Active file is not a markdown note.");
			return;
		}
		try {
			const updated = await this.updateBannerForNote(file);
			if (updated) new Notice("Banner updated.");
			else new Notice("This note doesn't look like a workout note (needs name + duration/calories/start).");
		} catch (e) {
			console.error(e);
			new Notice("Failed to update banner: " + (e instanceof Error ? e.message : String(e)));
		}
	}

	/** Find all workout notes in the vault and update their banners. */
	async updateAllBanners(): Promise<{ updated: number; skipped: number; errors: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let updated = 0;
		let skipped = 0;
		let errors = 0;
		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				const { frontmatter } = parseFrontmatter(content);
				if (!this.isWorkoutNoteFrontmatter(frontmatter)) {
					skipped++;
					continue;
				}
				const ok = await this.updateBannerForNote(file);
				if (ok) updated++;
				else skipped++;
			} catch {
				errors++;
			}
		}
		return { updated, skipped, errors };
	}

	applyRounding(value: number, rounding: number): number {
		if (rounding < 0) return value;
		const decimalPlaces = (value.toString().split(".")[1] || "").length;
		if (decimalPlaces <= rounding) return value;
		const factor = Math.pow(10, rounding);
		return Math.round(value * factor) / factor;
	}

	getNestedValue(obj: any, path: string): any {
		const keys = path.split(".");
		let value = obj;
		for (const key of keys) {
			if (value === null || value === undefined) return undefined;
			value = value[key];
		}
		return value;
	}

	generateYAMLFrontmatter(
		data: Record<string, any>,
		templatePath: string,
		relativeImagePath?: string,
		workoutName?: string
	): string {
		const lines: string[] = [];
		for (const [key, value] of Object.entries(data)) {
			if (value === null || value === undefined) continue;
			if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
				if (value.qty !== undefined) {
					lines.push(`${key}: ${this.formatYAMLValue(value.qty)}`);
					if (value.units) lines.push(`${key}Units: ${this.formatYAMLValue(value.units)}`);
				} else {
					lines.push(`${key}: ${this.formatYAMLValue(JSON.stringify(value))}`);
				}
			} else {
				lines.push(`${key}: ${this.formatYAMLValue(value)}`);
			}
		}
		for (const field of this.settings.additionalFrontMatter) {
			if (!field.key) continue;
			// Skip banner here; we add a single banner line below so we don't duplicate or double-escape
			if (field.key.trim().toLowerCase() === "banner") continue;
			const resolvedValue = this.resolveTemplateVariables(
				field.value,
				templatePath,
				relativeImagePath,
				workoutName
			);
			if (resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== "") {
				lines.push(`${field.key}: ${this.formatYAMLValue(resolvedValue)}`);
			}
		}
		// Single banner line: wikilink to assets image (no duplicate key, proper YAML escaping)
		if (relativeImagePath) {
			const wikilink = `[[${relativeImagePath}]]`;
			lines.push(`banner: ${this.formatYAMLValue(wikilink)}`);
		}
		// Workout type as wikilink for globalType (e.g. [[Outdoor Walk]])
		if (workoutName) {
			lines.push(`globalType: ${this.formatYAMLValue(`[[${workoutName}]]`)}`);
		}
		return lines.join("\n") + "\n";
	}

	resolveTemplateVariables(
		value: string,
		templatePath: string,
		relativeImagePath?: string,
		workoutName?: string
	): string {
		let resolved = value;
		if (relativeImagePath) resolved = resolved.replace(/{image}/g, relativeImagePath);
		else resolved = resolved.replace(/{image}/g, "");
		resolved = resolved.replace(/{template}/g, templatePath);
		if (workoutName) resolved = resolved.replace(/{name}/g, workoutName);
		return resolved;
	}

	formatYAMLValue(value: any): string {
		if (typeof value === "string") {
			// Quote if contains special chars or wikilinks [[...]] so YAML doesn't parse brackets as array
			if (value.includes("[[") || value.includes(":") || value.includes('"') || value.includes("'") || value.includes("\n")) {
				return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			}
			return value;
		}
		if (typeof value === "number") return value.toString();
		if (typeof value === "boolean") return value.toString();
		if (value instanceof Date) return value.toISOString();
		return String(value);
	}
}

class WorkoutImporterSettingTab extends PluginSettingTab {
	plugin: WorkoutImporterPlugin;

	constructor(app: App, plugin: WorkoutImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl("h2", { text: "Pulse Settings" });

		// Scan folder (for "Scan for Health and Workout Imports" command)
		containerEl.createEl("h3", { text: "Scan for Imports" });
		new Setting(containerEl)
			.setName("Folder to scan")
			.setDesc("Folder path to scan for JSON (AutoExport), body comp CSV (FITINDEX or RENPHO), and Workouts CSV. Leave empty to scan the whole vault.")
			.addText((text) => {
				text.setPlaceholder("e.g. Health Imports or leave empty")
					.setValue(this.plugin.settings.scanFolderPath ?? "")
					.onChange(async (value) => {
						this.plugin.settings.scanFolderPath = value ?? "";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Move to trash after import")
			.setDesc("After successfully processing a file, move it to the vault .trash folder (can be restored).")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.deleteSourceAfterImport ?? true)
					.onChange(async (value) => {
						this.plugin.settings.deleteSourceAfterImport = value;
						await this.plugin.saveSettings();
					});
			});

		// Route maps (basemap style)
		containerEl.createEl("h3", { text: "Route maps" });
		new Setting(containerEl)
			.setName("Map style")
			.setDesc("Basemap style for workout route images. Fiord (dark blue) requires a free MapTiler API key.")
			.addDropdown((drop) => {
				drop
					.addOption("maptiler-fiord", "Fiord (dark blue, MapTiler)")
					.addOption("carto-dark", "Carto Dark (dark, no key)")
					.addOption("osm", "OpenStreetMap (light)")
					.setValue(this.plugin.settings.mapTileStyle ?? "maptiler-fiord")
					.onChange(async (value) => {
						this.plugin.settings.mapTileStyle = value as "osm" | "carto-dark" | "maptiler-fiord";
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("MapTiler API key")
			.setDesc("Required for Fiord style. Get a free key at cloud.maptiler.com. Leave empty to use Carto Dark when Fiord is selected.")
			.addText((text) => {
				text.setPlaceholder("optional")
					.setValue(this.plugin.settings.maptilerApiKey ?? "")
					.onChange(async (value) => {
						this.plugin.settings.maptilerApiKey = value ?? "";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Stats note path")
			.setDesc("Where to create/update daily stats from AutoExport and FITINDEX. Variables: {year}, {month}, {date} (YYYY-MM-DD). Use a path that is not your daily note.")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_STATS_PATH_TEMPLATE)
					.setValue(this.plugin.settings.statsNotePathTemplate ?? DEFAULT_STATS_PATH_TEMPLATE)
					.onChange(async (value) => {
						this.plugin.settings.statsNotePathTemplate = value?.trim() || DEFAULT_STATS_PATH_TEMPLATE;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Stats note body template")
			.setDesc("Optional note whose contents are added below the frontmatter for new stats notes. Leave empty for no body.")
			.addText((text) => {
				text.setPlaceholder("e.g. Templates/Stats body.md")
					.setValue(this.plugin.settings.statsNoteBodyTemplatePath ?? "")
					.onChange(async (value) => {
						this.plugin.settings.statsNoteBodyTemplatePath = value ?? "";
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) =>
				button.setButtonText("Browse").onClick(() => {
					const files = this.app.vault.getMarkdownFiles();
					const modal = new FilePickerModal(this.app, files, async (selectedFile) => {
						if (selectedFile) {
							this.plugin.settings.statsNoteBodyTemplatePath = selectedFile.path;
							await this.plugin.saveSettings();
							this.display();
						}
					});
					modal.open();
				})
			);

		// Save Destination Section
		containerEl.createEl("h3", { text: "Save Destination" });
		new Setting(containerEl)
			.setName("Save destination template")
			.setDesc("Template path with variables: {YYYY}, {MM}, {YYYYMMDD-HHMM} or {YYYY-MM-DD-HHMM} (date-time), {name} (workout name)")
			.addText((text) => {
				text.setPlaceholder("Workouts/{YYYY}/{MM}/{YYYY-MM-DD-HHMM}-{name}.md")
					.setValue(this.plugin.settings.saveDestination)
					.onChange(async (value) => {
						this.plugin.settings.saveDestination = value;
						await this.plugin.saveSettings();
					});
			});

		// Workout banners
		containerEl.createEl("h3", { text: "Workout banners" });
		new Setting(containerEl)
			.setName("Update all banners")
			.setDesc("Regenerate banner images for all workout notes in the vault (replaces existing banners).")
			.addButton((btn) =>
				btn.setButtonText("Update all banners").onClick(async () => {
					btn.setDisabled(true);
					try {
						const result = await this.plugin.updateAllBanners();
						new Notice(
							`Banners: ${result.updated} updated, ${result.skipped} skipped, ${result.errors} error(s)`
						);
					} finally {
						btn.setDisabled(false);
					}
				})
			);

		// Default Template Section
		containerEl.createEl("h3", { text: "Default Template" });
		new Setting(containerEl)
			.setName("Default template path")
			.setDesc("Template file to use when no workout type matches")
			.addText((text) => {
				text.setPlaceholder("path/to/template.md")
					.setValue(this.plugin.settings.defaultTemplatePath)
					.onChange(async (value) => {
						this.plugin.settings.defaultTemplatePath = value;
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) =>
				button.setButtonText("Browse").onClick(async () => {
					const files = this.app.vault.getMarkdownFiles();
					const modal = new FilePickerModal(this.app, files, (selectedFile) => {
						if (selectedFile) {
							this.plugin.settings.defaultTemplatePath = selectedFile.path;
							this.plugin.saveSettings();
							this.display(); // Refresh the settings
						}
					});
					modal.open();
				})
			);

		// Key Mappings Section (workout pages only)
		containerEl.createEl("h3", { text: "Workout pages: JSON to YAML key mappings" });
		
		const mappingsDesc = containerEl.createEl("p", {
			text: "Only for workout notes (not stats notes). Map workout JSON keys to YAML frontmatter. Rounding: decimal places (0 = whole numbers, 1 = tenths, etc.).",
		});
		mappingsDesc.style.marginBottom = "10px";
		
		const resetLink = containerEl.createEl("a", {
			text: "Reset to defaults",
			href: "#",
		});
		resetLink.style.fontSize = "0.9em";
		resetLink.style.color = "var(--text-accent)";
		resetLink.style.cursor = "pointer";
		resetLink.style.marginBottom = "10px";
		resetLink.addEventListener("click", async (e) => {
			e.preventDefault();
			this.plugin.settings.keyMappings = [...DEFAULT_SETTINGS.keyMappings];
			await this.plugin.saveSettings();
			this.display();
		});

		const keyMappingsContainer = containerEl.createDiv("key-mappings-container");
		this.renderKeyMappings(keyMappingsContainer);

		const addMappingButton = containerEl.createEl("button", {
			text: "+ Add Mapping",
			cls: "mod-cta",
		});
		addMappingButton.addEventListener("click", () => {
			this.plugin.settings.keyMappings.push({
				jsonKey: "",
				yamlKey: "",
				rounding: undefined,
			});
			this.plugin.saveSettings();
			this.display();
		});

		// Additional Front Matter Section (workout pages only)
		containerEl.createEl("h3", { text: "Workout pages: Additional front matter" });
		containerEl.createEl("p", {
			text: "Only for workout notes (not stats notes). Add custom front matter fields. Values support template variables: {image}, {template}, {name}, etc.",
		});

		const additionalFrontMatterContainer = containerEl.createDiv("additional-frontmatter-container");
		this.renderAdditionalFrontMatter(additionalFrontMatterContainer);

		const addFrontMatterButton = containerEl.createEl("button", {
			text: "+ Add Front Matter Field",
			cls: "mod-cta",
		});
		addFrontMatterButton.addEventListener("click", () => {
			this.plugin.settings.additionalFrontMatter.push({
				key: "",
				value: "",
			});
			this.plugin.saveSettings();
			this.display();
		});

		// Templates Section
		containerEl.createEl("h3", { text: "Workout Type Templates" });
		containerEl.createEl("p", {
			text: "Define templates for specific workout types",
		});

		const templatesContainer = containerEl.createDiv("templates-container");
		this.renderTemplates(templatesContainer);

		const addTemplateButton = containerEl.createEl("button", {
			text: "+ Add Template",
			cls: "mod-cta",
		});
		addTemplateButton.addEventListener("click", () => {
			this.plugin.settings.templates.push({
				workoutType: "",
				templatePath: "",
			});
			this.plugin.saveSettings();
			this.display();
		});
	}

	renderKeyMappings(container: HTMLElement): void {
		container.empty();
		
		if (this.plugin.settings.keyMappings.length === 0) {
			container.createEl("p", {
				text: "No mappings yet. Click '+ Add Mapping' to add one.",
				cls: "setting-item-description",
			});
			return;
		}

		this.plugin.settings.keyMappings.forEach((mapping, index) => {
			const row = container.createDiv("key-mapping-row");
			row.style.display = "flex";
			row.style.alignItems = "center";
			row.style.gap = "10px";
			row.style.marginBottom = "10px";
			
			// JSON Key input
			const jsonInput = row.createEl("input", {
				type: "text",
				cls: "setting-input",
				value: mapping.jsonKey,
				placeholder: "JSON key",
			});
			jsonInput.style.flex = "1";
			jsonInput.addEventListener("input", async (e) => {
				const value = (e.target as HTMLInputElement).value;
				this.plugin.settings.keyMappings[index].jsonKey = value;
				await this.plugin.saveSettings();
			});

			// YAML Key input
			const yamlInput = row.createEl("input", {
				type: "text",
				cls: "setting-input",
				value: mapping.yamlKey,
				placeholder: "YAML key",
			});
			yamlInput.style.flex = "1";
			yamlInput.addEventListener("input", async (e) => {
				const value = (e.target as HTMLInputElement).value;
				this.plugin.settings.keyMappings[index].yamlKey = value;
				await this.plugin.saveSettings();
			});

			// Rounding input
			const roundingInput = row.createEl("input", {
				type: "number",
				cls: "setting-input",
				value: mapping.rounding !== undefined ? mapping.rounding.toString() : "",
				placeholder: "Rounding",
				attr: {
					min: "0",
					step: "1",
				},
			});
			roundingInput.style.width = "80px";
			roundingInput.style.flexShrink = "0";
			roundingInput.addEventListener("input", async (e) => {
				const value = (e.target as HTMLInputElement).value;
				const numValue = value === "" ? undefined : parseInt(value, 10);
				if (numValue !== undefined && (isNaN(numValue) || numValue < 0)) {
					return; // Invalid input, don't update
				}
				this.plugin.settings.keyMappings[index].rounding = numValue;
				await this.plugin.saveSettings();
			});

			// Remove button
			const removeButton = row.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Remove" },
			});
			removeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
			removeButton.addEventListener("click", async () => {
				this.plugin.settings.keyMappings.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}

	renderAdditionalFrontMatter(container: HTMLElement): void {
		container.empty();
		
		if (this.plugin.settings.additionalFrontMatter.length === 0) {
			container.createEl("p", {
				text: "No additional front matter fields yet. Click '+ Add Front Matter Field' to add one.",
				cls: "setting-item-description",
			});
			return;
		}

		this.plugin.settings.additionalFrontMatter.forEach((field, index) => {
			const row = container.createDiv("frontmatter-row");
			row.style.display = "flex";
			row.style.alignItems = "center";
			row.style.gap = "10px";
			row.style.marginBottom = "10px";
			
			// Key input
			const keyInput = row.createEl("input", {
				type: "text",
				cls: "setting-input",
				value: field.key,
				placeholder: "Key",
			});
			keyInput.style.flex = "1";
			keyInput.style.maxWidth = "200px";
			keyInput.addEventListener("input", async (e) => {
				const value = (e.target as HTMLInputElement).value;
				this.plugin.settings.additionalFrontMatter[index].key = value;
				await this.plugin.saveSettings();
			});

			// Value input
			const valueInput = row.createEl("input", {
				type: "text",
				cls: "setting-input",
				value: field.value,
				placeholder: "Value (supports {image}, {template}, etc.)",
			});
			valueInput.style.flex = "1";
			valueInput.addEventListener("input", async (e) => {
				const value = (e.target as HTMLInputElement).value;
				this.plugin.settings.additionalFrontMatter[index].value = value;
				await this.plugin.saveSettings();
			});

			// Remove button
			const removeButton = row.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Remove" },
			});
			removeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
			removeButton.addEventListener("click", async () => {
				this.plugin.settings.additionalFrontMatter.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}

	renderTemplates(container: HTMLElement): void {
		container.empty();
		
		if (this.plugin.settings.templates.length === 0) {
			container.createEl("p", {
				text: "No templates yet. Click '+ Add Template' to add one.",
				cls: "setting-item-description",
			});
			return;
		}

		this.plugin.settings.templates.forEach((template, index) => {
			const row = container.createDiv("template-row");
			row.style.display = "flex";
			row.style.alignItems = "center";
			row.style.gap = "10px";
			row.style.marginBottom = "10px";
			
			// Workout type input
			const workoutTypeInput = row.createEl("input", {
				type: "text",
				cls: "setting-input",
				value: template.workoutType,
				placeholder: "Workout type (e.g., Yoga, Running)",
			});
			workoutTypeInput.style.flex = "1";
			workoutTypeInput.style.maxWidth = "200px";
			workoutTypeInput.addEventListener("input", async (e) => {
				const value = (e.target as HTMLInputElement).value;
				this.plugin.settings.templates[index].workoutType = value;
				await this.plugin.saveSettings();
			});

			// Template path input (clickable to select file)
			const templatePathInput = row.createEl("input", {
				type: "text",
				cls: "setting-input",
				value: template.templatePath,
				placeholder: "Click to select template file",
			});
			templatePathInput.style.flex = "1";
			templatePathInput.style.cursor = "pointer";
			templatePathInput.readOnly = true;
			templatePathInput.addEventListener("click", async () => {
				const files = this.app.vault.getMarkdownFiles();
				const modal = new FilePickerModal(this.app, files, (selectedFile) => {
					if (selectedFile) {
						this.plugin.settings.templates[index].templatePath = selectedFile.path;
						this.plugin.saveSettings();
						this.display();
					}
				});
				modal.open();
			});

			// Remove button
			const removeButton = row.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Remove" },
			});
			removeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
			removeButton.addEventListener("click", async () => {
				this.plugin.settings.templates.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}
}

// File picker modal
class FilePickerModal extends Modal {
	files: TFile[];
	onSelect: (file: TFile) => void;

	constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onSelect = onSelect;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Select Template File" });

		const fileList = contentEl.createDiv("file-picker-list");
		fileList.style.maxHeight = "400px";
		fileList.style.overflowY = "auto";
		
		this.files.forEach((file) => {
			const fileItem = fileList.createDiv("file-picker-item");
			fileItem.style.padding = "8px";
			fileItem.style.cursor = "pointer";
			fileItem.style.borderBottom = "1px solid var(--background-modifier-border)";
			fileItem.createEl("div", { text: file.path });
			fileItem.addEventListener("click", () => {
				this.onSelect(file);
				this.close();
			});
			fileItem.addEventListener("mouseenter", () => {
				fileItem.style.backgroundColor = "var(--background-modifier-hover)";
			});
			fileItem.addEventListener("mouseleave", () => {
				fileItem.style.backgroundColor = "transparent";
			});
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// (ImportWorkoutModal removed — use "Scan for Health and Workout Imports" command)