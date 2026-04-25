import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const banner = `/* Archivist — versioned Obsidian vault backups to Dropbox. MIT. */`;

const isDev = process.argv.includes("--dev");
const TEST_VAULT_DIR = "test/Archivist/.obsidian/plugins/obsidian-archivist";
const outdir = isDev ? TEST_VAULT_DIR : ".";

// Copy plugin assets on each rebuild. Production builds additionally mirror
// the bundle into the local test vault when it exists — so manual UI/behaviour
// verification always uses the latest build. The vault is git-ignored and
// absent in CI/release contexts, so the mirror step is a safe no-op there.
const copyAssets = {
	name: "copy-assets",
	setup(build) {
		build.onEnd(() => {
			mkdirSync(outdir, { recursive: true });
			if (existsSync("manifest.json")) copyFileSync("manifest.json", `${outdir}/manifest.json`);
			if (existsSync("styles.css")) copyFileSync("styles.css", `${outdir}/styles.css`);

			if (!isDev && existsSync("test/Archivist/.obsidian/plugins")) {
				mkdirSync(TEST_VAULT_DIR, { recursive: true });
				copyFileSync("main.js", `${TEST_VAULT_DIR}/main.js`);
				if (existsSync("manifest.json")) copyFileSync("manifest.json", `${TEST_VAULT_DIR}/manifest.json`);
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
