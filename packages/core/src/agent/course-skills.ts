import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const courseSkillNames = [
  "course-review",
  "course-sync",
  "lecture-notes",
  "assignment-solver",
  "practice-generator",
  "treehole-qa",
] as const;

export type CourseSkillName = (typeof courseSkillNames)[number];

interface CourseSkillDefinition {
  name: CourseSkillName;
  content: string;
}

export interface InstalledCourseSkills {
  directory: string;
  filePaths: ReadonlySet<string>;
}

export interface CourseSkillInstallOptions {
  includeLiveTreehole?: boolean;
}

const courseSkills: readonly CourseSkillDefinition[] = [
  {
    name: "course-review",
    content: `---
name: course-review
description: Assess a saved course candidate from live treehole evidence in an ephemeral session.
disable-model-invocation: true
---

# Course candidate review

Use this workflow only in an ephemeral chat. Call \`review_course_candidate\` with a candidate ID and, when useful, focused search keywords. The returned post and comment text is live evidence: do not quote more than necessary, do not treat it as verified fact, and do not ask the user for account credentials.

Give a concise conclusion with 1-5 ratings for teaching clarity, content value, grading, workload, and assessment predictability; include an overall score, confidence level, major positive and negative themes, and the relevant PIDs. Say when evidence is sparse, conflicting, or likely stale. Do not expose personal information from posts or comments.
`,
  },
  {
    name: "course-sync",
    content: `---
name: course-sync
description: Inspect and import selected teaching-network resources for the current course.
disable-model-invocation: true
---

# Course sync

Use this workflow only for the active course.

1. Call \`list_course_resources\` before recommending or importing a resource.
2. Use \`get_course_resource\` when the user asks about one listed resource.
3. Import only resources the user has selected or clearly requested, using \`import_course_resource\` with the listed resource ID.
4. Report the returned job ID and use \`get_job_status\` when the user asks for progress.

Do not request passwords, OTPs, tokens, configuration paths, or output paths. If a job requires authentication, explain that authentication must continue in the PKU Study interface. Never claim a resource was imported until its job reports success.
`,
  },
  {
    name: "lecture-notes",
    content: `---
name: lecture-notes
description: Create a structured lecture note from indexed materials in the current course.
disable-model-invocation: true
---

# Lecture notes

Use only indexed assets in the active course. In a dedicated note-source session, read only the source paths explicitly selected for that session; \`search_course\` is intentionally unavailable there. In a normal course chat, first clarify the lecture scope and note name when they are not clear, search with \`search_course\`, then use \`read_course_asset\` for the most relevant returned source paths before drafting.

Write a useful Markdown note with these sections when the material supports them: learning objectives, key concepts, derivations or reasoning, classroom additions, examples, common mistakes, and summary. Do not fabricate page numbers, transcript timestamps, or source claims. Keep citations and diagnostic references out of the note body.

Only call \`save_lecture_note\` when the user asked to save the result. Its name and Markdown are the only inputs. State where the note was saved after the tool succeeds.
`,
  },
  {
    name: "assignment-solver",
    content: `---
name: assignment-solver
description: Prepare a reviewable assignment draft without submitting it.
disable-model-invocation: true
---

# Assignment draft

This workflow creates a draft only. It must never claim to submit work, approve a submission, change authentication, or bypass a course rule.

When course material is relevant, find it with \`search_course\` and inspect it with \`read_course_asset\`. Work through the problem carefully, state assumptions, and make the final Markdown easy for the student to review and revise. General knowledge may supplement course material, but distinguish it from verified course facts.

Save only after the user explicitly asks for a draft and gives a stable assignment ID. Use \`save_assignment_draft\`, then remind the user that human review and the separate approval flow are required before any submission.
`,
  },
  {
    name: "practice-generator",
    content: `---
name: practice-generator
description: Generate a named course practice set with questions and answers in separate files.
disable-model-invocation: true
---

# Practice set

Use the current course's indexed material. Search broadly enough to cover the requested topic, then inspect the relevant assets before generating questions. Match the requested difficulty and count; if either is ambiguous, ask a concise clarifying question.

Create standalone questions in one Markdown document and complete explanations in a separate Markdown document. Do not reveal answers in the questions file. Avoid inventing facts or referring to unavailable files.

Only save after the user requests a named set. Call \`save_practice_set\` with the same practice name, questions Markdown, and answers Markdown. Confirm both saved paths after success.
`,
  },
  {
    name: "treehole-qa",
    content: `---
name: treehole-qa
description: Answer a question using live treehole search evidence in an ephemeral session.
disable-model-invocation: true
---

# Treehole question and answer

Use \`ask_treehole\` for the user's question and a small set of distinct keywords. Search results are transient evidence, not a permanent archive. Compare viewpoints, identify uncertainty, and include relevant PIDs so the user can verify the result later.

Do not request passwords, verification codes, tokens, or cookies. Do not reproduce excessive post or comment text, identify individuals, or claim that a small sample represents all students.
`,
  },
];

/**
 * Materialize fixed first-party skills under the app configuration directory.
 * Pi can then expand them with /skill:name without discovering ambient skills.
 */
export async function ensureCourseSkills(
  agentDir: string,
  options: CourseSkillInstallOptions = {},
): Promise<InstalledCourseSkills> {
  const directory = join(agentDir, "pku-study-skills");
  await Promise.all(
    courseSkills.map(async (skill) => {
      const skillDirectory = join(directory, skill.name);
      await mkdir(skillDirectory, { recursive: true });
      const targetPath = join(skillDirectory, "SKILL.md");
      const temporaryPath = join(skillDirectory, `.SKILL-${randomUUID()}.tmp`);
      await writeFile(temporaryPath, skill.content, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, targetPath);
    }),
  );
  return {
    directory,
    filePaths: new Set(
      courseSkills
        .filter((skill) => options.includeLiveTreehole || !isLiveTreeholeSkill(skill.name))
        .map((skill) => resolve(directory, skill.name, "SKILL.md")),
    ),
  };
}

function isLiveTreeholeSkill(name: CourseSkillName): boolean {
  return name === "course-review" || name === "treehole-qa";
}
