import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";
import { inflateRawSync } from "zlib";

interface KeyMapping {
	jsonKey: string;
	yamlKey: string;
	rounding?: number; // Number of decimal places (0 = whole numbers, 1 = tenths, etc.)
}

interface CsvKeyMapping extends KeyMapping {}

// Removed ThemePreset - now using Obsidian CSS variables

const DEFAULT_CSV_KEY_MAPPINGS: CsvKeyMapping[] = [
	{ jsonKey: "Workout Type", yamlKey: "workoutType" },
	{ jsonKey: "start", yamlKey: "startTime" },
	{ jsonKey: "end", yamlKey: "endTime" },
	{ jsonKey: "Duration", yamlKey: "duration" },
	{ jsonKey: "Active Energy (kcal)", yamlKey: "activeCalories", rounding: 0 },
	{ jsonKey: "Resting Energy (kcal)", yamlKey: "restingCalories", rounding: 0 },
	{ jsonKey: "Intensity (kcal/hr·kg)", yamlKey: "intensity" },
	{ jsonKey: "Max. Heart Rate (count/min)", yamlKey: "maxHeartRate" },
	{ jsonKey: "Avg. Heart Rate (count/min)", yamlKey: "avgHeartRate" },
	{ jsonKey: "Distance (mi)", yamlKey: "distance" },
	{ jsonKey: "Max. Speed (mi/hr)", yamlKey: "maxSpeed" },
	{ jsonKey: "Avg. Speed (mi/hr)", yamlKey: "avgSpeed" },
	{ jsonKey: "Flights Climbed", yamlKey: "flightsClimbed" },
	{ jsonKey: "Elevation Ascended (ft)", yamlKey: "elevationAscended" },
	{ jsonKey: "Elevation Descended (ft)", yamlKey: "elevationDescended" },
	{ jsonKey: "Step Count", yamlKey: "stepCount" },
	{ jsonKey: "Step Cadence (spm)", yamlKey: "stepCadence" },
	{ jsonKey: "Swimming Stroke Count", yamlKey: "swimmingStrokeCount" },
	{ jsonKey: "Swim Cadence (spm)", yamlKey: "swimCadence" },
	{ jsonKey: "Lap Length (mi)", yamlKey: "lapLength" },
	{ jsonKey: "Swim Stroke Style", yamlKey: "swimStrokeStyle" },
	{ jsonKey: "SWOLF Score", yamlKey: "swolfScore" },
	{ jsonKey: "Water Salinity", yamlKey: "waterSalinity" },
	{ jsonKey: "Temperature (degF)", yamlKey: "temperature" },
	{ jsonKey: "Humidity (%)", yamlKey: "humidity" },
	{ jsonKey: "Location", yamlKey: "location" },
];

interface WorkoutTemplate {
	workoutType: string;
	templatePath: string;
}

interface AdditionalFrontMatter {
	key: string;
	value: string;
}

interface TimeSeriesDataPoint {
	timestamp: string;
	min?: number;
	max?: number;
	avg?: number;
	value?: number;
}

interface WorkoutDetailData {
	workoutName: string;
	workoutType: string;
	startTime: string;
	endTime: string;
	heartRate?: TimeSeriesDataPoint[];
	activeEnergy?: TimeSeriesDataPoint[];
	restingEnergy?: TimeSeriesDataPoint[];
	distance?: TimeSeriesDataPoint[];
	stepCount?: TimeSeriesDataPoint[];
	route?: string; // GPX data as string
	heartRateRecovery?: TimeSeriesDataPoint[];
}

interface WorkoutImporterSettings {
	keyMappings: KeyMapping[];
	csvKeyMappings: CsvKeyMapping[];
	templates: WorkoutTemplate[];
	defaultTemplatePath: string;
	saveDestination: string; // Template path with variables: {YYYY}, {MM}, {YYYYMMDD-HHMM}, {name}
	additionalFrontMatter: AdditionalFrontMatter[];
	watchFolderPath: string; // Vault-relative path where CSV exports land
	workoutFolderPath: string; // Vault-relative folder where notes go
	imageFolderPath: string; // Vault-relative folder for chart assets
	workoutDataFolderPath: string; // Vault-relative folder for time-series JSON data
	saveDetailData: boolean; // Whether to save detail time-series data
}

// Removed DEFAULT_THEME_PRESETS - now using Obsidian CSS variables

const DEFAULT_SETTINGS: WorkoutImporterSettings = {
	keyMappings: [
		{ jsonKey: "name", yamlKey: "name" },
		{ jsonKey: "duration", yamlKey: "duration", rounding: 0 },
		{ jsonKey: "activeEnergyBurned.qty", yamlKey: "calories", rounding: 0 },
		{ jsonKey: "intensity.qty", yamlKey: "intensity", rounding: 1 },
		{ jsonKey: "start", yamlKey: "start" },
		{ jsonKey: "end", yamlKey: "end" },
	],
	csvKeyMappings: [...DEFAULT_CSV_KEY_MAPPINGS],
	templates: [],
	defaultTemplatePath: "",
	saveDestination: "{YYYY}/{MM}/{YYYYMMDD-HHMM}-{name}.md",
	additionalFrontMatter: [],
	watchFolderPath: "",
	workoutFolderPath: "Workouts",
	imageFolderPath: "Attachments",
	workoutDataFolderPath: "Workout Data",
	saveDetailData: true,
};

export default class WorkoutImporterPlugin extends Plugin {
	settings: WorkoutImporterSettings;
	folderScannerIntervalId: number | null = null;
	folderScannerIntervalMs = 60_000;
	private isScanningFolder = false;

