// Cross-compile tvault-core for every supported platform into obsidian-plugin/bin/.
// Binaries are named tvault-core-<goos>-<goarch>[.exe]; the plugin picks the one
// matching process.platform/arch at runtime. Requires the Go toolchain.
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const repoRoot = path.resolve(pluginDir, "..");
const outDir = path.join(pluginDir, "bin");

const targets = [
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["windows", "amd64"],
  ["windows", "arm64"],
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const checksums = {};
for (const [goos, goarch] of targets) {
  const ext = goos === "windows" ? ".exe" : "";
  const name = `tvault-core-${goos}-${goarch}${ext}`;
  const outFile = path.join(outDir, name);
  process.stdout.write(`building ${goos}/${goarch}\n`);
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", outFile, "./cmd/"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
  });
  checksums[name] = createHash("sha256").update(readFileSync(outFile)).digest("hex");
}

// cli-checksums.json is committed and embedded into main.js at build time; the
// plugin verifies every downloaded binary against it.
const checksumsPath = path.join(pluginDir, "cli-checksums.json");
writeFileSync(checksumsPath, `${JSON.stringify(checksums, null, 2)}\n`);
// A plain checksums.txt is published as a release asset next to the binaries.
const txt = Object.entries(checksums)
  .map(([name, hash]) => `${hash}  ${name}`)
  .join("\n");
writeFileSync(path.join(outDir, "checksums.txt"), `${txt}\n`);

process.stdout.write(`done -> ${path.relative(repoRoot, outDir)} (+ cli-checksums.json)\n`);
