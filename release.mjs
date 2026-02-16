#!/usr/bin/env node
/**
 * Bump manifest version by +0.0.1 (patch), build, and create a GitHub release
 * with main.js, manifest.json, versions.json, and styles.css (if present) as assets.
 *
 * Prereqs: gh CLI installed and authenticated (brew install gh && gh auth login)
 * Usage: node release.mjs [--no-push]   (default: bump, build, commit, tag, push, create release)
 *        --no-push: only bump version and build; do not commit, push, or create release
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const noPush = process.argv.includes("--no-push");

function bumpVersion() {
  const manifestPath = "manifest.json";
  const versionsPath = "versions.json";

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const current = manifest.version;
  const parts = current.split(".").map(Number);
  if (parts.length < 3) {
    parts[0] = parts[0] ?? 0;
    parts[1] = parts[1] ?? 0;
    parts[2] = 0;
  }
  parts[2] = (parts[2] ?? 0) + 1;
  const newVersion = parts.join(".");

  manifest.version = newVersion;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

  const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
  versions[newVersion] = manifest.minAppVersion;
  writeFileSync(versionsPath, JSON.stringify(versions, null, "\t"));

  console.log(`Version bumped: ${current} → ${newVersion}`);
  return newVersion;
}

function build() {
  console.log("Building...");
  execSync("npm run build", { stdio: "inherit" });
}

function getReleaseAssets() {
  const assets = [];
  if (existsSync("main.js")) assets.push("main.js");
  if (existsSync("manifest.json")) assets.push("manifest.json");
  if (existsSync("versions.json")) assets.push("versions.json");
  if (existsSync("styles.css")) assets.push("styles.css");
  return assets;
}

function createRelease(version) {
  const tag = `v${version}`;
  const assets = getReleaseAssets();
  if (assets.length === 0) {
    console.error("No release assets found (main.js, manifest.json, versions.json, styles.css).");
    process.exit(1);
  }
  console.log(`Release assets: ${assets.join(", ")}`);
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    console.error("gh CLI not found. Install: brew install gh && gh auth login");
    process.exit(1);
  }
  const args = [
    "release", "create", tag,
    ...assets,
    "--title", tag,
    "--notes", `Release ${tag}`,
  ];
  execSync("gh " + args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "), { stdio: "inherit" });
  console.log(`Release ${tag} created.`);
}

function main() {
  const version = bumpVersion();
  build();
  if (noPush) {
    console.log("Done (--no-push: not committing, pushing, or creating release).");
    return;
  }
  try {
    execSync("git add manifest.json versions.json", { stdio: "inherit" });
    execSync(`git commit -m "Release ${version}"`, { stdio: "inherit" });
    execSync(`git tag v${version}`, { stdio: "inherit" });
    execSync("git push && git push --tags", { stdio: "inherit" });
  } catch (e) {
    console.error("Git commit/push failed. Bump and build are done; fix git state and run:");
    console.error(`  gh release create v${version} ${getReleaseAssets().join(" ")} --title "v${version}" --notes "Release v${version}"`);
    process.exit(1);
  }
  createRelease(version);
}

main();
