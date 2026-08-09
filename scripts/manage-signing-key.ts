import { runSigningKeyCli } from "./signing-key-cli";

process.exitCode = await runSigningKeyCli(process.argv.slice(2));
