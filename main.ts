import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";

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

// --- FITINDEX CSV structure (scale body composition) ---
export interface FITINDEXRow {
	date: string; // YYYY-MM-DD
	time: string;
	weightKg?: number;
	weightLb?: number;
	bmi?: number;
	bodyFatPct?: number;
	fatFreeWeightKg?: number;
	fatFreeWeightLb?: number;
	subcutaneousFatPct?: number;
	visceralFat?: number;
	bodyWaterPct?: number;
	skeletalMusclePct?: number;
	muscleMassKg?: number;
	muscleMassLb?: number;
	boneMassKg?: number;
	boneMassLb?: number;
	proteinPct?: number;
	bmrKcal?: number;
	metabolicAge?: number;
	[key: string]: string | number | undefined;
}

/** Parse date from "MM/DD/YYYY" or "MM/DD/YYYY, HH:MM:SS" or "YYYY-MM-DD" -> YYYY-MM-DD */
function parseFITINDEXDate(raw: string): string {
	const mmddyyyy = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (mmddyyyy) {
		const [, m, d, y] = mmddyyyy;
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

export function parseFITINDEXCsv(csvText: string): FITINDEXRow[] {
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
			if (key === "Time" || key === "Time of Measurement") {
				row.time = raw.replace(/^["']|["']$/g, "");
				row.date = parseFITINDEXDate(row.time) || (row.time.match(/^\d{4}-\d{2}-\d{2}/) ? row.time.slice(0, 10) : "");
			} else if (key === "Weight (kg)") row.weightKg = parseNum(raw);
			else if (key === "Weight(lb)" || key === "Weight (lb)") row.weightLb = parseNum(raw);
			else if (key === "BMI") row.bmi = parseNum(raw);
			else if (key === "Body Fat (%)" || key === "Body Fat(%)") row.bodyFatPct = parseNum(raw);
			else if (key === "Fat-free Body Weight (kg)") row.fatFreeWeightKg = parseNum(raw);
			else if (key === "Fat-free Body Weight(lb)" || key === "Fat-free Body Weight (lb)") row.fatFreeWeightLb = parseNum(raw);
			else if (key === "Subcutaneous Fat (%)" || key === "Subcutaneous Fat(%)") row.subcutaneousFatPct = parseNum(raw);
			else if (key === "Visceral Fat") row.visceralFat = parseNum(raw);
			else if (key === "Body Water (%)" || key === "Body Water(%)") row.bodyWaterPct = parseNum(raw);
			else if (key === "Skeletal Muscle (%)" || key === "Skeletal Muscle(%)") row.skeletalMusclePct = parseNum(raw);
			else if (key === "Muscle Mass (kg)") row.muscleMassKg = parseNum(raw);
			else if (key === "Muscle Mass(lb)" || key === "Muscle Mass (lb)") row.muscleMassLb = parseNum(raw);
			else if (key === "Bone Mass (kg)") row.boneMassKg = parseNum(raw);
			else if (key === "Bone Mass(lb)" || key === "Bone Mass (lb)") row.boneMassLb = parseNum(raw);
			else if (key === "Protein (%)" || key === "Protein(%)") row.proteinPct = parseNum(raw);
			else if (key === "BMR (kcal)" || key === "BMR(kcal)") row.bmrKcal = parseNum(raw);
			else if (key === "Metabolic Age") row.metabolicAge = parseNum(raw);
		}

		// Fallback: map by column index so we get all fields even if header text differs
		applyFITINDEXByIndex(row, values);

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

// --- Stats notes path (template from settings) ---
const DEFAULT_STATS_PATH_TEMPLATE = "60 Logs/{year}/Stats/{month}/{date}.md";

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

	async scanAndImport(): Promise<void> {
		const folder = this.settings.scanFolderPath?.trim() || "";
		const allFiles = this.app.vault.getFiles();
		const toProcess = allFiles.filter((f) => {
			const inScope = !folder || f.path === folder || f.path.startsWith(folder + "/");
			if (!inScope) return false;
			const ext = (f.extension || "").toLowerCase();
			if (ext === "json") return true;
			if (ext === "csv" && isFITINDEXCsvFileName(f.name)) return true;
			return false;
		});
		if (toProcess.length === 0) {
			new Notice(
				folder
					? `No JSON or FITINDEX CSV files found in ${folder}`
					: "No JSON or FITINDEX CSV files found in vault"
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
				} else if (ext === "csv" && isFITINDEXCsvFileName(file.name)) {
					const rows = parseFITINDEXCsv(text);
					if (rows.length > 0) {
						const n = await this.processFITINDEXToStatsNotes(rows);
						success += n;
						processed = true;
					}
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
		const yamlFrontmatter = this.generateYAMLFrontmatter(
			mappedData,
			templatePath,
			relativeImagePath,
			workoutName
		);
		const noteContent = `---\n${yamlFrontmatter}---\n\n${templateContent}`;
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

	/** Resolve workout type name to activity icon filename (no extension). */
	getIconNameForWorkout(workoutName: string): string {
		const key = (workoutName || "").toLowerCase().trim();
		if (WORKOUT_TYPE_TO_ICON[key]) return WORKOUT_TYPE_TO_ICON[key];
		for (const [pattern, icon] of Object.entries(WORKOUT_TYPE_TO_ICON)) {
			if (key.includes(pattern) || pattern.includes(key)) return icon;
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

		const iconName = this.getIconNameForWorkout(name);
		const iconUrl = this.getActivityIconUrl(iconName);

		const drawCard = (img: HTMLImageElement | null) => {
			// Dark background (Apple-style)
			ctx.fillStyle = "#0d0d0d";
			ctx.fillRect(0, 0, width, height);

			const padding = 24;
			const circleR = 32;
			const circleX = padding + circleR;
			const circleY = 52;

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

			// Workout name (bold white)
			ctx.fillStyle = "#ffffff";
			ctx.font = "bold 24px system-ui, -apple-system, sans-serif";
			ctx.textBaseline = "middle";
			const nameX = padding + circleR * 2 + 16;
			ctx.fillText(name, nameX, circleY);

			// Divider line
			const dividerY = height - 68;
			ctx.strokeStyle = "rgba(255,255,255,0.12)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(padding, dividerY);
			ctx.lineTo(width - padding, dividerY);
			ctx.stroke();

			// Metrics row: Active Calories (left) | Total Time (right)
			const metricY = dividerY + 36;
			const leftX = padding;
			const rightX = width / 2;

			// Active Calories
			ctx.fillStyle = "rgba(255,255,255,0.6)";
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillText("Active Calories", leftX, metricY - 20);
			ctx.fillStyle = "#ff375f";
			ctx.font = "bold 24px system-ui, sans-serif";
			ctx.fillText(calNum.toString(), leftX, metricY + 2);
			ctx.font = "14px system-ui, sans-serif";
			ctx.fillText("CAL", leftX + ctx.measureText(calNum.toString()).width + 6, metricY + 2);

			// Total Time
			ctx.fillStyle = "rgba(255,255,255,0.6)";
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillText("Total Time", rightX, metricY - 20);
			ctx.fillStyle = "#ffd60a";
			ctx.font = "bold 24px system-ui, sans-serif";
			ctx.fillText(timeStr, rightX, metricY + 2);
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
			if (value.includes(":") || value.includes('"') || value.includes("'") || value.includes("\n")) {
				return `"${value.replace(/"/g, '\\"')}"`;
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
			.setDesc("Folder path to scan for JSON (AutoExport) and FITINDEX CSV files. Leave empty to scan the whole vault.")
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