import esbuild from "esbuild";

esbuild
	.build({
		entryPoints: [{ out: "index", in: "src/index.mjs" }],
		outdir: ".",
		outExtension: { ".js": ".mjs" },
		bundle: true,
		platform: "node",
		format: "esm",
		minify: true,
		sourcemap: true,
		plugins: [],
	})
	.then(() => console.log("⚡ Build JS complete! ⚡"))
	.catch(() => process.exit(1));

esbuild
	.build({
		entryPoints: [{ out: "bin/cli", in: "src/bin/cli.mjs" }],
		outdir: ".",
		outExtension: { ".js": ".mjs" },
		bundle: true,
		packages: "external", // keep runtime dependencies (yargs) external, only inline our own modules
		platform: "node",
		format: "esm",
		minify: true,
		sourcemap: true,
		plugins: [],
	})
	.then(() => console.log("⚡ Build CLI complete! ⚡"))
	.catch(() => process.exit(1));
