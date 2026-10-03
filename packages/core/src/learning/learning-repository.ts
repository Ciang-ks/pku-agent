import { compareLessons, recordingLessonDate } from "./lesson-order.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { Lesson, Material } from "./types.js";

/** Additive tables keep existing courses and legacy notes intact. */
export class LearningRepository {
  constructor(private readonly store: SqliteStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_lessons (
        lesson_id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(course_id),
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS learning_lessons_course ON learning_lessons(course_id);
      CREATE TABLE IF NOT EXISTS learning_materials (
        asset_id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(course_id),
        sha256 TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(course_id, sha256)
      );
    `);
  }
  lessons(courseId: string): Lesson[] {
    const dates = this.recordingDates(courseId);
    return this.rows<Lesson>("SELECT payload FROM learning_lessons WHERE course_id = ? ORDER BY lesson_id", courseId)
      .map(lesson => this.normalizeLesson(lesson, dates)).sort(compareLessons);
  }
  lesson(courseId: string, lessonId: string): Lesson | undefined {
    const row = this.store.db.prepare("SELECT payload FROM learning_lessons WHERE course_id = ? AND lesson_id = ?")
      .get(courseId, lessonId) as { payload: string } | undefined;
    return row ? this.normalizeLesson(JSON.parse(row.payload) as Lesson, this.recordingDates(courseId)) : undefined;
  }
  private recordingDates(courseId: string): Map<string, string> {
    return new Map(this.store.listTeachingItems(courseId, "video").flatMap(recording => {
      const date = recording.remoteIdStable ? recordingLessonDate(recording) : undefined;
      return date ? [[recording.remoteId, date] as const] : [];
    }));
  }
  private normalizeLesson(lesson: Lesson, dates: Map<string, string>): Lesson {
    // Legacy undated lessons can use existing recording metadata without a write-on-read migration.
    const derived = lesson.recordingIds.flatMap(id => dates.has(id) ? [dates.get(id)!] : []).sort()[0];
    return { ...lesson, date: lesson.date || derived || "", recordingAssetIds: lesson.recordingAssetIds ?? [] };
  }
  saveLesson(lesson: Lesson, expectedRevision?: number): void {
    if (expectedRevision !== undefined) {
      const result = this.store.db.prepare(`UPDATE learning_lessons SET payload = ? WHERE lesson_id = ? AND course_id = ? AND json_extract(payload, '$.revision') = ?`)
        .run(JSON.stringify(lesson), lesson.lessonId, lesson.courseId, expectedRevision);
      if (result.changes !== 1) throw Object.assign(new Error("课次已更新，请重新读取后再保存"), { code: "REVISION_CONFLICT", statusCode: 409 });
      return;
    }
    this.store.db.prepare(`INSERT INTO learning_lessons VALUES (?, ?, ?)
      ON CONFLICT(lesson_id) DO UPDATE SET payload = excluded.payload`)
      .run(lesson.lessonId, lesson.courseId, JSON.stringify(lesson));
  }
  materials(courseId: string): Material[] {
    return this.rows<Material>("SELECT payload FROM learning_materials WHERE course_id = ? ORDER BY asset_id", courseId);
  }
  saveMaterial(material: Material): void {
    this.store.db.prepare(`INSERT INTO learning_materials VALUES (?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET payload = excluded.payload`)
      .run(material.assetId, material.courseId, material.sha256, JSON.stringify(material));
  }
  private rows<T>(sql: string, courseId: string): T[] {
    return (this.store.db.prepare(sql).all(courseId) as { payload: string }[]).map(row => JSON.parse(row.payload) as T);
  }
}
