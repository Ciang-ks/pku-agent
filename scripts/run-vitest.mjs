import { constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

let testTempDir = tmpdir();
try {
  // `access()` alone is insufficient on WSL-mounted Windows temp paths: the
  // directory may be readable but disappear or reject child creation while
  // Vitest is starting workers. Probe an actual file round-trip instead.
  await access(testTempDir, constants.R_OK | constants.W_OK);
  const probe = join(testTempDir, `.pku-study-vitest-${process.pid}-${Date.now()}`);
  writeFileSync(probe, "ok");
  rmSync(probe, { force: true });
} catch {
  testTempDir = join(process.cwd(), ".vitest-tmp");
  if (!existsSync(testTempDir)) mkdirSync(testTempDir, { recursive: true });
  process.env.TMPDIR = testTempDir;
  process.env.TMP = testTempDir;
  process.env.TEMP = testTempDir;
}

const vitestEntry = fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));
const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
