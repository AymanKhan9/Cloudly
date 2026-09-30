import { open, constants } from "node:fs/promises";

const PATCH_PATH_PREFIXES = ["diff --git a/", "--- a/", "+++ b/"];

function extractPaths(line: string): string[] {
  if (line.startsWith("diff --git a/")) {
    // "diff --git a/<old> b/<new>" — split on the literal " b/" marker.
    const rest = line.slice("diff --git a/".length);
    const splitIndex = rest.indexOf(" b/");
    if (splitIndex === -1) return [];
    return [rest.slice(0, splitIndex), rest.slice(splitIndex + " b/".length)];
  }
  if (line.startsWith("--- a/")) return [line.slice("--- a/".length)];
  if (line.startsWith("+++ b/")) return [line.slice("+++ b/".length)];
  return [];
}

function assertNoGitPaths(content: string): void {
  for (const line of content.split("\n")) {
    if (!PATCH_PATH_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;

    for (const p of extractPaths(line)) {
      if (p === ".git" || p.startsWith(".git/")) {
        throw new Error(`patch touches a path under .git/: ${p}`);
      }
    }
  }
}

export async function validatePatch(
  patchPath: string,
  maxBytes: number,
): Promise<string> {
  const fh = await open(
    patchPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    const stat = await fh.stat();

    if (!stat.isFile()) {
      throw new Error(`patch is not a regular file: ${patchPath}`);
    }

    if (stat.size > maxBytes) {
      throw new Error(
        `patch exceeds size cap: ${stat.size} > ${maxBytes} bytes`,
      );
    }

    const content = await fh.readFile({ encoding: "utf-8" });

    assertNoGitPaths(content);

    return content;
  } finally {
    await fh.close();
  }
}



