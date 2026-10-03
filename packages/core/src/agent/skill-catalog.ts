/** Transport-safe labels shared by the command picker. Permissions still come from session tools. */
export const assistantSkillCatalog = [
  { name: "lesson-learning", label: "整理本节课", description: "依据本节原文生成或更新讲义", scopes: ["lesson"] },
  { name: "practice-generator", label: "生成自测", description: "生成题目与独立答案", scopes: ["lesson", "course"] },
  { name: "lesson-review", label: "复习提纲", description: "将本节重点与易错点保存为复习资料", scopes: ["lesson"] },
  { name: "material-organizer", label: "整理公共资料", description: "检查公共资料用途与解析状态，按内容分类", scopes: ["course"] },
  { name: "course-sync", label: "同步资料", description: "检查教学网并导入指定资源", scopes: ["course"] },
  { name: "lecture-notes", label: "整理笔记", description: "生成课程级独立笔记", scopes: ["course", "lecture-notes"] },
  { name: "assignment-solver", label: "作业草稿", description: "准备可审阅的草稿", scopes: ["course"] },
] as const;
export function assistantSkillsFor(scope: "course" | "lesson" | "lecture-notes", hasFileMentions: boolean) {
  if (hasFileMentions && scope !== "lesson") return [];
  return assistantSkillCatalog.filter(skill => (skill.scopes as readonly string[]).includes(scope));
}
