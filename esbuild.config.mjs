import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const banner = `/* Archivist — versioned Obsidian vault backups to Dropbox. MIT. */`;

const isDev = process.argv.includes("--dev");
const TEST_VAULT_DIR = "test/Archivist/.obsidian/plugins/obsidian-archivist";
const outdir = isDev ? TEST_VAULT_DIR : "build";

/**
 * Write a manifest.json to `targetDir` with a dev-suffixed version so
 * Obsidian's hot-reload + plugin manager see every build as a fresh
 * version (no stale-module caching). The repo-level manifest.json is
 * never modified — only the deployed test-vault copy gets the suffix,
 * and only when we're mirroring into a real test vault.
 *
 * Source `manifest.version` stays the canonical V1 release version
 * (e.g. "0.1.0") so GitHub Releases / Community Plugin manifest stay
 * clean.
 */
function writeDevManifest(targetDir) {
	if (!existsSync("manifest.json")) return;
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	const baseVersion = manifest.version;
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	manifest.version = `${baseVersion}-dev.${stamp}`;
	writeFileSync(`${targetDir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
}

// Copy plugin assets on each rebuild. Production builds additionally mirror
// the bundle into the local test vault when it exists — so manual UI/behaviour
// verification always uses the latest build. The vault is git-ignored and
// absent in CI/release contexts, so the mirror step is a safe no-op there.
const copyAssets = {
	name: "copy-assets",
	setup(build) {
		build.onEnd(() => {
			mkdirSync(outdir, { recursive: true });
			// In `--dev` (watch) mode `outdir` IS the test vault, so we need the
			// dev-suffixed manifest there. In production builds `outdir` is
			// the repo root — keep the canonical manifest unmodified.
			if (isDev && existsSync("manifest.json")) {
				writeDevManifest(outdir);
			} else if (existsSync("manifest.json")) {
				copyFileSync("manifest.json", `${outdir}/manifest.json`);
			}
			if (existsSync("styles.css")) copyFileSync("styles.css", `${outdir}/styles.css`);

			if (!isDev && existsSync("test/Archivist/.obsidian/plugins")) {
				mkdirSync(TEST_VAULT_DIR, { recursive: true });
				copyFileSync(`${outdir}/main.js`, `${TEST_VAULT_DIR}/main.js`);
				// Test-vault manifest gets the dev suffix so Obsidian's plugin
				// loader treats every rebuild as a new version (defeats any
				// stale-module caching). Repo-level manifest.json is left alone.
				writeDevManifest(TEST_VAULT_DIR);
				if (existsSync("styles.css")) copyFileSync("styles.css", `${TEST_VAULT_DIR}/styles.css`);
			}
		});
	},
};

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"fs",
		"path",
		"crypto",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: isDev,
	// Strip console.debug in production (esbuild 0.24+ uses 'pure' for selective drops).
	// 'debugger' keyword is dropped separately if needed; 'debug' is not a valid drop target.
	pure: isDev ? [] : ["console.debug"],
	minify: false,
	outfile: `${outdir}/main.js`,
	plugins: [copyAssets],
});

if (isDev) {
	await context.watch();
} else {
	await context.rebuild();
	process.exit(0);
}
