import { readFile } from "node:fs/promises";

import { assertAgentsSize, MAX_AGENTS_BYTES } from "./agents-size";

const path = new URL("../AGENTS.md", import.meta.url);
const bytes = assertAgentsSize(await readFile(path));

console.log(`AGENTS.md is ${bytes} bytes (limit: < ${MAX_AGENTS_BYTES}).`);
