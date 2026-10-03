import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BlackboardReader, parseTeachingCourses, parseTeachingEntries, parseTeachingContents, contentPage } from "../src/integrations/pku3b/blackboard-reader.js";
import { openTeachingSession } from "../src/integrations/pku3b/session-http.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function sessionDirectory() {
  const dir = await mkdtemp(join(tmpdir(), "blackboard-reader-")); dirs.push(dir);
  await writeFile(join(dir, "ua.json"), JSON.stringify([{ raw_cookie: "session=fixture; Path=/", domain: { HostOnly: "course.pku.edu.cn" }, path: ["/", true] }]));
  return dir;
}
const menu = '<ul id="courseMenuPalette_contents"><li><a href="/webapps/blackboard/content/listContent.jsp?course_id=_1_1&amp;content_id=_10_1">课件</a></li></ul>';
const item = (id: string, kind: string, title: string, body = "") => `<li><img alt="${kind}"><div id="${id}"><h3>${title}</h3></div><div class="details">${body}</div></li>`;
const page = (body: string) => `<ul id="content_listContainer">${body}</ul>`;
it("discovers empty courses by stable ID and fails closed on an unrecognized or logged-out page", () => {
  const courses = parseTeachingCourses('<div class="portlet"><span class="moduleTitle">当前课程</span><ul class="courseListing"><li><a href="javascript:go(\'key=_1_1,\')">CODE: 数学(秋)</a></li></ul></div>');
  expect(courses).toEqual([{ remoteCourseId: "_1_1", title: "数学(秋)", isCurrent: true }]);
  expect(() => parseTeachingCourses('<html>maintenance</html>')).toThrow("页面结构");
  expect(() => parseTeachingCourses('<input type="password">')).toThrow("过期");
  expect(parseTeachingCourses('<div class="portlet"><span class="moduleTitle">当前课程</span><ul class="courseListing"></ul></div>')).toEqual([]);
});
it("retains duplicate titles under distinct actual parents, strips scripts and preserves attachment names", () => {
  const parent = parseTeachingEntries(menu, "_1_1")[0]!;
  const contents = parseTeachingContents(page(item("_11_1", "项目", "Lecture", '<div class="vtbegenerated"><p>说明<script>bad()</script><br>第二行</p></div><ul class="attachments"><li><a href="/bbcswebdav/a.pdf">A &amp; B.pdf</a></li></ul>')), "_1_1", parent);
  expect(contents[0]).toMatchObject({ parentRemoteId: "_1_1:section:_10_1", descriptions: ["说明\n第二行"], attachments: [{ name: "A & B.pdf", url: "https://course.pku.edu.cn/bbcswebdav/a.pdf" }] });
  expect(() => parseTeachingEntries(menu.replace("course_id=_1_1", "course_id=_2_1"), "_1_1")).toThrow();
  expect(() => parseTeachingContents(page('<li>broken row</li>'), "_1_1", parent)).toThrow("页面结构");
});
it("traverses nested folders once by ID and refuses partial snapshots when any page fails", async () => {
  const dir = await sessionDirectory(); let broken = false;
  const request = vi.fn(async (raw: URL | string | Request) => {
    const url = new URL(String(raw)), id = url.searchParams.get("content_id");
    if (url.pathname.endsWith("announcement")) return new Response(menu);
    if (id === "_10_1") return new Response(page(item("_11_1", "内容文件夹", "同名") + item("_12_1", "内容文件夹", "同名")));
    if (id === "_11_1") return new Response(page(item("_13_1", "项目", "Lecture")));
    if (broken) return new Response("error", { status: 503 });
    return new Response(page(item("_14_1", "项目", "Lecture") + item("_11_1", "内容文件夹", "cycle")));
  });
  const reader = new BlackboardReader(dir, request as typeof fetch);
  const snapshot = await reader.readCourse("_1_1");
  expect(request).toHaveBeenCalledTimes(4);
  expect(snapshot.contents.filter(c => c.title === "Lecture").map(c => c.parentRemoteId)).toEqual(["_1_1:_11_1", "_1_1:_12_1"]);
  broken = true;
  await expect(reader.readCourse("_1_1")).rejects.toThrow("503");
});
it("does not send cookies to redirects outside teaching-network origin", async () => {
  const dir = await sessionDirectory();
  const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.org/" } }));
  const session = await openTeachingSession(dir, request as typeof fetch);
  await expect(session.get("/start")).rejects.toThrow("不支持"); expect(request).toHaveBeenCalledTimes(1);
});
it("refreshes parent metadata and downloads a direct 200 attachment without reading content caches", async () => {
  const dir = await sessionDirectory();
  const request = vi.fn(async (raw: URL | string | Request) => String(raw).includes("listContent")
    ? new Response(page(item("_11_1", "项目", "Lecture", '<ul class="attachments"><li><a href="/fresh.pdf">new.pdf</a></li></ul>')))
    : new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } }));
  await new BlackboardReader(dir, request as typeof fetch).download({ remoteResourceId: "_1_1:_11_1", parentRemoteId: "_1_1:section:_10_1", title: "Lecture", kind: "document", sourceUrl: contentPage("_1_1", "_10_1"), descriptions: [], attachments: [{ name: "old.pdf", url: "https://course.pku.edu.cn/old.pdf" }] }, "_1_1", dir);
  expect(await readFile(join(dir, "new.pdf"), "utf8")).toBe("%PDF-fixture");
  expect(String(request.mock.calls[1]![0])).toBe("https://course.pku.edu.cn/fresh.pdf");
});
it("uses the final redirected filename for a File link", async () => {
  const dir = await sessionDirectory();
  const request = vi.fn(async (raw: URL | string | Request) => {
    const url = new URL(String(raw));
    if (url.pathname.endsWith("listContent.jsp")) return new Response(page(item("_11_1", "文件", "Lecture")));
    if (url.pathname.endsWith("/content/file")) return new Response("<script>document.location='/bbcswebdav/xid-1';</script>");
    if (url.pathname.endsWith("xid-1")) return new Response(null, { status: 302, headers: { location: "/files/lecture%201.pdf" } });
    const result = new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } });
    Object.defineProperty(result, "url", { value: url.href }); return result;
  });
  await new BlackboardReader(dir, request as typeof fetch).download({ remoteResourceId: "_1_1:_11_1", parentRemoteId: "_1_1:section:_10_1", title: "Lecture", kind: "file", sourceUrl: contentPage("_1_1", "_10_1"), descriptions: [], attachments: [] }, "_1_1", dir);
  expect(await readFile(join(dir, "lecture 1.pdf"), "utf8")).toBe("%PDF-fixture");
});
