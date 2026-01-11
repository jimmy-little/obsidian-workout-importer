import { copyFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

const VAULT_PATH = "/Users/jimmy/Library/Mobile Documents/iCloud~md~obsidian/Documents/JimmyOS";
const PLUGIN_DIR = join(VAULT_PATH, ".obsidian", "plugins", "workout-importer");

const filesToCopy = ["main.js", "manifest.json", "versions.json"];

async function install() {
	try {
		// Ensure plugin directory exists
		await mkdir(PLUGIN_DIR, { recursive: true });
		
		// Copy each file
		for (const file of filesToCopy) {
			const source = join(process.cwd(), file);
			const dest = join(PLUGIN_DIR, file);
			await copyFile(source, dest);
			console.log(`✓ Copied ${file}`);
		}
		
		console.log(`\n✓ Plugin installed to: ${PLUGIN_DIR}`);
	} catch (error) {
		console.error("Error installing plugin:", error);
		process.exit(1);
	}
}

install();
