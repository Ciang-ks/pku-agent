import { expect, it } from "vitest";
import { noteAssistantScope, pageAssistantScope } from "../src/assistant-scope";
import { assistantSkillsFor, assistantSkillCatalog } from "../../../packages/core/src/agent/skill-catalog";
import { courseSkillNames } from "../../../packages/core/src/agent/course-skills";
it("keeps distinct course and lesson identities while sharing the course conversation across pages", () => {
  const first = { lessonId: "lesson-1", title: "第一课" };
  const second = { lessonId: "lesson-2", title: "第二课" };
  expect(pageAssistantScope("course", "课程", "lessons", first)).toMatchObject({ kind: "lesson", lessonId: "lesson-1", label: "第一课" });
  expect(pageAssistantScope("course", "课程", "lessons", first).key).not.toBe(pageAssistantScope("course", "课程", "lessons", second).key);
  expect(pageAssistantScope("course", "课程", "library", first).key).toBe(pageAssistantScope("course", "课程", "recordings", second).key);
  expect(pageAssistantScope("other", "课程", "lessons", first).key).not.toBe(pageAssistantScope("course", "课程", "lessons", first).key);
  expect(pageAssistantScope("course", "课程", "lessons").kind).toBe("course");
});
it("normalizes legacy source selections without mixing different source scopes", () => {
  expect(noteAssistantScope("c", ["b", "a", "a"]).key).toBe(noteAssistantScope("c", ["a", "b"]).key);
  expect(noteAssistantScope("c", ["a"]).key).not.toBe(noteAssistantScope("c", ["a", "b"]).key);
});
it("offers only installed workflows appropriate for the active context", () => {
  for (const skill of assistantSkillCatalog) expect(courseSkillNames).toContain(skill.name);
  expect(assistantSkillsFor("lesson", true).map(s => s.name)).toEqual(["lesson-learning", "practice-generator", "lesson-review"]);
  expect(assistantSkillsFor("course", true)).toEqual([]);
  expect(assistantSkillsFor("course", false).map(s => s.name)).toContain("material-organizer");
  expect(assistantSkillsFor("course", false).map(s => s.name)).not.toContain("lesson-review");
  expect(assistantSkillsFor("lecture-notes", false).map(s => s.name)).toEqual(["lecture-notes"]);
});
