import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Pku3bCourseRef { title: string; remoteCourseId: string }

/** pku3b 0.16 serializes Blackboard::_get_courses as [id, long_title, current][];
 * its cache filename includes a Rust TypeId hash and is not portable across builds.
 * Read only this metadata shape, never cookies/configuration or download caches.
 * Call only after a successful live content listing and match its displayed titles.
 */
export async function readCourseCatalog(cacheDir: string, titles: string[]): Promise<Pku3bCourseRef[]> {
  const visible = new Set(titles);
  const candidates: { modified: number; courses: Pku3bCourseRef[] }[] = [];
  let entries;
  try { entries = await readdir(cacheDir, { withFileTypes: true }); }
  catch { return []; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^with_cache-[a-f0-9]+$/.test(entry.name)) continue;
    try {
      const path = join(cacheDir, entry.name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(value) || !value.length || !value.every(row => Array.isArray(row) && row.length === 3 &&
        typeof row[0] === "string" && /^_\d+_\d+$/.test(row[0]) && typeof row[1] === "string" &&
        typeof row[2] === "boolean")) continue;
      const courses = value.map(([remoteCourseId, longTitle]: [string, string, boolean]) => ({
        remoteCourseId, title: longTitle.slice(longTitle.indexOf(":") + 1).trim(),
      }));
      // Reject partial catalogs from older accounts/builds; do not add stale courses.
      if ([...visible].every(title => courses.some(course => course.title === title)))
        candidates.push({ modified: stat.mtimeMs, courses: courses.filter(course => visible.has(course.title)) });
    } catch { /* Unrelated, incomplete or obsolete cache entries are optional. */ }
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.courses ?? [];
}
