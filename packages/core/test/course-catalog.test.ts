import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readCourseCatalog } from "../src/integrations/pku3b/course-catalog.js";
import { CourseDiscoveryService } from "../src/integrations/pku3b/course-discovery-service.js";
import type { Pku3bExecutor } from "../src/integrations/pku3b/teaching-network-service.js";
import type { CourseWorkspaceService } from "../src/storage/course-workspace-service.js";
import { courseLabelMatches } from "../src/integrations/pku3b/status-output.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("reads the versioned catalog shape without exposing enrollment prefixes or unrelated caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "course-catalog-")); roots.push(root);
  const title = "人工智能中的编程(26-27学年第1学期)";
  await writeFile(join(root, "with_cache-a"), JSON.stringify([["_104187_1", `private-enrollment-prefix: ${title}`, true]]));
  await writeFile(join(root, "with_cache-b"), JSON.stringify([{ id: "_999_1", title }]));
  await writeFile(join(root, "with_cache-c"), "incomplete JSON");
  await writeFile(join(root, "ua.json"), "not a catalog");
  await writeFile(join(root, "other.json"), JSON.stringify([["_999_1", title, true]]));
  await symlink(join(root, "other.json"), join(root, "with_cache-d"));
  expect(await readCourseCatalog(root, [title])).toEqual([{ title, remoteCourseId: "_104187_1" }]);
  expect(await readCourseCatalog(root, [title, "新课程"])).toEqual([]);
  expect(await readCourseCatalog(join(root, "missing"), [title])).toEqual([]);
  await writeFile(join(root, "with_cache-e"), JSON.stringify([["_104188_1", title, true]]));
  await utimes(join(root, "with_cache-a"), new Date(0), new Date(0));
  expect(await readCourseCatalog(root, [title])).toEqual([{ title, remoteCourseId: "_104188_1" }]);
});

it("supplements only empty courses after successful discovery and preserves content IDs", async () => {
  const runRead = vi.fn().mockResolvedValue({ ok: true, data: { stdout: "有课件(秋)\n• (Document) 课件 _1_1:_2_1\n空课程(秋)\n" } });
  const courseCatalog = vi.fn().mockResolvedValue([{ title: "有课件(秋)", remoteCourseId: "_999_1" }, { title: "空课程(秋)", remoteCourseId: "_3_1" }, { title: "旧课程", remoteCourseId: "_4_1" }]);
  const service = new CourseDiscoveryService({ runRead, courseCatalog } as unknown as Pku3bExecutor,
    { list: () => [{ courseId: "local", remoteCourseId: "_3_1" }] } as unknown as CourseWorkspaceService);
  expect(await service.discover()).toEqual([{ title: "有课件(秋)", remoteCourseId: "_1_1" }, { title: "空课程(秋)", remoteCourseId: "_3_1", courseId: "local" }]);
  courseCatalog.mockClear();
  runRead.mockResolvedValue({ ok: false, error: { code: "PKU3B_COMMAND_FAILED", message: "network unavailable" } });
  await expect(service.discover()).rejects.toThrow("network unavailable");
  expect(courseCatalog).not.toHaveBeenCalled();
});

it("matches actual PKU semesters without merging different terms or dropping course-name parentheses", () => {
  expect(courseLabelMatches("人工智能中的编程(26-27学年第1学期)", "人工智能中的编程", "26-27学年第1学期")).toBe(true);
  expect(courseLabelMatches("人工智能中的编程(25-26学年第1学期)", "人工智能中的编程", "26-27学年第1学期")).toBe(false);
  expect(courseLabelMatches("机器学习 (2026 Fall)", "机器学习", "2026-fall")).toBe(true);
  expect(courseLabelMatches("机器学习(26-27学年第1学期)", "机器学习", "2026-fall")).toBe(true);
  expect(courseLabelMatches("机器学习(26-27学年第2学期)", "机器学习", "2027-spring")).toBe(true);
  expect(courseLabelMatches("机器学习 (2025 Fall)", "机器学习", "2026-fall")).toBe(false);
  expect(courseLabelMatches("高等数学(A)（二）(24-25学年第2学期)", "高等数学(A)（二）", "24-25学年第2学期")).toBe(true);
  expect(courseLabelMatches("高等数学(A)(一)(24-25学年第2学期)", "高等数学(A)（二）", "24-25学年第2学期")).toBe(false);
  expect(courseLabelMatches("机器学习", "机器学习", "2026-fall")).toBe(true);
});
