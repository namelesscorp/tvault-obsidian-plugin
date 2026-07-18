import { constants as fsConstants } from "fs";
import { access, mkdir, readdir, rename, rm } from "fs/promises";
import path from "path";
import { CLOSING_MARKER, STAGE_DIR } from "./types";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// listNoteEntries - top-level vault entries that are user notes: everything
// except the config dir (.obsidian), the staging dir, and the closing marker.
export async function listNoteEntries(vaultPath: string, configDir: string): Promise<string[]> {
  const skip = new Set([configDir, STAGE_DIR, CLOSING_MARKER]);
  const entries = await readdir(vaultPath, { withFileTypes: true });
  return entries.filter((entry) => !skip.has(entry.name)).map((entry) => entry.name);
}

// countFilesRecursive - count regular files and symlinks under dir, matching the
// CLI's WalkFolder (which counts files + symlinks, does not follow symlinked
// dirs, and does not skip hidden entries). Implemented as a manual walk so it
// does not depend on readdir's { recursive } option, which is unavailable in
// older Electron/Node builds.
async function countFilesRecursive(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFilesRecursive(path.join(dir, entry.name));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      count++;
    }
  }
  return count;
}

// stageNotes - move every note (top-level entry that is not .obsidian) into the
// staging directory so a seal/reseal packs only user data.
export async function stageNotes(
  vaultPath: string,
  entries: string[],
): Promise<{ stageDir: string; fileCount: number }> {
  const stageDir = path.join(vaultPath, STAGE_DIR);
  await mkdir(stageDir); // fails if a leftover stage exists; recoverStage clears it on load
  for (const name of entries) {
    await rename(path.join(vaultPath, name), path.join(stageDir, name));
  }
  const fileCount = await countFilesRecursive(stageDir);
  return { stageDir, fileCount };
}

// unstageNotes - move staged notes back to the vault root. It never overwrites
// an existing root entry (a name conflict is reported, not clobbered) and
// continues past individual failures so it restores as much as possible; the
// staging dir is only removed once every entry is back.
export async function unstageNotes(vaultPath: string): Promise<void> {
  const stageDir = path.join(vaultPath, STAGE_DIR);
  const names = await readdir(stageDir);
  const failed: string[] = [];
  for (const name of names) {
    const target = path.join(vaultPath, name);
    if (await exists(target)) {
      failed.push(name); // would overwrite a live note — leave it staged
      continue;
    }
    try {
      await rename(path.join(stageDir, name), target);
    } catch (error) {
      console.error(`TVault: failed to restore ${name}`, error);
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    throw new Error(`These notes remain in ${STAGE_DIR} (name conflicts): ${failed.join(", ")}`);
  }
  await rm(stageDir, { recursive: true, force: true });
}

export async function discardStage(vaultPath: string): Promise<void> {
  await rm(path.join(vaultPath, STAGE_DIR), { recursive: true, force: true });
}
