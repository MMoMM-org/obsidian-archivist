import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const banner = `/* Archivist — versioned Obsidian vault backups to Dropbox. MIT. */`;

const isDev = process.argv.includes("--dev");
const outdir = isDev ? "test/Archivist/.obsidian/plugins/obsidian-archivist" : ".";

// Copy plugin assets on each rebuild
const copyAssets = {
	name: "copy-assets",
	setup(build) {
		build.onEnd(() => {
			mkdirSync(outdir, { recursive: true });
			// Manifest and styles may not exist yet during early Phase 1 bootstrap —
			// copy only when present. manifest.json is authored in T1.1; styles.css
			// first appears in Phase 9 UI work.
			if (existsSync("manifest.json")) copyFileSync("manifest.json", `${outdir}/manifest.json`);
			if (existsSync("styles.css")) copyFileSync("styles.css", `${outdir}/styles.css`);
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
