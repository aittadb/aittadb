import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface SitesMigrationJournal {
  version: "7";
  dialect: "sqlite";
  entries: Array<{
    idx: number;
    version: "6";
    when: number;
    tag: string;
    breakpoints: true;
  }>;
}

const JOURNAL_EPOCH = 1_700_000_000_000;

export async function emitSitesMigrations(
  sourceDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const fileNames = (await readdir(sourceDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  if (fileNames.length === 0) {
    throw new Error("At least one checked-in D1 migration is required");
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(resolve(outputDirectory, "meta"), { recursive: true });
  for (const fileName of fileNames) {
    const source = await readFile(resolve(sourceDirectory, fileName), "utf8");
    const statements = splitSqlStatements(source);
    if (statements.length === 0) {
      throw new Error(`D1 migration ${fileName} contains no SQL statements`);
    }
    await writeFile(
      resolve(outputDirectory, fileName),
      `${statements.join("\n--> statement-breakpoint\n")}\n`,
    );
  }
  await writeFile(
    resolve(outputDirectory, "meta", "_journal.json"),
    `${JSON.stringify(sitesMigrationJournal(fileNames), null, 2)}\n`,
  );
}

export function sitesMigrationJournal(
  fileNames: readonly string[],
): SitesMigrationJournal {
  return {
    version: "7",
    dialect: "sqlite",
    entries: fileNames.map((fileName, idx) => ({
      idx,
      version: "6",
      when: JOURNAL_EPOCH + idx,
      tag: basename(fileName, ".sql"),
      breakpoints: true,
    })),
  };
}

export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    current += character;

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }

  if (quote || blockComment) throw new Error("Unterminated SQL syntax");
  if (current.trim()) {
    throw new Error("Every D1 migration statement must end with a semicolon");
  }
  return statements;
}
