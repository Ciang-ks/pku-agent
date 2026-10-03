import type { CourseWorkspace } from "../../domain/types.js";
import type { CourseWorkspaceService } from "../../storage/course-workspace-service.js";
import { LearningError } from "../../learning/lesson-service.js";
import type { Pku3bExecutor } from "./teaching-network-service.js";
import { parseCourseContentList, stripAnsi } from "./output.js";

export interface DiscoveredCourse { title: string; remoteCourseId?: string; courseId?: string }
/** Content rows identify populated courses; pku3b's catalog identifies empty ones. */
export class CourseDiscoveryService {
  private readonly pending = new Map<string, Promise<CourseWorkspace>>();
  constructor(private readonly pku3b: Pku3bExecutor, private readonly courses: CourseWorkspaceService) {}
  async discover(otp?: string): Promise<DiscoveredCourse[]> {
    if (this.pku3b.structured) {
      const result = await this.pku3b.structured.listCourses(otp ? { otp } : {});
      if (!result.ok) throw new LearningError(result.error.code, result.error.message, result.requiresAction ? 401 : 502);
      const local = this.courses.list();
      return result.data.map(remote => {
        const course = local.find(c => c.remoteCourseId === remote.remoteCourseId);
        return { ...remote, ...(course ? { courseId: course.courseId } : {}) };
      });
    }
    const command = { kind: "course-content-list" as const, allTerm: true, ...(otp ? { otp } : {}) };
    let result = await this.pku3b.runRead(command);
    // pku3b 0.16 can accept a logged-out portal as a valid session after init.
    // Retry this specific failure once with login/cache refresh, preserving OTP.
    if (!result.ok && result.error.code === "PKU3B_COMMAND_FAILED" && /courses not found/i.test(result.error.message)) {
      result = await this.pku3b.runRead({ ...command, force: true });
    }
    if (!result.ok) throw new LearningError(result.error.code, result.error.message, result.requiresAction ? 401 : 502);
    const resources = parseCourseContentList(result.data.stdout, "discovery");
    const titles = [...new Set(stripAnsi(result.data.stdout).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("•")))];
    const catalog = await this.pku3b.courseCatalog?.(titles) ?? [];
    const localCourses = this.courses.list();
    return titles.flatMap(title => {
      const resourceIds = resources.filter(r => r.courseTitle === title).map(r => r.resource.remoteCourseId);
      const ids = [...new Set(resourceIds.length ? resourceIds : catalog.filter(c => c.title === title).map(c => c.remoteCourseId))];
      if (!ids.length) return [{ title }];
      return ids.map(remoteCourseId => {
        const local = localCourses.find(c => c.remoteCourseId === remoteCourseId);
        return { title, remoteCourseId, ...(local ? { courseId: local.courseId } : {}) };
      });
    });
  }
  async import(input: { remoteCourseId: string; title: string; teacher?: string; term?: string; otp?: string }) {
    const existing = this.courses.list().find(c => c.remoteCourseId === input.remoteCourseId);
    if (existing) return existing;
    const running = this.pending.get(input.remoteCourseId);
    if (running) return running;
    const task = (async () => {
      const remote = (await this.discover(input.otp)).find(c => c.remoteCourseId === input.remoteCourseId && c.title === input.title);
      if (!remote) throw new LearningError("REMOTE_COURSE_NOT_FOUND", "课程不在当前教学网列表中", 404);
      const concurrent = this.courses.list().find(c => c.remoteCourseId === input.remoteCourseId);
      if (concurrent) return concurrent;
      const match = /^(.*?)\s*[（(]([^()（）]*)[）)]\s*$/.exec(remote.title);
      return this.courses.create({ name: match?.[1]?.trim() || remote.title, teacher: input.teacher?.trim() || "教师待补充",
        term: input.term?.trim() || match?.[2]?.trim() || "学期待补充", remoteCourseId: input.remoteCourseId });
    })().finally(() => this.pending.delete(input.remoteCourseId));
    this.pending.set(input.remoteCourseId, task);
    return task;
  }
}
