import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

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
};

export default class WorkoutImporterPlugin extends Plugin {
	settings: WorkoutImporterSettings;

	async onload() {
		await this.loadSettings();

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
			.setDesc("Template path with variables: {YYYY} (year), {MM} (month), {YYYYMMDD-HHMM} (date-time), {name} (workout name)")
			.addText((text) => {
				text.setPlaceholder("Workouts/{YYYY}/{MM}/{YYYYMMDD-HHMM}-{name}.md")
					.setValue(this.plugin.settings.saveDestination)
					.onChange(async (value) => {
						this.plugin.settings.saveDestination = value;
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

		// Key Mappings Section
		containerEl.createEl("h3", { text: "JSON to YAML Key Mappings" });
		
		const mappingsDesc = containerEl.createEl("p", {
			text: "Map JSON keys from AutoExport to YAML frontmatter keys. Rounding: number of decimal places (0 = whole numbers, 1 = tenths, etc.)",
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
						await this.saveImage(imageData, filePath);
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
		const workoutDate = workout.start
			? new Date(workout.start)
			: new Date();
		
		const filePath = this.generateFilePath(workoutName, workoutDate);

		// Ensure parent folders exist
		const pathParts = filePath.split("/");
		if (pathParts.length > 1) {
			const folderPath = pathParts.slice(0, -1).join("/");
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
		if (imageData) {
			savedImageExtension = await this.saveImage(imageData, finalFilePath);
			const pathParts = finalFilePath.split("/");
			const noteFileName = pathParts[pathParts.length - 1].replace(".md", "");
			relativeImagePath = `assets/${noteFileName}.${savedImageExtension}`;
		}

		// Apply key mappings to extract data
		const frontmatter: Record<string, any> = {};
		const mappedData: Record<string, any> = {};

		// Map workout data according to key mappings
		for (const mapping of this.plugin.settings.keyMappings) {
			if (!mapping.jsonKey || !mapping.yamlKey) continue;

			let value = this.getNestedValue(workout, mapping.jsonKey);
			if (value !== undefined && value !== null) {
				// Apply rounding if specified and value is numeric
				if (mapping.rounding !== undefined && typeof value === "number") {
					value = this.applyRounding(value, mapping.rounding);
				}
				mappedData[mapping.yamlKey] = value;
			}
		}

		// If no mappings exist, include all top-level fields
		if (this.plugin.settings.keyMappings.length === 0) {
			Object.assign(mappedData, workout);
		}

		// Create note content with frontmatter
		const yamlFrontmatter = this.generateYAMLFrontmatter(
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
		const template = this.plugin.settings.saveDestination || "{YYYY}/{MM}/{YYYYMMDD-HHMM}-{name}.md";
		
		const year = workoutDate.getFullYear().toString();
		const month = (workoutDate.getMonth() + 1).toString().padStart(2, "0");
		const day = workoutDate.getDate().toString().padStart(2, "0");
		const hours = workoutDate.getHours().toString().padStart(2, "0");
		const minutes = workoutDate.getMinutes().toString().padStart(2, "0");
		
		const dateTimeStr = `${year}${month}${day}-${hours}${minutes}`;
		
		// Sanitize workout name for filename
		const sanitizedName = workoutName.replace(/[<>:"/\\|?*]/g, "-");
		
		let filePath = template
			.replace(/{YYYY}/g, year)
			.replace(/{MM}/g, month)
			.replace(/{YYYYMMDD-HHMM}/g, dateTimeStr)
			.replace(/{name}/g, sanitizedName);
		
		// Ensure .md extension if not present
		if (!filePath.endsWith(".md")) {
			filePath += ".md";
		}
		
		return filePath;
	}

	async saveImage(imageData: string, noteFilePath: string): Promise<string> {
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
		const assetsFolderPath = folderPath ? `${folderPath}/assets` : "assets";
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
		
		// Save image
		await this.app.vault.createBinary(imagePath, bytes.buffer);
		
		return extension; // Return the extension for calculating relative path
	}

	applyRounding(value: number, rounding: number): number {
		// If rounding is 0 or positive, apply it
		if (rounding < 0) return value;
		
		// Check if value already has fewer decimal places
		const decimalPlaces = (value.toString().split(".")[1] || "").length;
		if (decimalPlaces <= rounding) {
			return value; // Already has fewer or equal decimal places
		}
		
		// Round to specified decimal places
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
		
		// Add mapped data
		for (const [key, value] of Object.entries(data)) {
			if (value === null || value === undefined) continue;

			// Handle nested objects (like activeEnergyBurned: { qty: 100, units: "kcal" })
			if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
				// For nested objects, we can flatten them or keep them as objects
				// Let's flatten common patterns like { qty: X, units: Y } to just the value
				if (value.qty !== undefined) {
					lines.push(`${key}: ${this.formatYAMLValue(value.qty)}`);
					if (value.units) {
						lines.push(`${key}Units: ${this.formatYAMLValue(value.units)}`);
					}
				} else {
					// Complex object - convert to JSON string or skip
					lines.push(`${key}: ${this.formatYAMLValue(JSON.stringify(value))}`);
				}
			} else {
				lines.push(`${key}: ${this.formatYAMLValue(value)}`);
			}
		}

		// Add additional front matter fields
		for (const field of this.plugin.settings.additionalFrontMatter) {
			if (!field.key) continue; // Skip empty keys
			
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
		
		return lines.join("\n") + "\n";
	}

	resolveTemplateVariables(
		value: string,
		templatePath: string,
		relativeImagePath?: string,
		workoutName?: string
	): string {
		let resolved = value;
		
		// Resolve {image}
		if (relativeImagePath) {
			resolved = resolved.replace(/{image}/g, relativeImagePath);
		} else {
			// If no image, remove {image} placeholder
			resolved = resolved.replace(/{image}/g, "");
		}
		
		// Resolve {template}
		resolved = resolved.replace(/{template}/g, templatePath);
		
		// Resolve {name}
		if (workoutName) {
			resolved = resolved.replace(/{name}/g, workoutName);
		}
		
		return resolved;
	}

	formatYAMLValue(value: any): string {
		if (typeof value === "string") {
			// Escape quotes and wrap in quotes if needed
			if (value.includes(":") || value.includes('"') || value.includes("'") || value.includes("\n")) {
				return `"${value.replace(/"/g, '\\"')}"`;
			}
			return value;
		}
		if (typeof value === "number") {
			return value.toString();
		}
		if (typeof value === "boolean") {
			return value.toString();
		}
		if (value instanceof Date) {
			return value.toISOString();
		}
		return String(value);
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}