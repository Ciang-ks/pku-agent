import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const origin = "https://course.pku.edu.cn";
const maxBytes = 100 * 1024 * 1024;
interface Content { id: string; kind: string; descriptions: string[]; attachments: [string, string][] }
interface SavedCookie { raw_cookie: string; domain: { HostOnly?: string; Suffix?: string }; path: [string, boolean]; expires: unknown }

/** Compatibility for pku3b 0.16 builds that follow a WebDAV redirect before
 * checking for 302. Authentication and discovery remain owned by pku3b. Only
 * retry this exact failure, with its saved cookies and registered content ID.
 */
export async function downloadPku3bContent(input: {
  cacheDir: string; ccid: string; outdir: string; outputDescription?: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const match = /^(_\d+_\d+):(_\d+_\d+)$/.exec(input.ccid);
  if (!match) throw new Error("Invalid teaching-network content ID.");
  const content = await cachedContent(input.cacheDir, match[2]!);
  if (!content) throw new Error("pku3b content metadata is unavailable; synchronize the course again.");
  const saved: unknown = JSON.parse(await readFile(join(input.cacheDir, "ua.json"), "utf8"));
  if (!Array.isArray(saved)) throw new Error("pku3b session is unavailable; synchronize the course again.");
  const cookies: unknown[] = saved;
  const request = input.fetch ?? fetch;
  const signal = AbortSignal.timeout(120_000);
  async function get(raw: string): Promise<{ response: Response; url: URL }> {
    let url = new URL(raw, origin);
    for (let hops = 0; hops < 8; hops++) {
      if (url.origin !== origin || url.username || url.password) throw new Error("Unsupported teaching-network download origin.");
      const cookie = cookies.filter((c): c is SavedCookie => validCookie(c, url))
        .map(c => c.raw_cookie.split(";", 1)[0]).join("; ");
      if (!cookie) throw new Error("pku3b session is unavailable; synchronize the course again.");
      const response = await request(url, { headers: { cookie }, redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Teaching-network redirect has no location.");
        url = new URL(location, url); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Teaching-network download returned HTTP ${response.status}.`); }
      return { response, url };
    }
    throw new Error("Too many teaching-network redirects.");
  }
  const files: { name: string; data: Buffer }[] = [];
  async function file(raw: string, expectedName?: string) {
    const { response, url } = await get(raw);
    const type = response.headers.get("content-type") ?? "";
    if (/text\/html|application\/xhtml/i.test(type)) { await response.body?.cancel(); throw new Error("Teaching-network returned an HTML page instead of a file; synchronize the session again."); }
    const data = await boundedBody(response, maxBytes);
    if (!data.length || /^\s*(?:<!doctype\s+html|<html)/i.test(data.subarray(0,256).toString())) throw new Error("Teaching-network did not return a downloadable file.");
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plainName = /filename="([^"]+)"/i.exec(disposition)?.[1];
    const name = expectedName ?? (encodedName ? decodeURIComponent(encodedName) : plainName) ?? decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    assertFilename(name);
    files.push({ name, data });
  }
  if (content.kind === "File") {
    const url = new URL("/webapps/blackboard/execute/content/file", origin);
    url.search = new URLSearchParams({ cmd: "view", content_id: match[2]!, course_id: match[1]!, launch_in_new: "true" }).toString();
    const { response } = await get(url.href);
    const html = (await boundedBody(response, 2 * 1024 * 1024)).toString();
    const location = /document\.location\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1];
    if (!location) throw new Error("Teaching-network file link was not found.");
    await file(location.replace(/&amp;/g, "&"));
  }
  for (const [name, url] of content.attachments) await file(url, name);
  if (!files.length) throw new Error("No downloadable attachments were found.");
  // Validate everything before writing into the caller-owned staging directory.
  if (input.outputDescription) assertFilename(input.outputDescription);
  for (const entry of files) await writeFile(join(input.outdir, entry.name), entry.data);
  if (input.outputDescription) await writeFile(join(input.outdir, input.outputDescription), content.descriptions.join("\n"));
}

function assertFilename(name: string): void {
  if (!name || name === "." || name === ".." || name !== basename(name) || /[\\/:\x00-\x1f]/.test(name)) throw new Error("Invalid teaching-network attachment filename.");
}
function validCookie(value: unknown, url: URL): value is SavedCookie {
  if (!value || typeof value !== "object") return false;
  const c = value as SavedCookie;
  if (typeof c.raw_cookie !== "string" || /[\r\n]/.test(c.raw_cookie) || !c.domain || !Array.isArray(c.path)) return false;
  const host = c.domain.HostOnly;
  const suffix = c.domain.Suffix?.replace(/^\./, "");
  if (host ? host !== url.hostname : !suffix || !(url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) return false;
  const path = c.path[0];
  return typeof path === "string" && (url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`));
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) { await response.body?.cancel(); throw new Error("Teaching-network file exceeds the size limit."); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error("Teaching-network file exceeds the size limit."); chunks.push(value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
async function cachedContent(cacheDir: string, id: string): Promise<Content | undefined> {
  const candidates: { item: Content; modified: number }[] = [];
  for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^with_cache-[a-f0-9]+$/.test(entry.name)) continue;
    try {
      const path = join(cacheDir, entry.name); const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item?.id !== id || typeof item.kind !== "string" || !Array.isArray(item.descriptions) || !item.descriptions.every((s: unknown) => typeof s === "string") ||
          !Array.isArray(item.attachments) || !item.attachments.every((a: unknown) => Array.isArray(a) && a.length === 2 && a.every(s => typeof s === "string"))) continue;
        candidates.push({ item, modified: stat.mtimeMs });
      }
    } catch { /* Unrelated cache data is not download metadata. */ }
  }
  return candidates.sort((a,b) => b.modified-a.modified)[0]?.item;
}
