import { copyFile, mkdir, access } from "fs/promises";
import { join } from "path";

// Set OBSIDIAN_VAULT to override (e.g. export OBSIDIAN_VAULT="/path/to/vault")
const DEFAULT_VAULT = "/Users/jimmy/Library/Mobile Documents/iCloud~md~obsidian/Documents/JimmyOS";
const VAULT_PATH = process.env.OBSIDIAN_VAULT || DEFAULT_VAULT;
const PLUGIN_DIR = join(VAULT_PATH, ".obsidian", "plugins", "workout-importer");

const filesToCopy = ["main.js", "manifest.json", "versions.json"];

async function install() {
	try {
		// Ensure build artifacts exist
		for (const file of filesToCopy) {
			try {
				await access(join(process.cwd(), file));
			} catch {
				console.error(`Missing ${file}. Run: npm run build`);
				process.exit(1);
			}
		}

		await mkdir(PLUGIN_DIR, { recursive: true });

		for (const file of filesToCopy) {
			const source = join(process.cwd(), file);
			const dest = join(PLUGIN_DIR, file);
			await copyFile(source, dest);
			console.log(`✓ ${file}`);
		}

		console.log(`\n✓ Installed to: ${PLUGIN_DIR}`);
	} catch (error) {
		console.error("Install failed:", error.message);
		process.exit(1);
	}
}

install();
