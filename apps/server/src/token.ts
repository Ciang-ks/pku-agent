import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadOrCreateApiToken(tokenPath: string): Promise<string> {
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(tokenPath), { recursive: true });
  const temporaryPath = `${tokenPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporaryPath, tokenPath);
  if (process.platform !== "win32") await chmod(tokenPath, 0o600);
  return token;
}

export function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
