import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TeachingAccessError } from "./structured-types.js";

export const teachingOrigin = "https://course.pku.edu.cn";
export function teachingUrl(raw: string): URL {
  const url = new URL(raw, teachingOrigin);
  if (url.origin !== teachingOrigin || url.username || url.password)
    throw new TeachingAccessError("TEACHING_URL_FORBIDDEN", "教学网返回了不支持的资源地址。");
  return url;
}
interface Cookie { raw_cookie: string; domain: { HostOnly?: string; Suffix?: string }; path: [string, boolean] }
function matchesCookie(value: unknown, url: URL): value is Cookie {
  if (!value || typeof value !== "object") return false;
  const c = value as Cookie;
  if (typeof c.raw_cookie !== "string" || /[\r\n]/.test(c.raw_cookie) || !c.domain || !Array.isArray(c.path)) return false;
  const host = c.domain.HostOnly, suffix = c.domain.Suffix?.replace(/^\./, "");
  if (host ? host !== url.hostname : !suffix || !(url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) return false;
  const path = c.path[0];
  return typeof path === "string" && (url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`));
}

/** Cookie serialization is isolated from structured readers; credentials stay internal. */
export async function openTeachingSession(cacheDir: string, request: typeof fetch = fetch) {
  let cookies: unknown;
  try { cookies = JSON.parse(await readFile(join(cacheDir, "ua.json"), "utf8")); } catch { /* Authentication below. */ }
  if (!Array.isArray(cookies)) throw new TeachingAccessError("TEACHING_AUTH_REQUIRED", "教学网会话不可用，请重新登录。");
  const saved: unknown[] = cookies;
  return {
    async get(raw: string): Promise<Response> {
      let url = teachingUrl(raw);
      const signal = AbortSignal.timeout(120_000);
      for (let hops = 0; hops < 8; hops++) {
        if (/\/webapps\/(?:login|bb-sso-BBLEARN)\//.test(url.pathname))
          throw new TeachingAccessError("TEACHING_AUTH_REQUIRED", "教学网会话已过期，请重新登录。");
        const cookie = saved.filter(c => matchesCookie(c, url)).map(c => (c as Cookie).raw_cookie.split(";", 1)[0]).join("; ");
        if (!cookie) throw new TeachingAccessError("TEACHING_AUTH_REQUIRED", "教学网会话不可用，请重新登录。");
        let response: Response;
        try { response = await request(url, { headers: { cookie }, redirect: "manual", signal }); }
        catch { throw new TeachingAccessError("TEACHING_NETWORK_FAILED", "无法连接教学网，请检查网络后重试。"); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new TeachingAccessError("TEACHING_REDIRECT_INVALID", "教学网跳转缺少目标地址。");
          const target = new URL(location, url);
          if (target.hostname === "iaaa.pku.edu.cn") throw new TeachingAccessError("TEACHING_AUTH_REQUIRED", "教学网会话已过期，请重新登录。");
          url = teachingUrl(target.href);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new TeachingAccessError(response.status === 401 ? "TEACHING_AUTH_REQUIRED" : "TEACHING_HTTP_FAILED", `教学网请求失败（HTTP ${response.status}）。`);
        }
        return response;
      }
      throw new TeachingAccessError("TEACHING_REDIRECT_INVALID", "教学网跳转次数过多。");
    },
  };
}
export type TeachingSession = Awaited<ReturnType<typeof openTeachingSession>>;

export async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel(); throw new TeachingAccessError("TEACHING_SIZE_LIMIT", "教学网响应超过大小限制。");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new TeachingAccessError("TEACHING_SIZE_LIMIT", "教学网响应超过大小限制。");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
