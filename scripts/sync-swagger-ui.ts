import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDirectory = resolve(root, "node_modules", "swagger-ui-dist");
const targetDirectory = resolve(root, "public", "vendor", "swagger-ui");
const files = ["swagger-ui.css", "swagger-ui-bundle.js", "LICENSE"] as const;
const checkOnly = process.argv.includes("--check");

for (const file of files) {
  const source = await readFile(resolve(sourceDirectory, file));
  const target = resolve(targetDirectory, file);
  if (checkOnly) {
    const current = await readFile(target).catch(() => null);
    if (!current || !current.equals(source)) {
      throw new Error(
        `Vendored Swagger UI asset is missing or stale: ${file}. Run npm run swagger:sync.`,
      );
    }
    continue;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

console.log(
  checkOnly
    ? `Swagger UI vendor check passed for ${files.length} files.`
    : `Synced ${files.length} Swagger UI files into public/vendor/swagger-ui.`,
);
