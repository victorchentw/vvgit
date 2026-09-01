import * as esbuild from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");

async function main() {
  if (!fs.existsSync("dist")) fs.mkdirSync("dist", { recursive: true });

  const build = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    external: ["vscode"],
    outfile: "dist/extension.js",
    sourcemap: true,
    minify: !watch,
    logLevel: "info",
  });

  if (watch) {
    await build.watch();
    console.log("⚡ VV Git is watching for changes...");
  } else {
    await build.rebuild();
    await build.dispose();
    console.log("✨ VV Git build complete.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
