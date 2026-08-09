import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

import {
  formatSecretFinding,
  isLegacyPublicDeploymentMetadata,
  scanTrackedFile,
  scanTrackedFiles,
  type SecretFinding,
  type TrackedFile,
} from "./secret-safety";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

function git(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function repositoryRoot(): string {
  return git(["rev-parse", "--show-toplevel"], process.cwd())
    .toString("utf8")
    .trim();
}

function decodeText(contents: Buffer): string | undefined {
  if (contents.includes(0)) return undefined;
  return contents.toString("utf8");
}

function trackedWorkingTreeFiles(root: string): TrackedFile[] {
  return git(["ls-files", "-z"], root)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      const absolutePath = `${root}/${path}`;
      try {
        if (lstatSync(absolutePath).isSymbolicLink()) return { path };
        return { path, contents: decodeText(readFileSync(absolutePath)) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { path };
        throw error;
      }
    });
}

interface TreeEntry {
  objectId: string;
  path: string;
  symbolicLink: boolean;
}

function commitTree(root: string, commit: string): TreeEntry[] {
  return git(["ls-tree", "-r", "-z", "--full-tree", commit], root)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const metadata = entry.slice(0, tab).split(" ");
      const [mode, type, objectId] = metadata;
      if (tab < 0 || type !== "blob" || objectId === undefined) {
        throw new Error(`Unexpected Git tree entry in ${commit}`);
      }
      return {
        objectId,
        path: entry.slice(tab + 1),
        symbolicLink: mode === "120000",
      };
    });
}

function auditHistory(root: string): {
  commits: number;
  findings: SecretFinding[];
  legacyMetadata: SecretFinding[];
  uniqueBlobs: number;
} {
  if (
    git(["rev-parse", "--is-shallow-repository"], root)
      .toString("utf8")
      .trim() !== "false"
  ) {
    throw new Error("Secret history audit requires a complete Git clone");
  }

  const commits = git(["rev-list", "--all", "--reverse"], root)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const blobs = new Map<string, string | undefined>();
  const reported = new Set<string>();
  const findings: SecretFinding[] = [];
  const legacyMetadata: SecretFinding[] = [];
  const reportedLegacyMetadata = new Set<string>();

  for (const commit of commits) {
    for (const entry of commitTree(root, commit)) {
      if (!blobs.has(entry.objectId)) {
        const contents = entry.symbolicLink
          ? undefined
          : decodeText(git(["cat-file", "blob", entry.objectId], root));
        blobs.set(entry.objectId, contents);
      }

      if (isLegacyPublicDeploymentMetadata(entry.path)) {
        const reportKey = `${entry.path}\0${entry.objectId}`;
        if (!reportedLegacyMetadata.has(reportKey)) {
          reportedLegacyMetadata.add(reportKey);
          legacyMetadata.push({
            category: "forbidden-secret-path",
            path: entry.path,
            commit,
          });
        }
      }

      for (const finding of scanTrackedFile(
        {
          path: entry.path,
          contents: blobs.get(entry.objectId),
        },
        { allowLegacyHostingPath: true },
      )) {
        const reportKey = `${finding.category}\0${finding.path}\0${entry.objectId}`;
        if (reported.has(reportKey)) continue;
        reported.add(reportKey);
        findings.push({ ...finding, commit });
      }
    }
  }

  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.category.localeCompare(right.category) ||
      (left.commit ?? "").localeCompare(right.commit ?? ""),
  );
  return {
    commits: commits.length,
    findings,
    legacyMetadata,
    uniqueBlobs: blobs.size,
  };
}

function reportFailure(findings: SecretFinding[]): void {
  console.error(
    `Secret safety check found ${findings.length} prohibited tracked artifact(s):`,
  );
  for (const finding of findings) {
    console.error(formatSecretFinding(finding));
  }
  process.exitCode = 1;
}

const root = repositoryRoot();
if (process.argv.length === 2) {
  const files = trackedWorkingTreeFiles(root);
  const findings = scanTrackedFiles(files);
  if (findings.length > 0) reportFailure(findings);
  else
    console.log(
      `Secret safety check passed for ${files.length} tracked files.`,
    );
} else if (process.argv.length === 3 && process.argv[2] === "--history") {
  const result = auditHistory(root);
  for (const metadata of result.legacyMetadata) {
    console.log(
      [
        "legacy-public-deployment-metadata",
        metadata.path,
        metadata.commit,
      ].join("\t"),
    );
  }
  if (result.findings.length > 0) reportFailure(result.findings);
  else {
    console.log(
      `Secret history audit passed for ${result.commits} reachable commits and ${result.uniqueBlobs} unique blobs; noted ${result.legacyMetadata.length} legacy public deployment metadata revision(s).`,
    );
  }
} else {
  console.error("Usage: check-secret-safety.ts [--history]");
  process.exitCode = 2;
}
