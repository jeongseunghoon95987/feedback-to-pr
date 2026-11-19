import { applyPatch, parsePatch, type StructuredPatch } from "diff";
import type { TreeChange } from "../github/git";

/**
 * The agent's patch is untrusted output. It is checked before anything is
 * written to the repository; violations reject the whole patch.
 */
export const PATCH_LIMITS = {
  maxBytes: 512 * 1024,
  maxFiles: 40,
} as const;

/** Paths the agent may never touch. */
const FORBIDDEN = [/^\.github\//i, /^\.git\//i, /(^|\/)\.gitmodules$/i];

export class PatchRejected extends Error {}

export interface FileChange {
  /** Path in the repository before the change, or null for a new file. */
  oldPath: string | null;
  /** Path after the change, or null for a deleted file. */
  newPath: string | null;
  patch: StructuredPatch;
}

export function parseAgentPatch(text: string): FileChange[] {
  if (new TextEncoder().encode(text).length > PATCH_LIMITS.maxBytes) throw new PatchRejected("patch is too large");
  if (/^GIT binary patch$|^Binary files .* differ$/m.test(text)) throw new PatchRejected("binary changes are not allowed");
  if (/^(old|new) mode /m.test(text)) throw new PatchRejected("file mode changes are not allowed");

  const files = parsePatch(text).filter((p) => p.hunks.length > 0 || p.oldFileName !== p.newFileName);
  if (files.length === 0) throw new PatchRejected("patch contains no changes");
  if (files.length > PATCH_LIMITS.maxFiles) throw new PatchRejected(`patch changes more than ${PATCH_LIMITS.maxFiles} files`);

  return files.map((patch) => {
    const oldPath = cleanPath(patch.oldFileName);
    const newPath = cleanPath(patch.newFileName);
    if (!oldPath && !newPath) throw new PatchRejected("patch entry has no file name");
    for (const path of [oldPath, newPath]) if (path) checkPath(path);
    return { oldPath, newPath, patch };
  });
}

/** Strips git's a/ and b/ prefixes; /dev/null means "no file". */
function cleanPath(name: string | undefined): string | null {
  if (!name || name === "/dev/null") return null;
  return name.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

function checkPath(path: string): void {
  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) {
    throw new PatchRejected(`invalid path: ${path}`);
  }
  if (FORBIDDEN.some((re) => re.test(path))) throw new PatchRejected(`changes to ${path} are not allowed`);
}

/**
 * Applies the parsed patch to the current repository contents.
 * `readFile` returns the file's text and mode, or null if it does not exist.
 */
export async function buildTreeChanges(
  files: FileChange[],
  readFile: (path: string) => Promise<{ text: string; mode: string } | null>,
): Promise<TreeChange[]> {
  const changes: TreeChange[] = [];
  for (const file of files) {
    const original = file.oldPath ? await readFile(file.oldPath) : null;
    if (file.oldPath && !original) throw new PatchRejected(`${file.oldPath} does not exist on the base branch`);
    if (!file.oldPath && file.newPath && (await readFile(file.newPath))) {
      throw new PatchRejected(`${file.newPath} already exists on the base branch`);
    }

    if (!file.newPath) {
      changes.push({ path: file.oldPath as string, content: null, mode: original!.mode });
      continue;
    }
    const updated = applyPatch(original?.text ?? "", file.patch);
    if (updated === false) throw new PatchRejected(`patch does not apply cleanly to ${file.oldPath ?? file.newPath}`);

    if (file.oldPath && file.oldPath !== file.newPath) {
      changes.push({ path: file.oldPath, content: null, mode: original!.mode });
    }
    changes.push({ path: file.newPath, content: updated, mode: original?.mode ?? "100644" });
  }
  return changes;
}
