// esbuild bundle → single ESM main.js. The core loader imports the entry as a blob
// URL, and a blob URL cannot resolve relative imports (./plan.js), so multi-file
// source must be bundled into one file.
import { build, context } from "esbuild";

const opts = {
  entryPoints: ["src/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[git-workspace] watching src → main.js …");
} else {
  await build(opts);
  console.log("[git-workspace] built main.js");
}
