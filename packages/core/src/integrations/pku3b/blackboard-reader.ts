import { load } from "cheerio";
import { basename, join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { RemoteResourceKind } from "../../domain/types.js";
import { TeachingAccessError, type TeachingContent, type TeachingContentSnapshot, type TeachingCourseRef } from "./structured-types.js";
import { openTeachingSession, readBoundedBody, teachingUrl, type TeachingSession } from "./session-http.js";

const contentPath = "/webapps/blackboard/content/listContent.jsp";
const idPattern = /^_\d+_\d+$/;
const kindMap: Record<string, RemoteResourceKind> = {
  作业: "assignment", Assignment: "assignment", 音频: "audio", Audio: "audio",
  内容文件夹: "folder", 文件夹: "folder", "Content Folder": "folder", Folder: "folder",
  项目: "document", Item: "document", 文件: "file", File: "file", 测试: "quiz", Test: "quiz",
};
function requireId(id: string) {
  if (!idPattern.test(id)) throw new TeachingAccessError("TEACHING_ID_INVALID", "教学网资源 ID 无效。");
}
function schemaError(): never { throw new TeachingAccessError("TEACHING_SCHEMA_CHANGED", "教学网页面结构与预期不符；本次没有替换已同步数据。"); }
function document(html: string) {
  const $ = load(html);
  if ($('input[type="password"], form#login').length)
    throw new TeachingAccessError("TEACHING_AUTH_REQUIRED", "教学网会话已过期，请重新登录。");
  $("script, style").remove();
  return $;
}
async function html(session: TeachingSession, url: string) { return (await readBoundedBody(await session.get(url), 8 * 1024 * 1024)).toString("utf8"); }
function coursePage(id: string) {
  const url = teachingUrl("/webapps/blackboard/execute/announcement");
  url.search = new URLSearchParams({ method: "search", context: "course_entry", course_id: id, handle: "announcements_entry", mode: "view" }).toString();
  return url.href;
}
export function contentPage(courseId: string, contentId: string) {
  requireId(courseId); requireId(contentId);
  const url = teachingUrl(contentPath);
  url.search = new URLSearchParams({ course_id: courseId, content_id: contentId }).toString();
  return url.href;
}

export function parseTeachingCourses(html: string): TeachingCourseRef[] {
  const $ = document(html), courses = new Map<string, TeachingCourseRef>();
  let recognized = false;
  $("div.portlet").each((_, element) => {
    const portlet = $(element), label = portlet.find("span.moduleTitle").text();
    if (!/课程|Courses/.test(label)) return;
    recognized = true;
    portlet.find("ul.courseListing li a").each((_, link) => {
      const a = $(link), href = a.attr("href") ?? "";
      const id = /key=(_\d+_\d+)(?:,|&|$)/.exec(href)?.[1] ?? /[?&]course_id=(_\d+_\d+)(?:&|$)/.exec(href)?.[1];
      const rawTitle = a.text().trim();
      if (!id || !rawTitle) schemaError();
      const title = rawTitle.includes(":") ? rawTitle.slice(rawTitle.indexOf(":") + 1).trim() : rawTitle;
      const previous = courses.get(id);
      const isCurrent = /当前|Current Semester Courses/.test(label);
      courses.set(id, { remoteCourseId: id, title, isCurrent: isCurrent || previous?.isCurrent === true });
    });
  });
  if (!recognized) schemaError();
  return [...courses.values()];
}

export function parseTeachingEntries(html: string, courseId: string): TeachingContent[] {
  const $ = document(html);
  if (!$("#courseMenuPalette_contents").length) schemaError();
  const entries = new Map<string, TeachingContent>();
  $("#courseMenuPalette_contents > li > a").each((_, element) => {
    const a = $(element), raw = a.attr("href");
    if (!raw || !raw.includes("listContent.jsp")) return;
    const url = teachingUrl(raw);
    if (url.pathname !== contentPath || url.searchParams.get("course_id") !== courseId) schemaError();
    const contentId = url.searchParams.get("content_id") ?? "";
    requireId(contentId);
    const title = a.text().trim(); if (!title) schemaError();
    entries.set(contentId, { remoteResourceId: `${courseId}:section:${contentId}`, title, kind: "section",
      sourceUrl: contentPage(courseId, contentId), descriptions: [], attachments: [] });
  });
  return [...entries.values()];
}

/** Parse one actual Blackboard folder; never infer parents from display titles. */
export function parseTeachingContents(html: string, courseId: string, parent: TeachingContent): TeachingContent[] {
  const $ = document(html);
  if (!$("#content_listContainer").length && !$("#content .noItems, #containerdiv .noItems").length) schemaError();
  const contents: TeachingContent[] = [];
  $("#content_listContainer > li").each((_, element) => {
    const li = $(element), children = li.children(), heading = children.eq(1), detail = children.eq(2);
    const id = heading.attr("id") ?? "", title = heading.find("h3").text().trim() || heading.text().trim();
    if (!idPattern.test(id) || !title || children.length < 3) schemaError();
    const kind = kindMap[children.eq(0).attr("alt") ?? ""] ?? "unknown";
    const body = detail.find("div.vtbegenerated").first();
    body.find("br").replaceWith("\n");
    const descriptions = body.children().length ? body.children().map((_, p) => $(p).text().trim()).get().filter(Boolean) : [body.text().trim()].filter(Boolean);
    const attachments: TeachingContent["attachments"] = [];
    detail.find("ul.attachments > li > a, audio + ul > li > a").each((_, link) => {
      const name = $(link).text().trim(), raw = $(link).attr("href");
      if (!name || !raw) schemaError();
      const url = teachingUrl(raw).href;
      if (!attachments.some(a => a.name === name && a.url === url)) attachments.push({ name, url });
    });
    contents.push({ remoteResourceId: `${courseId}:${id}`, parentRemoteId: parent.remoteResourceId, title, kind,
      sourceUrl: parent.sourceUrl, descriptions, attachments });
  });
  return contents;
}

export class BlackboardReader {
  constructor(private readonly cacheDir: string, private readonly request: typeof fetch = fetch) {}
  async listCourses(): Promise<TeachingCourseRef[]> {
    const session = await openTeachingSession(this.cacheDir, this.request);
    return parseTeachingCourses(await html(session, "/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1"));
  }
  async readCourse(courseId: string): Promise<TeachingContentSnapshot> {
    requireId(courseId);
    const session = await openTeachingSession(this.cacheDir, this.request);
    const contents = parseTeachingEntries(await html(session, coursePage(courseId)), courseId);
    const queue = contents.map(parent => ({ parent, contentId: teachingUrl(parent.sourceUrl).searchParams.get("content_id")!, depth: 0 }));
    const visited = new Set<string>(), seen = new Set(contents.map(c => c.remoteResourceId));
    for (let index = 0; index < queue.length; index++) {
      const { parent, contentId, depth } = queue[index]!;
      if (visited.has(contentId)) continue;
      if (depth > 20 || visited.size >= 500) throw new TeachingAccessError("TEACHING_TREE_LIMIT", "课程栏目过多或层级过深，本次同步未完成。");
      visited.add(contentId);
      const page = contentPage(courseId, contentId);
      const children = parseTeachingContents(await html(session, page), courseId, { ...parent, sourceUrl: page });
      for (const child of children) {
        if (seen.has(child.remoteResourceId)) continue;
        seen.add(child.remoteResourceId); contents.push(child);
        if (contents.length > 10000) throw new TeachingAccessError("TEACHING_TREE_LIMIT", "课程资源过多，本次同步未完成。");
        if (child.kind === "folder") queue.push({ parent: child, contentId: child.remoteResourceId.split(":")[1]!, depth: depth + 1 });
      }
    }
    return { schemaVersion: 1, remoteCourseId: courseId, fetchedAt: new Date().toISOString(), contents };
  }
  async download(content: TeachingContent, courseId: string, directory: string): Promise<void> {
    const id = content.remoteResourceId.split(":");
    if (id.length !== 2 || id[0] !== courseId || !idPattern.test(id[1]!)) throw new TeachingAccessError("TEACHING_ID_INVALID", "请选择具体课程资源。");
    // Refresh only the parent page, so expiring attachment links are not reused.
    const source = teachingUrl(content.sourceUrl);
    if (source.pathname !== contentPath || source.searchParams.get("course_id") !== courseId) schemaError();
    const session = await openTeachingSession(this.cacheDir, this.request);
    const fresh = parseTeachingContents(await html(session, source.href), courseId, { ...content, remoteResourceId: content.parentRemoteId ?? "" })
      .find(item => item.remoteResourceId === content.remoteResourceId);
    if (!fresh) throw new TeachingAccessError("RESOURCE_REMOVED", "该资源已从教学网移除，请重新同步。");
    const files: { name: string; data: Buffer }[] = [];
    const download = async (url: string, name?: string) => {
      const response = await session.get(url);
      if (/html/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw new TeachingAccessError("TEACHING_DOWNLOAD_INVALID", "教学网返回了网页，未下载到文件。"); }
      const data = await readBoundedBody(response, 100 * 1024 * 1024);
      if (!data.length || /^\s*(?:<!doctype\s+html|<html)/i.test(data.subarray(0, 256).toString())) throw new TeachingAccessError("TEACHING_DOWNLOAD_INVALID", "教学网未返回有效文件。");
      const disposition = response.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(disposition);
      const filename = name ?? (encoded ? decodeURIComponent(encoded) : plain?.[1] ?? plain?.[2]?.trim()) ?? decodeURIComponent(teachingUrl(response.url || url).pathname.split("/").at(-1) ?? "");
      if (!filename || filename === "." || filename === ".." || filename !== basename(filename) || /[\\/:\x00-\x1f]/.test(filename)) throw new TeachingAccessError("TEACHING_FILENAME_INVALID", "教学网附件文件名无效。");
      if (files.some(f => f.name === filename) || filename === "description.txt") throw new TeachingAccessError("TEACHING_FILENAME_CONFLICT", "资源包含同名附件，需要分别下载。");
      if (files.reduce((total, f) => total + f.data.length, data.length) > 100 * 1024 * 1024)
        throw new TeachingAccessError("TEACHING_SIZE_LIMIT", "该资源附件总大小超过 100 MB。");
      files.push({ name: filename, data });
    };
    if (fresh.kind === "file") {
      const url = teachingUrl("/webapps/blackboard/execute/content/file");
      url.search = new URLSearchParams({ cmd: "view", content_id: id[1]!, course_id: courseId, launch_in_new: "true" }).toString();
      const page = await html(session, url.href);
      const link = /document\.location\s*=\s*['"]([^'"]+)['"]/.exec(page)?.[1];
      if (!link) throw new TeachingAccessError("TEACHING_DOWNLOAD_INVALID", "教学网文件链接不可用。");
      await download(link.replace(/&amp;/g, "&"));
    }
    for (const attachment of fresh.attachments) await download(attachment.url, attachment.name);
    if (!files.length && !fresh.descriptions.length) throw new TeachingAccessError("RESOURCE_EMPTY", "该资源没有可下载的附件或正文。");
    for (const file of files) await writeFile(join(directory, file.name), file.data);
    if (fresh.descriptions.length) await writeFile(join(directory, "description.txt"), fresh.descriptions.join("\n\n"));
  }
}