	async onload() {
		await this.loadSettings();
		this.startWatchFolderWatcher();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon(
			"dumbbell",
			"Workout Importer",
			(evt: MouseEvent) => {
				// Called when the user clicks the icon.
				this.importWorkouts();
			}
		);
		// Perform additional things with the ribbon
		ribbonIconEl.addClass("my-plugin-ribbon-class");

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "open-workout-importer",
			name: "Import Workout",
			callback: () => {
				this.importWorkouts();
			},
		});

		this.addCommand({
			id: "scan-csv-import-folder",
			name: "Scan workout CSV folder",
			callback: () => {
				void this.scanWatchFolder();
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WorkoutImporterSettingTab(this.app, this));
	}

	onunload() {
		this.stopWatchFolderWatcher();
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

		if (
			(!this.settings.keyMappings || this.settings.keyMappings.length === 0) &&
			(loadedData as any)?.keyMappings
		) {
			this.settings.keyMappings = (loadedData as any).keyMappings;
		}

		if (!this.settings.csvKeyMappings || this.settings.csvKeyMappings.length === 0) {
			if ((loadedData as any)?.csvKeyMappings && (loadedData as any).csvKeyMappings.length) {
				this.settings.csvKeyMappings = (loadedData as any).csvKeyMappings;
			} else if ((loadedData as any)?.keyMappings) {
				this.settings.csvKeyMappings = (loadedData as any).keyMappings;
			} else {
				this.settings.csvKeyMappings = [...DEFAULT_SETTINGS.csvKeyMappings];
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startWatchFolderWatcher(): void {
		this.stopWatchFolderWatcher();

		const folderPath = this.settings.watchFolderPath?.trim();
		if (!folderPath) {
			return;
		}

		void this.scanWatchFolder();

		this.folderScannerIntervalId = window.setInterval(
			() => {
				void this.scanWatchFolder();
			},
			this.folderScannerIntervalMs
		);
	}

	stopWatchFolderWatcher(): void {
		if (this.folderScannerIntervalId !== null) {
			window.clearInterval(this.folderScannerIntervalId);
			this.folderScannerIntervalId = null;
		}
	}

	async scanWatchFolder(): Promise<void> {
		const folderPathSetting = this.settings.watchFolderPath?.trim()
			? normalizePath(this.settings.watchFolderPath.trim())
			: "";
		if (!folderPathSetting) {
			console.warn("[WorkoutImporter] scanWatchFolder aborted: watchFolderPath is empty");
			new Notice("Set the watch folder path in settings before scanning.");
			return;
		}

		if (this.isScanningFolder) {
			return;
		}
		this.isScanningFolder = true;

		const normalizedFolder = normalizePath(folderPathSetting);
		const adapter = this.app.vault.adapter;

		try {
			const exists = await adapter.exists(normalizedFolder);
			if (!exists) {
				console.warn("Watch folder does not exist:", normalizedFolder);
				new Notice(`Watch folder not found: ${normalizedFolder}`);
				return;
			}

		const listResult = await adapter.list(normalizedFolder);
		const files = listResult.files ?? [];
		console.log("[WorkoutImporter] scanWatchFolder found files:", files);

		// adapter.list() returns full paths, not just basenames
		const csvFiles = files.filter((filePath) => filePath.toLowerCase().endsWith(".csv"));
		const zipFiles = files.filter((filePath) => filePath.toLowerCase().endsWith(".zip"));

		for (const csvPath of csvFiles) {
			console.log("[WorkoutImporter] triggering CSV import for:", csvPath);
			await this.processCsvSummaryFile(csvPath);
		}

		for (const zipPath of zipFiles) {
			console.log("[WorkoutImporter] triggering ZIP import for:", zipPath);
			await this.processZipFile(zipPath);
		}
		} catch (error) {
			console.error("Error scanning CSV import folder:", error);
		} finally {
			this.isScanningFolder = false;
		}
	}

	getWatchStatusText(): string {
		const path = this.settings.watchFolderPath?.trim();
		return path ? `Watching ${path}` : "Watch folder not set";
	}

	async regenerateAllImages(): Promise<void> {
		new Notice("Scanning workout notes for image regeneration...");
		console.log("[WorkoutImporter] Starting image regeneration across entire vault");
		console.log("[WorkoutImporter] Settings workoutFolderPath (template):", this.settings.workoutFolderPath);
		
		try {
			// Get ALL markdown files and filter for workout notes by checking frontmatter
			const allMarkdownFiles = this.app.vault.getMarkdownFiles();
			console.log(`[WorkoutImporter] Scanning ${allMarkdownFiles.length} total markdown files`);
			
			const workoutFiles: TFile[] = [];
			
			// Quick filter: only check files that might be workouts
			// If workoutFolderPath is set, extract the static prefix (before first template variable)
			let pathPrefix = "";
			if (this.settings.workoutFolderPath) {
				const match = this.settings.workoutFolderPath.match(/^([^{]*)/);
				if (match) {
					pathPrefix = normalizePath(match[1].trim());
				}
			}
			
			console.log(`[WorkoutImporter] Path prefix filter: "${pathPrefix}"`);
			
			for (const file of allMarkdownFiles) {
				// If we have a prefix, only check files in that path
				if (pathPrefix && !file.path.startsWith(pathPrefix)) {
					continue;
				}
				
				// Quick check: does the file have workout-like frontmatter?
				try {
					const content = await this.app.vault.read(file);
					if (content.includes("workoutType:") || content.includes("startTime:") || 
					    content.includes("avgHeartRate:") || content.includes("activeCalories:")) {
						workoutFiles.push(file);
						console.log(`[WorkoutImporter]   - Found workout file: ${file.path}`);
					}
				} catch (error) {
					// Skip files we can't read
				}
			}
			
			console.log(`[WorkoutImporter] Found ${workoutFiles.length} workout notes to process`);
			
			if (workoutFiles.length === 0) {
				new Notice(`No workout files found. Check that workout notes have proper frontmatter.`);
				console.warn(`[WorkoutImporter] No workout files found with workoutType or startTime frontmatter.`);
				return;
			}
			
			let successCount = 0;
			let errorCount = 0;
			
			for (const file of workoutFiles) {
				try {
					console.log(`[WorkoutImporter] Processing: ${file.path}`);
					const content = await this.app.vault.read(file);
					const workout = this.parseFrontmatterToWorkout(content, file.path);
					
					if (!workout) {
						console.warn(`[WorkoutImporter] Skipping ${file.path}: no valid workout data`);
						continue;
					}
					
					console.log(`[WorkoutImporter] Parsed workout data:`, {
						name: workout.name,
						start: workout.start,
						avgHeartRate: workout.avgHeartRate,
						maxHeartRate: workout.maxHeartRate
					});
					
					// Generate new banner image
					const imageData = await generateBannerImage(this, workout);
					
					// Determine image path - reconstruct based on note path
					const imageFolderPath = this.settings.imageFolderPath?.trim() || "Attachments";
					const resolvedImageFolder = resolveImageFolderPath(
						this,
						workout.start ? new Date(workout.start) : new Date(),
						workout.name || "Workout"
					);
					const targetFolder = resolvedImageFolder || imageFolderPath;
					
					console.log(`[WorkoutImporter] Saving image to folder: ${targetFolder}`);
					
					// Save/overwrite the image
					await saveImageForPlugin(this, imageData, file.path, targetFolder);
					
					successCount++;
					console.log(`[WorkoutImporter] ✓ Regenerated image for: ${file.path}`);
				} catch (error) {
					errorCount++;
					console.error(`[WorkoutImporter] ✗ Error regenerating image for ${file.path}:`, error);
				}
			}
			
			const message = `Regeneration complete: ${successCount} successful, ${errorCount} errors`;
			new Notice(message);
			console.log(`[WorkoutImporter] ${message}`);
		} catch (error) {
			console.error("[WorkoutImporter] Error during image regeneration:", error);
			new Notice("Error during image regeneration. Check console for details.");
		}
	}
	
	private async getAllWorkoutFiles(folderPath: string): Promise<TFile[]> {
		const files: TFile[] = [];
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		
		console.log(`[WorkoutImporter] Looking for folder: ${folderPath}`);
		console.log(`[WorkoutImporter] Folder exists:`, !!folder);
		
		if (!folder) {
			console.warn(`[WorkoutImporter] Folder not found: ${folderPath}`);
			return files;
		}
		
		const allFiles = this.app.vault.getMarkdownFiles();
		console.log(`[WorkoutImporter] Total markdown files in vault: ${allFiles.length}`);
		
		for (const file of allFiles) {
			if (file.path.startsWith(folderPath) && file.path.endsWith(".md")) {
				files.push(file);
				console.log(`[WorkoutImporter]   - Found workout file: ${file.path}`);
			}
		}
		
		console.log(`[WorkoutImporter] Total workout files found in ${folderPath}: ${files.length}`);
		return files;
	}
	
	private parseFrontmatterToWorkout(content: string, filePath: string): any | null {
		// Extract frontmatter between --- markers
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) {
			console.warn(`[WorkoutImporter] No frontmatter found in: ${filePath}`);
			return null;
		}
		
		const frontmatterText = frontmatterMatch[1];
		const workout: any = {};
		
		// Parse YAML-like frontmatter
		const lines = frontmatterText.split("\n");
		for (const line of lines) {
			// Updated regex to handle keys with dots, dashes, underscores
			const match = line.match(/^([a-zA-Z0-9_\-\.]+):\s*(.*)$/);
			if (match) {
				const key = match[1];
				let value: any = match[2].trim();
				
				// Remove quotes if present
				if (value.startsWith('"') && value.endsWith('"')) {
					value = value.slice(1, -1);
				}
				
				// Try to parse as number
				const num = parseFloat(value);
				if (!isNaN(num) && value !== "") {
					value = num;
				}
				
				// Map frontmatter keys back to workout object structure
				// startTime/endTime -> start/end for banner generation
				if (key === "startTime") {
					workout.start = value;
				} else if (key === "endTime") {
					workout.end = value;
				} else if (key === "workoutType") {
					workout.name = value;
				} else {
					workout[key] = value;
				}
			}
		}
		
		// Map common frontmatter keys to workout object structure
		const mappedWorkout: any = {
			name: workout.workoutType || workout.name || "Workout",
			start: workout.start,
			end: workout.end,
			duration: workout.duration,
			activeEnergyBurned: { qty: workout.activeCalories || workout.calories },
			avgHeartRate: workout.avgHeartRate,
			maxHeartRate: workout.maxHeartRate,
			minHeartRate: workout.minHeartRate,
			distance: workout.distance,
			intensity: workout.intensity,
			stepCount: workout.stepCount,
			elevationAscended: workout.elevationAscended,
			flightsClimbed: workout.flightsClimbed,
		};
		
		return mappedWorkout;
	}

	private async processCsvSummaryFile(filePath: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		let deleteOnSuccess = false;

		try {
			const csvText = await adapter.read(filePath);
			const rows = this.parseWorkoutCsvRows(csvText);
			console.log("[WorkoutImporter] rows parsed from CSV:", filePath, rows.length);
			if (rows.length === 0) {
				deleteOnSuccess = true;
				return;
			}

			await this.importCsvRows(rows);
			deleteOnSuccess = true;
		} catch (error) {
			console.error("Error processing workout CSV:", filePath, error);
		} finally {
			if (deleteOnSuccess) {
				try {
					await adapter.remove(filePath);
				} catch (error) {
					console.error("Failed to delete imported CSV:", filePath, error);
				}
			}
		}
	}

	private async importCsvRows(rows: Record<string, string>[]): Promise<boolean> {
		const importer = new ImportWorkoutModal(this.app, this);
		let processed = false;

		for (const record of rows) {
			const workout = this.createWorkoutFromCsvRecord(record);
			if (!workout) {
				continue;
			}

			const workoutDate = workout.start ? new Date(workout.start) : new Date();
			if (Number.isNaN(workoutDate.getTime())) {
				continue;
			}

				const notePath = generateWorkoutFilePath(importer.plugin, workout.name, workoutDate);
			if (this.app.vault.getAbstractFileByPath(notePath)) {
				continue;
			}

			console.log("[WorkoutImporter] creating note for workout:", workout.name, notePath);
			await importer.processWorkout(workout);
			processed = true;
		}

		return processed;
	}

	private async processZipFile(filePath: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		let deleteOnSuccess = false;

		try {
			const arrayBuffer = await adapter.readBinary(filePath);
			const bytes = new Uint8Array(arrayBuffer);
			const entries = parseZipEntries(bytes);
			
			console.log("[WorkoutImporter] ZIP contains", entries.length, "entries");
			
			// Separate summary CSV from detail CSVs
			let summaryEntry = null;
			const detailEntries: Array<{ entry: any; name: string; csvText: string }> = [];

			for (const entry of entries) {
				const baseName = entry.name.split("/").pop() ?? entry.name;
				
				// Identify summary CSV
				if (baseName.startsWith("Workouts-") && baseName.endsWith(".csv")) {
					console.log("[WorkoutImporter] Found summary CSV:", baseName);
					summaryEntry = entry;
					continue;
				}
				
				// Collect detail CSVs (skip GPX for now, we'll handle separately)
				if (baseName.endsWith(".csv")) {
					const csvText = decodeZipEntry(bytes, entry);
					if (csvText) {
						console.log("[WorkoutImporter] Extracted detail CSV:", baseName, csvText.length, "bytes");
						detailEntries.push({ entry, name: baseName, csvText });
					}
				} else if (baseName.endsWith(".gpx")) {
					// Store GPX data
					const gpxText = decodeZipEntry(bytes, entry);
					if (gpxText) {
						console.log("[WorkoutImporter] Extracted GPX:", baseName, gpxText.length, "bytes");
						detailEntries.push({ entry, name: baseName, csvText: gpxText });
					}
				}
			}

			console.log("[WorkoutImporter] Extracted", detailEntries.length, "detail files");

			// Process summary CSV first to create workout notes
			if (!summaryEntry) {
				console.warn("[WorkoutImporter] No summary CSV found in ZIP:", filePath);
				return;
			}

			const summaryText = decodeZipEntry(bytes, summaryEntry);
			if (!summaryText) {
				console.warn("[WorkoutImporter] Could not decode summary CSV from ZIP:", filePath);
				return;
			}

			const rows = this.parseWorkoutCsvRows(summaryText);
			console.log("[WorkoutImporter] rows parsed from ZIP summary:", rows.length);
			
			if (rows.length === 0) {
				return;
			}

			// Process each workout and save detail data if enabled
			await this.importCsvRowsWithDetailData(rows, detailEntries);
			deleteOnSuccess = true;

		} catch (error) {
			console.error("Error processing workout ZIP:", filePath, error);
		} finally {
			if (deleteOnSuccess) {
				try {
					await adapter.remove(filePath);
				} catch (error) {
					console.error("Failed to delete imported ZIP:", filePath, error);
				}
			}
		}
	}

	private async importCsvRowsWithDetailData(
		rows: Record<string, string>[],
		detailEntries: Array<{ entry: any; name: string; csvText: string }>
	): Promise<boolean> {
		const importer = new ImportWorkoutModal(this.app, this);
		let processed = false;

		for (const record of rows) {
			const workout = this.createWorkoutFromCsvRecord(record);
			if (!workout) {
				continue;
			}

			const workoutDate = workout.start ? new Date(workout.start) : new Date();
			if (Number.isNaN(workoutDate.getTime())) {
				continue;
			}

			const notePath = generateWorkoutFilePath(importer.plugin, workout.name, workoutDate);
			if (this.app.vault.getAbstractFileByPath(notePath)) {
				console.log("[WorkoutImporter] skipping duplicate:", notePath);
				continue;
			}

			// Find matching detail CSVs for this workout
			let detailData: WorkoutDetailData | null = null;
			if (this.settings.saveDetailData) {
				console.log("[WorkoutImporter] Extracting detail data for:", workout.name);
				detailData = this.extractDetailDataForWorkout(workout, detailEntries);
				console.log("[WorkoutImporter] Detail data extracted:", {
					heartRate: detailData.heartRate?.length || 0,
					activeEnergy: detailData.activeEnergy?.length || 0,
					route: detailData.route ? "YES" : "NO"
				});
			}

			console.log("[WorkoutImporter] creating note for workout:", workout.name, notePath);
			await importer.processWorkout(workout);
			
			// Save detail data JSON file if we have data
			if (detailData && this.settings.saveDetailData) {
				console.log("[WorkoutImporter] Attempting to save detail data for:", notePath);
				try {
					await this.saveWorkoutDetailData(detailData, notePath);
				} catch (error) {
					console.error("[WorkoutImporter] Failed to save detail data:", error);
				}
			} else {
				console.log("[WorkoutImporter] Skipping detail data save:", {
					hasDetailData: !!detailData,
					saveDetailDataEnabled: this.settings.saveDetailData
				});
			}
			
			processed = true;
		}

		return processed;
	}

	private extractDetailDataForWorkout(
		workout: any,
		detailEntries: Array<{ entry: any; name: string; csvText: string }>
	): WorkoutDetailData {
		// Match detail files by workout type and approximate timestamp
		const workoutType = workout.name || "";
		const workoutStart = workout.start ? new Date(workout.start) : null;
		
		console.log("[WorkoutImporter] Matching detail files for:", workoutType, workoutStart?.toISOString());
		console.log("[WorkoutImporter] Available detail entries:", detailEntries.map(e => e.name));
		
		const detailData: WorkoutDetailData = {
			workoutName: workoutType,
			workoutType: workoutType,
			startTime: workout.start || "",
			endTime: workout.end || "",
		};

		let matchedCount = 0;

		for (const detail of detailEntries) {
			// Parse filename: "WorkoutType-DataType-YYYYMMDD_HHMMSS.csv"
			const parts = detail.name.split("-");
			if (parts.length < 3) continue;

			const fileWorkoutType = parts.slice(0, -2).join("-");
			const dataType = parts[parts.length - 2];
			const timestamp = parts[parts.length - 1].replace(".csv", "").replace(".gpx", "");

			// Check if this detail file matches the workout
			if (fileWorkoutType !== workoutType) continue;
			
			// Check if timestamps are close (within a few seconds)
			if (workoutStart) {
				const fileTimestamp = this.parseHealthTimestamp(timestamp);
				if (fileTimestamp && Math.abs(workoutStart.getTime() - fileTimestamp.getTime()) > 5000) {
					console.log("[WorkoutImporter] Timestamp mismatch:", detail.name, "delta:", Math.abs(workoutStart.getTime() - (fileTimestamp?.getTime() || 0)));
					continue; // Not the same workout
				}
			}

			matchedCount++;
			console.log("[WorkoutImporter] Matched detail file:", detail.name, "dataType:", dataType);

			// Parse the CSV based on data type
			if (detail.name.endsWith(".gpx")) {
				detailData.route = detail.csvText;
			} else {
				const series = this.parseDetailCsv(detail.csvText);
				console.log("[WorkoutImporter] Parsed", dataType, "series length:", series.length);
				
				switch (dataType) {
					case "Heart Rate":
						detailData.heartRate = series;
						break;
					case "Active Energy":
						detailData.activeEnergy = series;
						break;
					case "Resting Energy":
						detailData.restingEnergy = series;
						break;
					case "Walking + Running Distance":
						detailData.distance = series;
						break;
					case "Step Count":
						detailData.stepCount = series;
						break;
					case "Heart Rate Recovery":
						detailData.heartRateRecovery = series;
						break;
				}
			}
		}

		console.log("[WorkoutImporter] Matched", matchedCount, "detail files for workout:", workoutType);

		return detailData;
	}

	private parseDetailCsv(csvText: string): TimeSeriesDataPoint[] {
		const lines = csvText.trim().split("\n");
		if (lines.length < 2) return [];

		const header = this.parseCsvLine(lines[0]);
		const dataPoints: TimeSeriesDataPoint[] = [];

		// Expected columns: Date/Time, Min, Max, Avg, Context, Source
		// Or sometimes: Date/Time, Value, Context, Source
		for (let i = 1; i < lines.length; i++) {
			const values = this.parseCsvLine(lines[i]);
			if (values.length < 2) continue;

			const point: TimeSeriesDataPoint = {
				timestamp: values[0] || "",
			};

			// Check if we have Min/Max/Avg or just Value
			if (header.includes("Min") || header.includes("min")) {
				point.min = parseFloat(values[1]) || undefined;
				point.max = parseFloat(values[2]) || undefined;
				point.avg = parseFloat(values[3]) || undefined;
			} else if (header.includes("Value") || header.includes("value")) {
				point.value = parseFloat(values[1]) || undefined;
			} else {
				// Fallback: assume columns are Min, Max, Avg
				point.min = parseFloat(values[1]) || undefined;
				point.max = parseFloat(values[2]) || undefined;
				point.avg = parseFloat(values[3]) || undefined;
			}

			dataPoints.push(point);
		}

		return dataPoints;
	}

	private parseHealthTimestamp(timestamp: string): Date | null {
		// Format: YYYYMMDD_HHMMSS
		if (timestamp.length !== 15) return null;
		
		const year = timestamp.substring(0, 4);
		const month = timestamp.substring(4, 6);
		const day = timestamp.substring(6, 8);
		const hour = timestamp.substring(9, 11);
		const minute = timestamp.substring(11, 13);
		const second = timestamp.substring(13, 15);
		
		const dateStr = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
		const date = new Date(dateStr);
		
		return isNaN(date.getTime()) ? null : date;
	}

	private async saveWorkoutDetailData(detailData: WorkoutDetailData, noteFilePath: string): Promise<void> {
		const dataFolderPath = this.settings.workoutDataFolderPath?.trim() || "Workout Data";
		
		// Extract date from detailData for template expansion
		const workoutDate = detailData.startTime ? new Date(detailData.startTime) : new Date();
		const workoutName = detailData.workoutName || "Workout";
		
		// Expand template variables in folder path
		const expandedFolder = expandPathTemplate(dataFolderPath, workoutDate, workoutName);
		const normalizedFolder = normalizePath(expandedFolder);

		console.log("[WorkoutImporter] saveWorkoutDetailData - folder:", normalizedFolder);

		// Create data folder if it doesn't exist
		const folder = this.app.vault.getAbstractFileByPath(normalizedFolder);
		if (!folder) {
			console.log("[WorkoutImporter] Creating data folder:", normalizedFolder);
			await this.app.vault.createFolder(normalizedFolder);
		} else {
			console.log("[WorkoutImporter] Data folder exists:", normalizedFolder);
		}

		// Generate filename based on note path
		const pathParts = noteFilePath.split("/");
		const noteFileName = pathParts[pathParts.length - 1].replace(".md", "");
		const jsonFileName = `${noteFileName}.json`;
		const jsonPath = `${normalizedFolder}/${jsonFileName}`;

		console.log("[WorkoutImporter] JSON path:", jsonPath);

		// Convert to JSON
		const jsonContent = JSON.stringify(detailData, null, 2);

		// Check if file exists and delete it
		const existingFile = this.app.vault.getAbstractFileByPath(jsonPath);
		if (existingFile instanceof TFile) {
			console.log("[WorkoutImporter] Deleting existing JSON file:", jsonPath);
			await this.app.vault.delete(existingFile);
		}

		// Save JSON file
		console.log("[WorkoutImporter] Creating JSON file:", jsonPath, "size:", jsonContent.length, "bytes");
		await this.app.vault.create(jsonPath, jsonContent);
		console.log("[WorkoutImporter] ✅ Saved detail data to:", jsonPath);
	}

	private parseWorkoutCsvRows(csvText: string): Record<string, string>[] {
		const lines = csvText.split(/\r?\n/).map((line) => line.trim());
		if (lines.length === 0) {
			return [];
		}

		const headerLine = lines[0];
		if (!headerLine) {
			return [];
		}

		const header = this.parseCsvLine(headerLine).map((col) => col.replace(/^\uFEFF/, "").trim());
		if (!header.some((col) => col.toLowerCase().includes("workout type"))) {
			return [];
		}

		const result: Record<string, string>[] = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line) {
				continue;
			}

			const values = this.parseCsvLine(line);
			if (values.every((value) => value === "")) {
				continue;
			}

			const row: Record<string, string> = {};
			for (let j = 0; j < header.length; j++) {
				const key = header[j] || `column_${j}`;
				row[key] = values[j] ?? "";
			}

			result.push(row);
		}

		return result;
	}

	private parseCsvLine(line: string): string[] {
		const values: string[] = [];
		let current = "";
		let inQuotes = false;

		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === '"') {
				if (inQuotes && line[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = !inQuotes;
				}
			} else if (char === "," && !inQuotes) {
				values.push(current);
				current = "";
			} else {
				current += char;
			}
		}

		values.push(current);
		return values.map((value) => value.trim());
	}

	private createWorkoutFromCsvRecord(record: Record<string, string>): any | null {
		const workoutType = record["Workout Type"]?.trim();
		const startString = record["Start"]?.trim();
		if (!workoutType || !startString) {
			return null;
		}

		const startDate = this.parseDateTime(startString);
		if (!startDate) {
			return null;
		}

		const endDate = this.parseDateTime(record["End"]?.trim());
		let durationSeconds = this.parseDurationToSeconds(record["Duration"]?.trim());
		if (durationSeconds === undefined && endDate) {
			durationSeconds = Math.round((endDate.getTime() - startDate.getTime()) / 1000);
		}

		const workout: Record<string, any> = {
			name: workoutType,
			start: startDate.toISOString(),
			duration: durationSeconds ?? 0,
			metadata: { source: "csv" },
			location: record["Location"]?.trim() || undefined,
			sourceCsv: record,
		};

		if (endDate) {
			workout.end = endDate.toISOString();
		}

		const addQty = (fieldName: string, target: string, units?: string) => {
			const value = this.parseNumber(record[fieldName]);
			if (value !== undefined) {
				workout[target] = units ? { qty: value, units } : value;
			}
		};

		const addSimpleNumber = (fieldName: string, target: string) => {
			const value = this.parseNumber(record[fieldName]);
			if (value !== undefined) {
				workout[target] = value;
			}
		};

		addQty("Active Energy (kcal)", "activeEnergyBurned", "kcal");
		addQty("Resting Energy (kcal)", "restingEnergy", "kcal");
		addQty("Intensity (kcal/hr·kg)", "intensity", "kcal/hr·kg");
		addQty("Distance (mi)", "distance", "mi");
		addSimpleNumber("Avg. Heart Rate (count/min)", "avgHeartRate");
		addSimpleNumber("Max. Heart Rate (count/min)", "maxHeartRate");
		addSimpleNumber("Flights Climbed", "flightsClimbed");
		addSimpleNumber("Step Count", "stepCount");
		addSimpleNumber("Avg. Speed (mi/hr)", "avgSpeed");
		addSimpleNumber("Max. Speed (mi/hr)", "maxSpeed");
		addSimpleNumber("Elevation Ascended (ft)", "elevationAscended");
		addSimpleNumber("Elevation Descended (ft)", "elevationDescended");
		addSimpleNumber("Temperature (degF)", "temperature");
		addSimpleNumber("Humidity (%)", "humidity");

		workout.duration = durationSeconds ?? workout.duration;

		return workout;
	}

	private parseDateTime(value?: string): Date | undefined {
		if (!value) {
			return undefined;
		}

		const normalized = value.trim().replace(" ", "T");
		const date = new Date(normalized);
		if (Number.isNaN(date.getTime())) {
			return undefined;
		}

		return date;
	}

	private parseDurationToSeconds(value?: string): number | undefined {
		if (!value) {
			return undefined;
		}

		const parts = value.split(":").map((part) => parseInt(part, 10));
		if (parts.some((num) => Number.isNaN(num))) {
			return undefined;
		}

		return parts.reduce((total, part) => total * 60 + part, 0);
	}

	private parseNumber(value?: string): number | undefined {
		if (!value) {
			return undefined;
		}

		const parsed = parseFloat(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	async importWorkouts() {
		new ImportWorkoutModal(this.app, this).open();
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
		containerEl.createEl("h2", { text: "Workout Importer Settings" });

		// Save Destination Section
		containerEl.createEl("h3", { text: "Save Destination" });
		new Setting(containerEl)
			.setName("Save destination template")
		.setDesc(
			"Template for the note name. Use {YYYY}, {MM}, {DD}, {YYYYMMDD-HHMM}, {name}, etc.; the workout folder path above becomes the base directory."
		)
			.addText((text) => {
			text.setPlaceholder("{YYYYMMDD-HHMM}-{name}.md")
					.setValue(this.plugin.settings.saveDestination)
					.onChange(async (value) => {
						this.plugin.settings.saveDestination = value;
						await this.plugin.saveSettings();
					});
			});

		// Paths & storage
		containerEl.createEl("h3", { text: "Paths & Storage" });
		const watchSetting = new Setting(containerEl)
			.setName("Watch folder")
			.setDesc("Vault path where HealthAutoExport drops the summary CSV files.")
			.addText((text) => {
				text.setPlaceholder("HealthData/CSV")
					.setValue(this.plugin.settings.watchFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.watchFolderPath = value.trim()
							? normalizePath(value.trim())
							: "";
						await this.plugin.saveSettings();
						this.plugin.startWatchFolderWatcher();
						updateWatchStatus();
					});
			})
			.addButton((button) =>
				button.setButtonText("Scan now").onClick(async () => {
					await this.plugin.scanWatchFolder();
					new Notice("CSV folder scan complete");
				})
			);

		const watchStatus = watchSetting.settingEl.createEl("div", {
			text: this.plugin.getWatchStatusText(),
			cls: "setting-item-description",
		});

		const updateWatchStatus = () => {
			const statusText = this.plugin.getWatchStatusText();
			watchStatus.setText(statusText);
		};

		updateWatchStatus();

		new Setting(containerEl)
			.setName("Workout folder")
			.setDesc("Vault folder where generated workout notes are saved. Supports templates: {YYYY}, {MM}, {DD}.")
			.addText((text) => {
				text.setPlaceholder("Workouts")
					.setValue(this.plugin.settings.workoutFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.workoutFolderPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Image folder")
			.setDesc("Vault path where tile/chart images are written. Supports templates: {YYYY}, {MM}, {DD}.")
			.addText((text) => {
				text.setPlaceholder("Attachments")
					.setValue(this.plugin.settings.imageFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.imageFolderPath = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) =>
				button
					.setButtonText("Regenerate tile images")
					.setCta()
					.onClick(async () => {
						await this.plugin.regenerateAllImages();
					})
			);

		new Setting(containerEl)
			.setName("Workout data folder")
			.setDesc("Vault path where time-series JSON data files are saved (for chart generation). Supports templates: {YYYY}, {MM}, {DD}.")
			.addText((text) => {
				text.setPlaceholder("Workout Data")
					.setValue(this.plugin.settings.workoutDataFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.workoutDataFolderPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Save detail data")
			.setDesc("Save time-series data (heart rate, energy, etc.) from ZIP exports as JSON files for chart generation.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.saveDetailData)
					.onChange(async (value) => {
						this.plugin.settings.saveDetailData = value;
						await this.plugin.saveSettings();
					});
			});

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

		// CSV Key Mappings Section
		containerEl.createEl("h3", { text: "CSV to YAML Key Mappings" });
		
		const mappingsDesc = containerEl.createEl("p", {
			text: "Map CSV columns to YAML frontmatter keys. Use dot notation and rounding where needed.",
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
			this.plugin.settings.csvKeyMappings = [...DEFAULT_SETTINGS.csvKeyMappings];
			await this.plugin.saveSettings();
			this.display();
		});

		const keyMappingsContainer = containerEl.createDiv("key-mappings-container");
		this.renderCsvKeyMappings(keyMappingsContainer);

		const addMappingButton = containerEl.createEl("button", {
			text: "+ Add Mapping",
			cls: "mod-cta",
		});
		addMappingButton.addEventListener("click", () => {
			this.plugin.settings.csvKeyMappings.push({
				jsonKey: "",
				yamlKey: "",
				rounding: undefined,
			});
			this.plugin.saveSettings();
			this.display();
		});

		// Additional Front Matter Section
		containerEl.createEl("h3", { text: "Additional Front Matter" });
		containerEl.createEl("p", {
			text: "Add custom front matter fields. Values support template variables: {image} (relative image path), {template} (template file path), {name}, etc.",
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

	renderCsvKeyMappings(container: HTMLElement): void {
		container.empty();
		
		if (this.plugin.settings.csvKeyMappings.length === 0) {
			container.createEl("p", {
				text: "No mappings yet. Click '+ Add Mapping' to add one.",
				cls: "setting-item-description",
			});
			return;
		}

		this.plugin.settings.csvKeyMappings.forEach((mapping, index) => {
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
				this.plugin.settings.csvKeyMappings[index].jsonKey = value;
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
				this.plugin.settings.csvKeyMappings[index].yamlKey = value;
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
				this.plugin.settings.csvKeyMappings[index].rounding = numValue;
				await this.plugin.saveSettings();
			});

			// Remove button
			const removeButton = row.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Remove" },
			});
			removeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
			removeButton.addEventListener("click", async () => {
				this.plugin.settings.csvKeyMappings.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}

	// Removed theme preset methods - now using Obsidian CSS variables

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

// Import workout modal
class ImportWorkoutModal extends Modal {
	plugin: WorkoutImporterPlugin;

	constructor(app: App, plugin: WorkoutImporterPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Import Workouts" });

		// Clipboard section (primary method)
		contentEl.createEl("h3", { text: "Paste JSON from Clipboard" });
		const clipboardDesc = contentEl.createEl("p", {
			text: "Paste JSON content from HealthAutoExport",
		});
		clipboardDesc.style.marginBottom = "10px";

		const clipboardTextarea = contentEl.createEl("textarea", {
			attr: {
				placeholder: "Paste JSON content here...",
				rows: "8",
			},
		});
		clipboardTextarea.style.width = "100%";
		clipboardTextarea.style.fontFamily = "var(--font-monospace)";
		clipboardTextarea.style.fontSize = "0.9em";
		clipboardTextarea.style.marginBottom = "15px";
		clipboardTextarea.style.padding = "10px";
		clipboardTextarea.style.border = "1px solid var(--background-modifier-border)";
		clipboardTextarea.style.borderRadius = "4px";
		clipboardTextarea.style.resize = "vertical";

		// Image paste area
		contentEl.createEl("h4", { text: "Optional: Paste Image" });
		const imageDesc = contentEl.createEl("p", {
			text: "Paste an image (will be saved to assets folder)",
		});
		imageDesc.style.marginBottom = "10px";
		imageDesc.style.fontSize = "0.9em";

		const imagePasteArea = contentEl.createDiv("image-paste-area");
		imagePasteArea.style.width = "100%";
		imagePasteArea.style.minHeight = "150px";
		imagePasteArea.style.border = "2px dashed var(--background-modifier-border)";
		imagePasteArea.style.borderRadius = "4px";
		imagePasteArea.style.padding = "20px";
		imagePasteArea.style.textAlign = "center";
		imagePasteArea.style.marginBottom = "15px";
		imagePasteArea.style.cursor = "pointer";
		imagePasteArea.style.position = "relative";
		
		const imagePlaceholder = imagePasteArea.createEl("div", {
			text: "Click here and paste an image (or drag & drop)",
		});
		imagePlaceholder.style.color = "var(--text-muted)";
		
		let pastedImageData: string | undefined;
		let pastedImage: HTMLImageElement | undefined;

		imagePasteArea.addEventListener("paste", async (e) => {
			e.preventDefault();
			const clipboardData = e.clipboardData;
			if (!clipboardData) return;

			const items = Array.from(clipboardData.items);
			for (const item of items) {
				if (item.type.indexOf("image") !== -1) {
					const blob = item.getAsFile();
					if (blob) {
						const reader = new FileReader();
						reader.onload = (event) => {
							const result = event.target?.result as string;
							pastedImageData = result;
							
							// Display preview
							imagePlaceholder.remove();
							if (pastedImage) pastedImage.remove();
							pastedImage = imagePasteArea.createEl("img") as HTMLImageElement;
							pastedImage.src = result;
							pastedImage.style.maxWidth = "100%";
							pastedImage.style.maxHeight = "200px";
							pastedImage.style.borderRadius = "4px";
						};
						reader.readAsDataURL(blob);
					}
					break;
				}
			}
		});

		imagePasteArea.addEventListener("click", () => {
			imagePasteArea.focus();
		});

		// Make paste area focusable
		imagePasteArea.setAttribute("tabindex", "0");

		const clipboardImportButton = contentEl.createEl("button", {
			text: "Import from Clipboard",
			cls: "mod-cta",
		});
		clipboardImportButton.style.marginBottom = "30px";

		// File input section (alternative method)
		contentEl.createEl("h3", { text: "Or Select JSON Files" });
		const fileDesc = contentEl.createEl("p", {
			text: "Select JSON files from HealthAutoExport",
		});
		fileDesc.style.marginBottom = "10px";

		const fileInput = contentEl.createEl("input", {
			type: "file",
			attr: {
				accept: ".json",
				multiple: true,
			},
		});
		fileInput.style.marginBottom = "15px";

		const fileImportButton = contentEl.createEl("button", {
			text: "Import from Files",
			cls: "mod-cta",
		});

		let selectedFiles: File[] = [];

		// Clipboard import handler
		clipboardImportButton.addEventListener("click", async () => {
			const jsonText = clipboardTextarea.value.trim();
			if (!jsonText) {
				new Notice("Please paste JSON content");
				return;
			}

			clipboardImportButton.disabled = true;
			clipboardImportButton.textContent = "Importing...";

			try {
				const result = await this.processJSONText(jsonText, pastedImageData);
				new Notice(
					`Imported ${result.success} workout${result.success !== 1 ? "s" : ""}${
						result.errors > 0 ? ` (${result.errors} error${result.errors !== 1 ? "s" : ""})` : ""
					}`
				);
				this.close();
			} catch (error) {
				new Notice(`Import failed: ${error}`);
				clipboardImportButton.disabled = false;
				clipboardImportButton.textContent = "Import from Clipboard";
			}
		});

		// File input handler
		fileInput.addEventListener("change", (e) => {
			const target = e.target as HTMLInputElement;
			selectedFiles = Array.from(target.files || []);
			fileImportButton.textContent =
				selectedFiles.length > 0
					? `Import ${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""}`
					: "Import from Files";
		});

		fileImportButton.addEventListener("click", async () => {
			if (selectedFiles.length === 0) {
				new Notice("Please select at least one JSON file");
				return;
			}

			fileImportButton.disabled = true;
			fileImportButton.textContent = "Importing...";

			try {
				const result = await this.processFiles(selectedFiles);
				new Notice(
					`Imported ${result.success} workout${result.success !== 1 ? "s" : ""}${
						result.errors > 0 ? ` (${result.errors} error${result.errors !== 1 ? "s" : ""})` : ""
					}`
				);
				this.close();
			} catch (error) {
				new Notice(`Import failed: ${error}`);
				fileImportButton.disabled = false;
				fileImportButton.textContent = "Import from Files";
			}
		});
	}

	async processJSONText(jsonText: string, imageData?: string): Promise<{ success: number; errors: number }> {
		let success = 0;
		let errors = 0;

		try {
			const jsonData = JSON.parse(jsonText);

			if (!jsonData.data || !jsonData.data.workouts || !Array.isArray(jsonData.data.workouts)) {
				throw new Error("Invalid JSON format: expected data.workouts array");
			}

			const workouts = jsonData.data.workouts;
			for (const workout of workouts) {
				try {
					const filePath = await this.processWorkout(workout, imageData);
					// Save image if provided (only for first workout if multiple)
					if (imageData && workouts.indexOf(workout) === 0) {
						await saveImageForPlugin(this.plugin, imageData, filePath);
					}
					success++;
				} catch (error) {
					console.error("Error processing workout:", error);
					errors++;
				}
			}
		} catch (error) {
			console.error("Error parsing JSON:", error);
			throw new Error(`Invalid JSON: ${error}`);
		}

		return { success, errors };
	}

	async processFiles(files: File[]): Promise<{ success: number; errors: number }> {
		let success = 0;
		let errors = 0;

		for (const file of files) {
			try {
				const text = await file.text();
				const result = await this.processJSONText(text);
				success += result.success;
				errors += result.errors;
			} catch (error) {
				console.error(`Error processing file ${file.name}:`, error);
				new Notice(`Error processing ${file.name}: ${error}`);
				errors++;
			}
		}

		return { success, errors };
	}

	async processWorkout(workout: any, imageData?: string): Promise<string> {
		// Find matching template
		const workoutName = workout.name || "Unknown";
		const template = this.plugin.settings.templates.find(
			(t) => t.workoutType.toLowerCase() === workoutName.toLowerCase()
		);
		const templatePath = template?.templatePath || this.plugin.settings.defaultTemplatePath;

		if (!templatePath) {
			throw new Error(`No template found for workout type "${workoutName}" and no default template set`);
		}

		// Load template file
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath) as TFile;
		if (!templateFile) {
			throw new Error(`Template file not found: ${templatePath}`);
		}

		const templateContent = await this.app.vault.read(templateFile);

		// Generate file path from template
		const workoutDate = workout.start ? new Date(workout.start) : new Date();
		const filePath = generateWorkoutFilePath(this.plugin, workoutName, workoutDate);

		// Ensure parent folders exist
		const pathParts = filePath.split("/");
		const folderPath = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";
		if (folderPath) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			}
		}

		// Handle duplicate files by appending a number
		let finalFilePath = filePath;
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(finalFilePath)) {
			const pathParts2 = filePath.split("/");
			const fileName = pathParts2[pathParts2.length - 1];
			const folderPath = pathParts2.slice(0, -1).join("/");
			const baseName = fileName.replace(".md", "");
			const ext = ".md";
			const newFileName = `${baseName} (${counter})${ext}`;
			finalFilePath = folderPath ? `${folderPath}/${newFileName}` : newFileName;
			counter++;
		}

		// Save image first if provided, then calculate relative path
		let relativeImagePath: string | undefined;
		let savedImageExtension: string | undefined;
		const customImageFolder = resolveImageFolderPath(this.plugin, workoutDate, workoutName);

		let bannerImageData: string | undefined;

		if (imageData) {
			bannerImageData = imageData;
		} else {
			bannerImageData = await generateBannerImage(this.plugin, workout);
		}

		if (bannerImageData) {
				savedImageExtension = await saveImageForPlugin(
					this.plugin,
					bannerImageData,
					finalFilePath,
					customImageFolder
				);
			const pathParts = finalFilePath.split("/");
			const noteFileName = pathParts[pathParts.length - 1].replace(".md", "");
			const imageFolderForNote =
				customImageFolder || (folderPath ? `${folderPath}/assets` : "assets");
			relativeImagePath = `${imageFolderForNote}/${noteFileName}.${savedImageExtension}`;
		}

		// Apply key mappings to extract data
		const frontmatter: Record<string, any> = {};
		const mappedData: Record<string, any> = {};

		// Map workout data according to key mappings
		const mappings = getMappingsForWorkout(this.plugin, workout);
		for (const mapping of mappings) {
			if (!mapping.jsonKey || !mapping.yamlKey) continue;

			let value = extractMappingValue(this.plugin, workout, mapping.jsonKey);
			if (value !== undefined && value !== null) {
				// Apply rounding if specified and value is numeric
				if (mapping.rounding !== undefined && typeof value === "number") {
						value = applyRoundingValue(value, mapping.rounding);
				}
				mappedData[mapping.yamlKey] = value;
			}
		}

		// If no mappings exist, include all top-level fields
		if (mappings.length === 0) {
			Object.assign(mappedData, workout);
		}

		// Create note content with frontmatter
		const yamlFrontmatter = generateYAMLFrontmatterForPlugin(
			this.plugin,
			mappedData,
			templatePath,
			relativeImagePath,
			workoutName
		);
		const noteContent = `---\n${yamlFrontmatter}---\n\n${templateContent}`;

		// Create note
		await this.app.vault.create(finalFilePath, noteContent);
		
		return finalFilePath; // Return the file path for image saving
	}

	calculateRelativeImagePath(noteFilePath: string): string {
		const pathParts = noteFilePath.split("/");
		const folderPath = pathParts.slice(0, -1).join("/");
		const noteFileName = pathParts[pathParts.length - 1].replace(".md", "");
		
		// Image is in assets folder with same name as note
		// Determine extension from saved image (default to png)
		const imageFileName = `${noteFileName}.png`; // Default extension
		const assetsPath = folderPath ? `${folderPath}/assets/${imageFileName}` : `assets/${imageFileName}`;
		
		// Calculate relative path from note to image
		// If note is in same folder structure, relative path is just the path
		// For now, return the path from vault root (can be improved to be truly relative)
		return assetsPath;
	}

	generateFilePath(workoutName: string, workoutDate: Date): string {
		const folderTemplate = this.plugin.settings.workoutFolderPath?.trim();
		const fileTemplate =
			this.plugin.settings.saveDestination || "{YYYYMMDD-HHMM}-{name}.md";

		const expandedFolder = folderTemplate
			? expandPathTemplate(folderTemplate, workoutDate, workoutName)
			: "";
		let filePath = expandPathTemplate(fileTemplate, workoutDate, workoutName);

		if (expandedFolder) {
			filePath = `${expandedFolder}/${filePath}`;
		}

		filePath = normalizePath(filePath);

		if (!filePath.endsWith(".md")) {
			filePath += ".md";
		}
		
		return filePath;
	}

	async saveImage(
		imageData: string,
		noteFilePath: string,
		targetFolderPath?: string
	): Promise<string> {
		// Extract base64 data and determine file extension
		let base64Data = imageData;
		let extension = "png"; // default
		
		if (imageData.startsWith("data:image/")) {
			const match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
			if (match) {
				extension = match[1];
				base64Data = match[2];
			}
		}
		
		// Generate image filename from note filename
		const pathParts = noteFilePath.split("/");
		const noteFileName = pathParts[pathParts.length - 1].replace(".md", "");
		const folderPath = pathParts.slice(0, -1).join("/");
		const imageFileName = `${noteFileName}.${extension}`;
		
		// Create assets folder path
		const assetsFolderPath = targetFolderPath
			? normalizePath(targetFolderPath)
			: folderPath
			? `${folderPath}/assets`
			: "assets";
		const imagePath = `${assetsFolderPath}/${imageFileName}`;
		
		// Create assets folder if it doesn't exist
		const assetsFolder = this.app.vault.getAbstractFileByPath(assetsFolderPath);
		if (!assetsFolder) {
			await this.app.vault.createFolder(assetsFolderPath);
		}
		
		// Convert base64 to ArrayBuffer
		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		
		// Check if image already exists and delete it if so
		const existingImage = this.app.vault.getAbstractFileByPath(imagePath);
		if (existingImage instanceof TFile) {
			await this.app.vault.delete(existingImage);
		}
		
		// Save image
		await this.app.vault.createBinary(imagePath, bytes.buffer);
		
		return extension; // Return the extension for calculating relative path
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

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

function getMappingsForWorkout(plugin: WorkoutImporterPlugin, workout: any): KeyMapping[] {
	if (workout?.sourceCsv) {
		return plugin.settings.csvKeyMappings;
	}

	return plugin.settings.keyMappings;
}

// Get colors from Obsidian's active theme
function getObsidianThemeColors(): {
	background: string;
	text: string;
	accent: string;
	interactive: string;
} {
	const computedStyle = getComputedStyle(document.body);
	return {
		background: computedStyle.getPropertyValue("--background-primary").trim() || "#1e1e1e",
		text: computedStyle.getPropertyValue("--text-normal").trim() || "#dcddde",
		accent: computedStyle.getPropertyValue("--interactive-accent").trim() || "#7f6df2",
		interactive: computedStyle.getPropertyValue("--interactive-hover").trim() || "#4a4a4a",
	};
}

async function generateBannerImage(
	plugin: WorkoutImporterPlugin,
	workout: any
): Promise<string> {
	const width = 900;
	const height = 300;
	
	const canvas =
		typeof document !== "undefined"
			? document.createElement("canvas")
			: null;
	if (!canvas) {
		throw new Error("Canvas is not available in this environment");
	}

	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("Unable to get canvas context");
	}

	// Get colors from active Obsidian theme
	const colors = getObsidianThemeColors();

	// Background
	ctx.fillStyle = colors.background;
	ctx.fillRect(0, 0, width, height);

	const workoutName = workout.name || "Workout";
	const startDate = workout.start ? new Date(workout.start) : new Date();
	const endDate =
		workout.end !== undefined && workout.end !== null
			? new Date(workout.end)
			: new Date(startDate.getTime() + (workout.duration ?? 0) * 1000);

	const dateLabel = `${formatDate(startDate)} • ${formatTime(startDate)} - ${formatTime(endDate)}`;

	// Workout icon/emoji (top left, Apple-style)
	const emoji = getWorkoutEmoji(workoutName);
	const iconSize = 70;
	const iconX = 40;
	const iconY = 25;
	
	// Draw icon background circle
	ctx.fillStyle = hexToRgba(colors.accent, 0.2);
	ctx.beginPath();
	ctx.arc(iconX + iconSize/2, iconY + iconSize/2, iconSize/2, 0, Math.PI * 2);
	ctx.fill();
	
	// Draw emoji
	ctx.font = `${iconSize * 0.55}px Inter, sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = colors.text;
	ctx.fillText(emoji, iconX + iconSize/2, iconY + iconSize/2);

	// Workout name (next to icon)
	ctx.textAlign = "left";
	ctx.textBaseline = "top";
	ctx.font = "bold 36px Inter, sans-serif";
	ctx.fillStyle = colors.text;
	ctx.fillText(workoutName.toUpperCase(), iconX + iconSize + 20, iconY + 5);

	// Date/time label
	ctx.font = "14px Inter, sans-serif";
	ctx.fillStyle = hexToRgba(colors.text, 0.6);
	ctx.fillText(dateLabel, iconX + iconSize + 20, iconY + 50);

	// Get stat values
	const caloriesValue =
		readNestedValue(workout, "activeEnergyBurned.qty") ?? readNestedValue(workout, "activeCalories");
	const avgHrValue =
		readNestedValue(workout, "avgHeartRate") ??
		readNestedValue(workout, "avgHR") ??
		readNestedValue(workout, "avgHeartRate");
	const maxHrValue =
		readNestedValue(workout, "maxHeartRate") ??
		readNestedValue(workout, "maxHR") ??
		readNestedValue(workout, "maxHeartRate");
	const minHrValue =
		readNestedValue(workout, "minHeartRate") ??
		readNestedValue(workout, "minHR");

	// Stats in single horizontal row
	const stats = [
		{ 
			label: "Total Time", 
			value: formatDuration(workout.duration), 
			unit: "",
			color: "#ffbe0b" 
		},
		{ 
			label: "Calories", 
			value: caloriesValue ? Math.round(caloriesValue).toString() : "—", 
			unit: "CAL",
			color: "#ff006e" 
		},
		{ 
			label: "Avg HR", 
			value: avgHrValue ? Math.round(avgHrValue).toString() : "—", 
			unit: "BPM",
			color: "#ff453a" 
		},
		{ 
			label: "Max HR", 
			value: maxHrValue ? Math.round(maxHrValue).toString() : "—", 
			unit: "BPM",
			color: "#ff453a" 
		},
	];

	const statsTop = 140;
	const boxWidth = 200;
	const boxHeight = 100;
	const gapX = 15;
	const statLeftMargin = 40;

	stats.forEach((stat, index) => {
		const x = statLeftMargin + index * (boxWidth + gapX);
		const y = statsTop;

		// Stat label (smaller, subdued)
		ctx.fillStyle = hexToRgba(colors.text, 0.5);
		ctx.font = "11px Inter, sans-serif";
		ctx.fillText(stat.label, x, y);

		// Stat value (large, colored)
		ctx.font = "bold 44px Inter, sans-serif";
		ctx.fillStyle = stat.color;
		const valueY = y + 28;
		ctx.fillText(stat.value, x, valueY);
		
		// Unit (if present, smaller next to value)
		if (stat.unit) {
			const valueWidth = ctx.measureText(stat.value).width;
			ctx.font = "14px Inter, sans-serif";
			ctx.fillStyle = stat.color;
			ctx.fillText(stat.unit, x + valueWidth + 6, valueY + 26);
		}

		// Vertical divider between stats (except after last one)
		if (index < stats.length - 1) {
			ctx.strokeStyle = hexToRgba(colors.text, 0.15);
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x + boxWidth + gapX/2, y - 8);
			ctx.lineTo(x + boxWidth + gapX/2, y + boxHeight - 8);
			ctx.stroke();
		}
	});

	return canvas.toDataURL("image/png");
}

// Helper function to get workout emoji based on type
function getWorkoutEmoji(workoutName: string): string {
	const name = workoutName.toLowerCase();
	if (name.includes("run")) return "🏃";
	if (name.includes("walk")) return "🚶";
	if (name.includes("cycle") || name.includes("bike")) return "🚴";
	if (name.includes("swim")) return "🏊";
	if (name.includes("yoga") || name.includes("mind")) return "🧘";
	if (name.includes("hiit") || name.includes("training")) return "💪";
	if (name.includes("strength")) return "🏋️";
	if (name.includes("dance")) return "💃";
	if (name.includes("row")) return "🚣";
	if (name.includes("hike")) return "⛰️";
	return "💪"; // Default
}

// ============================================================================
// CHART GENERATION CODE (preserved for future use in note body)
// ============================================================================
// Uncomment and adapt this code when adding optional charts to workout notes
/*
async function generateHeartRateChart(
	plugin: WorkoutImporterPlugin,
	workout: any,
	width: number = 1200,
	height: number = 400
): Promise<string> {
	const canvas =
		typeof document !== "undefined"
			? document.createElement("canvas")
			: null;
	if (!canvas) {
		throw new Error("Canvas is not available in this environment");
	}

	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("Unable to get canvas context");
	}

	const colors = getObsidianThemeColors();
	const chartLeft = 60;
	const chartTop = 60;
	const chartWidth = width - chartLeft * 2;
	const chartHeight = height - chartTop - 60;
	
	// Background
	ctx.fillStyle = colors.background;
	ctx.fillRect(0, 0, width, height);
	
	// Chart background
	ctx.fillStyle = hexToRgba(colors.interactive, 0.3);
	ctx.fillRect(chartLeft, chartTop, chartWidth, chartHeight);
	
	// Border
	ctx.strokeStyle = hexToRgba(colors.accent, 0.5);
	ctx.lineWidth = 2;
	ctx.strokeRect(chartLeft, chartTop, chartWidth, chartHeight);

	// Grid lines
	const gridRows = 3;
	ctx.strokeStyle = hexToRgba(colors.text, 0.1);
	ctx.lineWidth = 1;
	for (let row = 1; row <= gridRows; row++) {
		const y = chartTop + (row / (gridRows + 1)) * chartHeight;
		ctx.beginPath();
		ctx.moveTo(chartLeft, y);
		ctx.lineTo(chartLeft + chartWidth, y);
		ctx.stroke();
	}

	// Get heart rate data
	const heartSeries = getHeartRateSeries(plugin, workout);
	if (heartSeries.length > 0) {
		const minValue = Math.min(...heartSeries);
		const maxValue = Math.max(...heartSeries);
		const range = Math.max(maxValue - minValue, 10);
		const interval = Math.max(heartSeries.length - 1, 1);
		
		const chartPadding = chartHeight * 0.1;
		const effectiveHeight = chartHeight - 2 * chartPadding;

		// Draw line
		ctx.beginPath();
		heartSeries.forEach((value, index) => {
			const x = chartLeft + (index / interval) * chartWidth;
			const normalizedValue = (value - minValue) / range;
			const y = chartTop + chartHeight - chartPadding - (normalizedValue * effectiveHeight);
			if (index === 0) {
				ctx.moveTo(x, y);
			} else {
				ctx.lineTo(x, y);
			}
		});
		ctx.strokeStyle = "#ff006e";
		ctx.lineWidth = 3;
		ctx.stroke();

		// Draw dots
		heartSeries.forEach((value, index) => {
			const x = chartLeft + (index / interval) * chartWidth;
			const normalizedValue = (value - minValue) / range;
			const y = chartTop + chartHeight - chartPadding - (normalizedValue * effectiveHeight);
			
			ctx.fillStyle = "#ff006e";
			ctx.beginPath();
			ctx.arc(x, y, 4, 0, Math.PI * 2);
			ctx.fill();
		});
	}

	// Chart label
	ctx.font = "16px Inter, sans-serif";
	ctx.fillStyle = hexToRgba(colors.text, 0.7);
	ctx.textAlign = "left";
	ctx.fillText("HEART RATE", chartLeft + 8, chartTop - 24);

	return canvas.toDataURL("image/png");
}
*/
// ============================================================================

function getHeartRateSeries(plugin: WorkoutImporterPlugin, workout: any): number[] {
	if (Array.isArray(workout.heartRateSeries) && workout.heartRateSeries.length > 0) {
		return workout.heartRateSeries;
	}

	const avg = Number(
		readNestedValue(workout, "avgHeartRate") ?? readNestedValue(workout, "avgHR") ?? workout.avgHeartRate
	);
	const max = Number(
		readNestedValue(workout, "maxHeartRate") ?? readNestedValue(workout, "maxHR") ?? workout.maxHeartRate
	);

	const avgValue = Number.isFinite(avg) ? avg : 95;
	const maxValue = Number.isFinite(max) ? Math.max(max, avgValue + 5) : avgValue + 12;
	const minValue = Math.max(40, avgValue - 15);
	const durationSeconds = Number(workout.duration ?? 0);
	const points = Math.max(10, Math.min(30, Math.round(durationSeconds / 20) || 12));
	const series: number[] = [];

	for (let i = 0; i < points; i++) {
		const progress = points === 1 ? 0 : i / (points - 1);
		const swing = Math.sin(progress * Math.PI * 2) * 4;
		const base = minValue + (maxValue - minValue) * (0.35 + progress * 0.5);
		series.push(base + swing);
	}

	return series;
}

function formatDuration(value?: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return "00:00";
	}

	const totalSeconds = Math.round(value);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	}

	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatDate(date?: Date): string {
	if (!date) return "";
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatTime(date?: Date): string {
	if (!date) return "";
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

function hexToRgba(hex: string, alpha: number): string {
	let sanitized = hex.replace("#", "");
	if (sanitized.length === 3) {
		sanitized = sanitized
			.split("")
			.map((char) => char + char)
			.join("");
	}
	const numeric = parseInt(sanitized, 16);
	if (Number.isNaN(numeric)) {
		return `rgba(255,255,255,${alpha})`;
	}
	const r = (numeric >> 16) & 255;
	const g = (numeric >> 8) & 255;
	const b = numeric & 255;
	return `rgba(${r},${g},${b},${alpha})`;
}

function expandPathTemplate(template: string, workoutDate: Date, workoutName: string): string {
	const year = workoutDate.getFullYear().toString();
	const month = (workoutDate.getMonth() + 1).toString().padStart(2, "0");
	const day = workoutDate.getDate().toString().padStart(2, "0");
	const hours = workoutDate.getHours().toString().padStart(2, "0");
	const minutes = workoutDate.getMinutes().toString().padStart(2, "0");

	const date = `${year}${month}${day}`;
	const dateTime = `${year}${month}${day}-${hours}${minutes}`;
	const sanitizedName = workoutName.replace(/[<>:"/\\|?*]/g, "-");

	return template
		.replace(/{YYYY}/gi, year)
		.replace(/{MM}/gi, month)
		.replace(/{DD}/gi, day)
		.replace(/{YYYYMM}/gi, `${year}${month}`)
		.replace(/{YYYYMMDD}/gi, date)
		.replace(/{YYYYMMDD-HHMM}/gi, dateTime)
		.replace(/{HH}/gi, hours)
		.replace(/{mm}/gi, minutes)
		.replace(/{name}/gi, sanitizedName);
}

function generateWorkoutFilePath(
	plugin: WorkoutImporterPlugin,
	workoutName: string,
	workoutDate: Date
): string {
	const folderTemplate = plugin.settings.workoutFolderPath?.trim();
	const fileTemplate = plugin.settings.saveDestination || "{YYYYMMDD-HHMM}-{name}.md";

	const expandedFolder = folderTemplate
		? expandPathTemplate(folderTemplate, workoutDate, workoutName)
		: "";
	let filePath = expandPathTemplate(fileTemplate, workoutDate, workoutName);

	if (expandedFolder) {
		filePath = `${expandedFolder}/${filePath}`;
	}

	filePath = normalizePath(filePath);

	if (!filePath.endsWith(".md")) {
		filePath += ".md";
	}

	return filePath;
}

async function saveImageForPlugin(
	plugin: WorkoutImporterPlugin,
	imageData: string,
	noteFilePath: string,
	targetFolderPath?: string
): Promise<string> {
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
	const imageFileName = `${noteFileName}.${extension}`;

	const assetsFolderPath = targetFolderPath
		? normalizePath(targetFolderPath)
		: folderPath
		? `${folderPath}/assets`
		: "assets";
	const imagePath = `${assetsFolderPath}/${imageFileName}`;

	const assetsFolder = plugin.app.vault.getAbstractFileByPath(assetsFolderPath);
	if (!assetsFolder) {
		await plugin.app.vault.createFolder(assetsFolderPath);
	}

	const binaryString = atob(base64Data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	// Check if image already exists and delete it if so
	const existingImage = plugin.app.vault.getAbstractFileByPath(imagePath);
	if (existingImage instanceof TFile) {
		await plugin.app.vault.delete(existingImage);
	}

	await plugin.app.vault.createBinary(imagePath, bytes.buffer);

	return extension;
}

function resolveImageFolderPath(
	plugin: WorkoutImporterPlugin,
	date: Date,
	workoutName: string
): string | undefined {
	const template = plugin.settings.imageFolderPath?.trim();
	return template ? normalizePath(expandPathTemplate(template, date, workoutName)) : undefined;
}

function extractMappingValue(plugin: WorkoutImporterPlugin, workout: any, mappingKey: string): any {
	let value = readNestedValue(workout, mappingKey);
	if ((value === undefined || value === null) && workout?.sourceCsv) {
		value = workout.sourceCsv[mappingKey];
	}

	if (typeof value === "string") {
		const parsed = tryParseNumber(value);
		if (parsed !== undefined) {
			value = parsed;
		}
	}

	// If the value is an ISO date string, convert it to a Date object
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
		const date = new Date(value);
		if (!isNaN(date.getTime())) {
			value = date;
		}
	}

	return value;
}

function tryParseNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = parseFloat(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function applyRoundingValue(value: number, rounding: number): number {
	if (rounding < 0) return value;

	const decimalPlaces = (value.toString().split(".")[1] || "").length;
	if (decimalPlaces <= rounding) {
		return value;
	}

	const factor = Math.pow(10, rounding);
	return Math.round(value * factor) / factor;
}

function resolveTemplateVariables(
		value: string,
		templatePath: string,
		relativeImagePath?: string,
		workoutName?: string
	): string {
		let resolved = value;
		
		if (relativeImagePath) {
			resolved = resolved.replace(/{image}/g, relativeImagePath);
		} else {
			resolved = resolved.replace(/{image}/g, "");
		}
		
		resolved = resolved.replace(/{template}/g, templatePath);
		
		if (workoutName) {
			resolved = resolved.replace(/{name}/g, workoutName);
		}
		
		return resolved;
	}

function formatYAMLValue(value: any): string {
		if (typeof value === "string") {
			if (value.includes(":") || value.includes('"') || value.includes("'") || value.includes("\n")) {
				return `"${value.replace(/"/g, '\\"')}"`;
			}
			return value;
		}
	if (typeof value === "number" || typeof value === "boolean") {
			return value.toString();
		}
		if (value instanceof Date) {
			return value.toISOString();
		}
		return String(value);
	}

function generateYAMLFrontmatterForPlugin(
	plugin: WorkoutImporterPlugin,
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
				lines.push(`${key}: ${formatYAMLValue(value.qty)}`);
				if (value.units) {
					lines.push(`${key}Units: ${formatYAMLValue(value.units)}`);
				}
			} else {
				lines.push(`${key}: ${formatYAMLValue(JSON.stringify(value))}`);
			}
		} else {
			lines.push(`${key}: ${formatYAMLValue(value)}`);
		}
	}

	for (const field of plugin.settings.additionalFrontMatter) {
		if (!field.key) continue;

		const resolvedValue = resolveTemplateVariables(
			field.value,
			templatePath,
			relativeImagePath,
			workoutName
		);

		if (resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== "") {
			lines.push(`${field.key}: ${formatYAMLValue(resolvedValue)}`);
		}
	}

	return lines.join("\n") + "\n";
}

function readNestedValue(obj: any, path: string): any {
	if (!path) return undefined;
	const keys = path.split(".");
	let value = obj;
	for (const key of keys) {
		if (value === null || value === undefined) return undefined;
		value = value[key];
	}
	return value;
}

interface ZipEntryInfo {
	name: string;
	compressionMethod: number;
	compressedSize: number;
	dataStart: number;
}

const TEXT_DECODER = new TextDecoder();

function parseZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
	const entries: ZipEntryInfo[] = [];
	if (bytes.length < 22) {
		return entries;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocdOffset = findEndOfCentralDirectory(bytes);
	if (eocdOffset === -1) {
		return entries;
	}

	const totalEntries = view.getUint16(eocdOffset + 10, true);
	const centralDirOffset = view.getUint32(eocdOffset + 16, true);
	let offset = centralDirOffset;

	for (let i = 0; i < totalEntries && offset + 46 <= bytes.length; i++) {
		if (view.getUint32(offset, true) !== 0x02014b50) {
			break;
		}

		const fileNameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const compressionMethod = view.getUint16(offset + 10, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const localHeaderOffset = view.getUint32(offset + 42, true);

		if (offset + 46 + fileNameLength > bytes.length) {
			break;
		}

		const fileNameBytes = bytes.subarray(offset + 46, offset + 46 + fileNameLength);
		const fileName = TEXT_DECODER.decode(fileNameBytes);

		if (localHeaderOffset + 30 > bytes.length) {
			break;
		}

		const localNameLength = view.getUint16(localHeaderOffset + 26, true);
		const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
		const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;

		if (dataStart + compressedSize > bytes.length) {
			offset += 46 + fileNameLength + extraLength + commentLength;
			continue;
		}

		entries.push({
			name: fileName,
			compressionMethod,
			compressedSize,
			dataStart,
		});

		offset += 46 + fileNameLength + extraLength + commentLength;
	}

	return entries;
}

function decodeZipEntry(bytes: Uint8Array, entry: ZipEntryInfo): string | null {
	if (entry.dataStart + entry.compressedSize > bytes.length) {
		return null;
	}

	const slice = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
	if (entry.compressionMethod === 0) {
		return TEXT_DECODER.decode(slice);
	}

	if (entry.compressionMethod === 8) {
		const inflated = inflateRawSync(Buffer.from(slice));
		return TEXT_DECODER.decode(inflated);
	}

	console.warn("Unsupported compression method", entry.compressionMethod, entry.name);
	return null;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
	if (bytes.length < 22) {
		return -1;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const maxSearch = Math.min(bytes.length - 22, 0xffff);
	for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - maxSearch; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			return i;
		}
	}

	return -1;
}