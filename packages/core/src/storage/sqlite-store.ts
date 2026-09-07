import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  CourseCandidate,
  CourseCandidateReview,
  IntegrationState,
  CourseWorkspace,
  JobRecord,
  RemoteResourceRef,
  CourseDocumentBlock,
  DocumentSearchResult,
  TeachingItem,
  TeachingItemKind,
  JobContext,
  AssignmentApproval,
} from "../domain/types.js";

interface CourseRow {
  course_id: string;
  name: string;
  teacher: string;
  term: string;
  remote_course_id: string | null;
  root_path: string;
  created_at: string;
  updated_at: string;
}

interface CourseCandidateRow {
  candidate_id: string;
  name: string;
  teacher: string;
  aliases_json: string;
  status: CourseCandidate["status"];
  created_at: string;
  updated_at: string;
}

interface CourseCandidateReviewRow {
  candidate_id: string;
  teaching_clarity: number;
  content_value: number;
  grading: number;
  workload: number;
  predictability: number;
  overall: number;
  confidence: CourseCandidateReview["confidence"];
  summary: string;
  positives_json: string;
  negatives_json: string;
  related_pids_json: string;
  reviewed_at: string;
}

interface JobRow {
  job_id: string;
  kind: string;
  status: JobRecord["status"];
  progress: number;
  message: string | null;
  error_code: string | null;
  error_message: string | null;
  requires_action: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentApprovalRow {
  approval_id: string;
  course_id: string;
  assignment_remote_id: string;
  file_path: string;
  sha256: string;
  expires_at: string;
}

interface RemoteResourceRow {
  resource_id: string;
  course_id: string;
  provider: "pku3b";
  remote_course_id: string;
  remote_resource_id: string;
  kind: RemoteResourceRef["kind"];
  title: string;
  parent_id: string | null;
  has_details: number;
  is_imported: number;
  local_path: string | null;
  updated_at: string;
}

interface IntegrationRow {
  provider: "pku3b";
  auth_state: IntegrationState["authState"];
  detail: string | null;
  version: string | null;
  updated_at: string;
}

interface TeachingItemRow {
  item_id: string;
  course_id: string;
  provider: "pku3b";
  remote_id: string;
  remote_id_stable: number;
  kind: TeachingItemKind;
  title: string;
  course_label: string;
  occurred_at: string | null;
  occurred_text: string | null;
  due_at: string | null;
  due_text: string | null;
  completed: number | null;
  score: number | null;
  possible_score: number | null;
  attachment_count: number | null;
  updated_at: string;
}

interface DocumentBlockRow {
  block_id: string;
  course_id: string;
  source_path: string;
  title: string;
  page: number | null;
  content_type: CourseDocumentBlock["contentType"];
  text: string;
  updated_at: string;
  rank?: number;
}

interface DocumentVectorRow {
  block_id: string;
  provider: string;
  vector_json: string;
}

export class SqliteStore {
  readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS courses (
        course_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        teacher TEXT NOT NULL,
        term TEXT NOT NULL,
        remote_course_id TEXT,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS course_candidates (
        candidate_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        teacher TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidate_reviews (
        candidate_id TEXT PRIMARY KEY REFERENCES course_candidates(candidate_id) ON DELETE CASCADE,
        teaching_clarity INTEGER NOT NULL,
        content_value INTEGER NOT NULL,
        grading INTEGER NOT NULL,
        workload INTEGER NOT NULL,
        predictability INTEGER NOT NULL,
        overall INTEGER NOT NULL,
        confidence TEXT NOT NULL,
        summary TEXT NOT NULL,
        positives_json TEXT NOT NULL,
        negatives_json TEXT NOT NULL,
        related_pids_json TEXT NOT NULL,
        reviewed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_resources (
        resource_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        remote_course_id TEXT NOT NULL,
        remote_resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        parent_id TEXT,
        has_details INTEGER NOT NULL,
        is_imported INTEGER NOT NULL,
        local_path TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, remote_course_id, remote_resource_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        message TEXT,
        error_code TEXT,
        error_message TEXT,
        requires_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assignment_approvals (
        approval_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
        assignment_remote_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS integration_states (
        provider TEXT PRIMARY KEY,
        auth_state TEXT NOT NULL,
        detail TEXT,
        version TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_contexts (
        job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
        context_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS teaching_items (
        item_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        remote_id_stable INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        course_label TEXT NOT NULL,
        occurred_at TEXT,
        occurred_text TEXT,
        due_at TEXT,
        due_text TEXT,
        completed INTEGER,
        score REAL,
        possible_score REAL,
        attachment_count INTEGER,
        updated_at TEXT NOT NULL,
        UNIQUE(course_id, kind, remote_id)
      );

      CREATE TABLE IF NOT EXISTS document_blocks (
        block_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        title TEXT NOT NULL,
        page INTEGER,
        content_type TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(course_id, source_path, block_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_blocks_fts USING fts5(
        text,
        title,
        content='document_blocks',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS document_blocks_ai AFTER INSERT ON document_blocks BEGIN
        INSERT INTO document_blocks_fts(rowid, text, title) VALUES (new.rowid, new.text, new.title);
      END;
      CREATE TRIGGER IF NOT EXISTS document_blocks_ad AFTER DELETE ON document_blocks BEGIN
        INSERT INTO document_blocks_fts(document_blocks_fts, rowid, text, title) VALUES ('delete', old.rowid, old.text, old.title);
      END;
      CREATE TRIGGER IF NOT EXISTS document_blocks_au AFTER UPDATE ON document_blocks BEGIN
        INSERT INTO document_blocks_fts(document_blocks_fts, rowid, text, title) VALUES ('delete', old.rowid, old.text, old.title);
        INSERT INTO document_blocks_fts(rowid, text, title) VALUES (new.rowid, new.text, new.title);
      END;

      CREATE TABLE IF NOT EXISTS document_vectors (
        block_id TEXT NOT NULL REFERENCES document_blocks(block_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        PRIMARY KEY(block_id, provider)
      );

      CREATE INDEX IF NOT EXISTS remote_resources_course_idx
        ON remote_resources(course_id, parent_id);
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS teaching_items_course_idx
        ON teaching_items(course_id, kind, due_at, occurred_at);
    `);
  }

  listCourses(): CourseWorkspace[] {
    const rows = this.db.prepare("SELECT * FROM courses ORDER BY term DESC, name").all() as CourseRow[];
    return rows.map(mapCourse);
  }

  getCourse(courseId: string): CourseWorkspace | undefined {
    const row = this.db
      .prepare("SELECT * FROM courses WHERE course_id = ?")
      .get(courseId) as CourseRow | undefined;
    return row ? mapCourse(row) : undefined;
  }

  listCourseCandidates(): CourseCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM course_candidates ORDER BY updated_at DESC, name")
      .all() as CourseCandidateRow[];
    return rows.map((row) => mapCourseCandidate(row, this.getCourseCandidateReview(row.candidate_id)));
  }

  getCourseCandidate(candidateId: string): CourseCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM course_candidates WHERE candidate_id = ?")
      .get(candidateId) as CourseCandidateRow | undefined;
    return row ? mapCourseCandidate(row, this.getCourseCandidateReview(candidateId)) : undefined;
  }

  insertCourseCandidate(candidate: Omit<CourseCandidate, "review">): void {
    this.db.prepare(`
      INSERT INTO course_candidates (
        candidate_id, name, teacher, aliases_json, status, created_at, updated_at
      ) VALUES (
        @candidateId, @name, @teacher, @aliasesJson, @status, @createdAt, @updatedAt
      )
    `).run({ ...candidate, aliasesJson: JSON.stringify(candidate.aliases) });
  }

  updateCourseCandidateStatus(candidateId: string, status: CourseCandidate["status"]): void {
    this.db.prepare(`
      UPDATE course_candidates SET status = ?, updated_at = ? WHERE candidate_id = ?
    `).run(status, new Date().toISOString(), candidateId);
  }

  upsertCourseCandidateReview(candidateId: string, review: CourseCandidateReview): void {
    this.db.prepare(`
      INSERT INTO candidate_reviews (
        candidate_id, teaching_clarity, content_value, grading, workload, predictability,
        overall, confidence, summary, positives_json, negatives_json, related_pids_json, reviewed_at
      ) VALUES (
        @candidateId, @teachingClarity, @contentValue, @grading, @workload, @predictability,
        @overall, @confidence, @summary, @positivesJson, @negativesJson, @relatedPidsJson, @reviewedAt
      )
      ON CONFLICT(candidate_id) DO UPDATE SET
        teaching_clarity = excluded.teaching_clarity,
        content_value = excluded.content_value,
        grading = excluded.grading,
        workload = excluded.workload,
        predictability = excluded.predictability,
        overall = excluded.overall,
        confidence = excluded.confidence,
        summary = excluded.summary,
        positives_json = excluded.positives_json,
        negatives_json = excluded.negatives_json,
        related_pids_json = excluded.related_pids_json,
        reviewed_at = excluded.reviewed_at
    `).run({
      candidateId,
      ...review,
      positivesJson: JSON.stringify(review.positives),
      negativesJson: JSON.stringify(review.negatives),
      relatedPidsJson: JSON.stringify(review.relatedPids),
    });
    this.db.prepare("UPDATE course_candidates SET updated_at = ? WHERE candidate_id = ?")
      .run(new Date().toISOString(), candidateId);
  }

  insertCourse(course: CourseWorkspace): void {
    this.db
      .prepare(`
        INSERT INTO courses (
          course_id, name, teacher, term, remote_course_id, root_path, created_at, updated_at
        ) VALUES (
          @courseId, @name, @teacher, @term, @remoteCourseId, @rootPath, @createdAt, @updatedAt
        )
      `)
      .run({ ...course, remoteCourseId: course.remoteCourseId ?? null });
  }

  deleteCourse(courseId: string): void {
    this.db.prepare("DELETE FROM courses WHERE course_id = ?").run(courseId);
  }

  upsertRemoteResource(resource: RemoteResourceRef): void {
    this.db
      .prepare(`
        INSERT INTO remote_resources (
          resource_id, course_id, provider, remote_course_id, remote_resource_id, kind,
          title, parent_id, has_details, is_imported, local_path, updated_at
        ) VALUES (
          @resourceId, @courseId, @provider, @remoteCourseId, @remoteResourceId, @kind,
          @title, @parentId, @hasDetails, @isImported, @localPath, @updatedAt
        )
        ON CONFLICT(resource_id) DO UPDATE SET
          title = excluded.title,
          parent_id = excluded.parent_id,
          has_details = excluded.has_details,
          updated_at = excluded.updated_at
      `)
      .run({
        ...resource,
        parentId: resource.parentId ?? null,
        hasDetails: resource.hasDetails ? 1 : 0,
        isImported: resource.isImported ? 1 : 0,
        localPath: resource.localPath ?? null,
      });
  }

  replaceRemoteResources(courseId: string, resources: RemoteResourceRef[]): void {
    const replace = this.db.transaction(() => {
      for (const resource of resources) this.upsertRemoteResource(resource);
      if (resources.length === 0) {
        this.db.prepare("DELETE FROM remote_resources WHERE course_id = ?").run(courseId);
        return;
      }
      const placeholders = resources.map(() => "?").join(", ");
      this.db
        .prepare(
          `DELETE FROM remote_resources WHERE course_id = ? AND resource_id NOT IN (${placeholders})`,
        )
        .run(courseId, ...resources.map((resource) => resource.resourceId));
    });
    replace();
  }

  listRemoteResources(courseId: string): RemoteResourceRef[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM remote_resources WHERE course_id = ? ORDER BY parent_id, kind, title",
      )
      .all(courseId) as RemoteResourceRow[];
    return rows.map(mapRemoteResource);
  }

  getRemoteResource(resourceId: string): RemoteResourceRef | undefined {
    const row = this.db
      .prepare("SELECT * FROM remote_resources WHERE resource_id = ?")
      .get(resourceId) as RemoteResourceRow | undefined;
    return row ? mapRemoteResource(row) : undefined;
  }

  markRemoteResourceImported(resourceId: string, localPath: string): void {
    this.db
      .prepare(
        `UPDATE remote_resources
         SET is_imported = 1, local_path = ?, updated_at = ?
         WHERE resource_id = ?`,
      )
      .run(localPath, new Date().toISOString(), resourceId);
  }

  replaceTeachingItems(
    courseId: string,
    kinds: TeachingItemKind[],
    items: TeachingItem[],
  ): void {
    const upsert = this.db.prepare(`
      INSERT INTO teaching_items (
        item_id, course_id, provider, remote_id, remote_id_stable, kind, title,
        course_label, occurred_at, occurred_text, due_at, due_text, completed,
        score, possible_score, attachment_count, updated_at
      ) VALUES (
        @itemId, @courseId, @provider, @remoteId, @remoteIdStable, @kind, @title,
        @courseLabel, @occurredAt, @occurredText, @dueAt, @dueText, @completed,
        @score, @possibleScore, @attachmentCount, @updatedAt
      )
      ON CONFLICT(item_id) DO UPDATE SET
        title = excluded.title,
        course_label = excluded.course_label,
        occurred_at = excluded.occurred_at,
        occurred_text = excluded.occurred_text,
        due_at = excluded.due_at,
        due_text = excluded.due_text,
        completed = excluded.completed,
        score = excluded.score,
        possible_score = excluded.possible_score,
        attachment_count = excluded.attachment_count,
        updated_at = excluded.updated_at
    `);
    const replace = this.db.transaction(() => {
      if (kinds.length > 0) {
        const placeholders = kinds.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM teaching_items WHERE course_id = ? AND kind IN (${placeholders})`)
          .run(courseId, ...kinds);
      }
      for (const item of items) upsert.run(teachingItemParams(item));
    });
    replace();
  }

  listTeachingItems(courseId: string, kind?: TeachingItemKind): TeachingItem[] {
    const rows = (kind
      ? this.db
          .prepare(
            `SELECT * FROM teaching_items WHERE course_id = ? AND kind = ?
             ORDER BY COALESCE(due_at, occurred_at, updated_at) DESC`,
          )
          .all(courseId, kind)
      : this.db
          .prepare(
            `SELECT * FROM teaching_items WHERE course_id = ?
             ORDER BY COALESCE(due_at, occurred_at, updated_at) DESC`,
          )
          .all(courseId)) as TeachingItemRow[];
    return rows.map(mapTeachingItem);
  }

  replaceDocumentBlocks(courseId: string, sourcePath: string, blocks: CourseDocumentBlock[]): void {
    const replace = this.db.transaction(() => {
      this.db.prepare("DELETE FROM document_blocks WHERE course_id = ? AND source_path = ?").run(courseId, sourcePath);
      const insert = this.db.prepare(`
        INSERT INTO document_blocks (
          block_id, course_id, source_path, title, page, content_type, text, updated_at
        ) VALUES (@blockId, @courseId, @sourcePath, @title, @page, @contentType, @text, @updatedAt)
      `);
      for (const block of blocks) insert.run({ ...block, page: block.page ?? null });
    });
    replace();
  }

  listDocumentBlocks(courseId: string): CourseDocumentBlock[] {
    const rows = this.db.prepare(`
      SELECT * FROM document_blocks WHERE course_id = ? ORDER BY source_path, rowid
    `).all(courseId) as DocumentBlockRow[];
    return rows.map(mapDocumentBlock);
  }

  listDocumentBlocksForSource(courseId: string, sourcePath: string): CourseDocumentBlock[] {
    const rows = this.db.prepare(`
      SELECT * FROM document_blocks
      WHERE course_id = ? AND source_path = ?
      ORDER BY rowid
    `).all(courseId, sourcePath) as DocumentBlockRow[];
    return rows.map(mapDocumentBlock);
  }

  clearDocumentBlocks(courseId: string): void {
    this.db.prepare("DELETE FROM document_blocks WHERE course_id = ?").run(courseId);
  }

  searchDocumentBlocks(courseId: string, query: string, limit: number): DocumentSearchResult[] {
    const safeQuery = query.trim().replace(/["']/g, " ");
    if (!safeQuery) return [];
    let rows: DocumentBlockRow[] = [];
    try {
      rows = this.db.prepare(`
        SELECT d.*, bm25(document_blocks_fts) AS rank
        FROM document_blocks_fts
        JOIN document_blocks d ON d.rowid = document_blocks_fts.rowid
        WHERE document_blocks_fts MATCH ? AND d.course_id = ?
        ORDER BY rank LIMIT ?
      `).all(safeQuery, courseId, limit) as DocumentBlockRow[];
    } catch {
      // FTS5 treats punctuation and boolean operators as query syntax. A
      // malformed user query should degrade to the LIKE fallback below
      // instead of turning a search request into a 500 response.
      rows = [];
    }
    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT d.*, 0 AS rank
        FROM document_blocks d
        WHERE d.course_id = ? AND (d.text LIKE ? OR d.title LIKE ?)
        ORDER BY d.updated_at DESC LIMIT ?
      `).all(courseId, `%${query}%`, `%${query}%`, limit) as DocumentBlockRow[];
    }
    return rows.map((row) => ({ block: mapDocumentBlock(row), score: Math.max(0, -Number(row.rank ?? 0)) }));
  }

  getDocumentVectors(courseId: string, provider: string): { blockId: string; vector: number[] }[] {
    const rows = this.db.prepare(`
      SELECT v.block_id, v.provider, v.vector_json
      FROM document_vectors v JOIN document_blocks d ON d.block_id = v.block_id
      WHERE d.course_id = ? AND v.provider = ?
    `).all(courseId, provider) as DocumentVectorRow[];
    return rows.flatMap((row) => {
      try {
        const vector = JSON.parse(row.vector_json) as unknown;
        return Array.isArray(vector) && vector.every((value) => typeof value === "number" && Number.isFinite(value))
          ? [{ blockId: row.block_id, vector }]
          : [];
      } catch {
        return [];
      }
    });
  }

  upsertDocumentVectors(provider: string, vectors: { blockId: string; vector: number[] }[]): void {
    const insert = this.db.prepare(`
      INSERT INTO document_vectors (block_id, provider, vector_json) VALUES (?, ?, ?)
      ON CONFLICT(block_id, provider) DO UPDATE SET vector_json = excluded.vector_json
    `);
    const write = this.db.transaction(() => {
      for (const { blockId, vector } of vectors) insert.run(blockId, provider, JSON.stringify(vector));
    });
    write();
  }

  insertJob(job: JobRecord): void {
    this.db.prepare(`
      INSERT INTO jobs (
        job_id, kind, status, progress, message, error_code, error_message,
        requires_action, created_at, updated_at
      ) VALUES (
        @jobId, @kind, @status, @progress, @message, @errorCode, @errorMessage,
        @requiresAction, @createdAt, @updatedAt
      )
    `).run(jobParams(job));
  }

  updateJob(job: JobRecord): void {
    this.db.prepare(`
      UPDATE jobs SET
        status = @status,
        progress = @progress,
        message = @message,
        error_code = @errorCode,
        error_message = @errorMessage,
        requires_action = @requiresAction,
        updated_at = @updatedAt
      WHERE job_id = @jobId
    `).run(jobParams(job));
  }

  getJob(jobId: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      | JobRow
      | undefined;
    return row ? mapJob(row) : undefined;
  }

  listActiveJobs(): JobRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM jobs
        WHERE status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY created_at
      `)
      .all() as JobRow[];
    return rows.map(mapJob);
  }

  setJobContext(jobId: string, context: JobContext): void {
    this.db
      .prepare(
        `INSERT INTO job_contexts (job_id, context_json) VALUES (?, ?)
         ON CONFLICT(job_id) DO UPDATE SET context_json = excluded.context_json`,
      )
      .run(jobId, JSON.stringify(context));
  }

  getJobContext(jobId: string): JobContext | undefined {
    const row = this.db
      .prepare("SELECT context_json FROM job_contexts WHERE job_id = ?")
      .get(jobId) as { context_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.context_json) as JobContext;
  }

  insertAssignmentApproval(approval: AssignmentApproval): void {
    this.db.prepare(`
      INSERT INTO assignment_approvals (
        approval_id, course_id, assignment_remote_id, file_path, sha256, expires_at
      ) VALUES (@approvalId, @courseId, @assignmentRemoteId, @filePath, @sha256, @expiresAt)
    `).run(approvalParams(approval));
  }

  getAssignmentApproval(approvalId: string): AssignmentApproval | undefined {
    const row = this.db
      .prepare("SELECT * FROM assignment_approvals WHERE approval_id = ?")
      .get(approvalId) as AssignmentApprovalRow | undefined;
    return row ? mapAssignmentApproval(row) : undefined;
  }

  deleteAssignmentApproval(approvalId: string): void {
    this.db.prepare("DELETE FROM assignment_approvals WHERE approval_id = ?").run(approvalId);
  }

  getIntegrationState(provider: "pku3b"): IntegrationState | undefined {
    const row = this.db
      .prepare("SELECT * FROM integration_states WHERE provider = ?")
      .get(provider) as IntegrationRow | undefined;
    return row ? mapIntegrationState(row) : undefined;
  }

  setIntegrationState(state: IntegrationState): void {
    this.db
      .prepare(
        `INSERT INTO integration_states (provider, auth_state, detail, version, updated_at)
         VALUES (@provider, @authState, @detail, @version, @updatedAt)
         ON CONFLICT(provider) DO UPDATE SET
           auth_state = excluded.auth_state,
           detail = excluded.detail,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...state,
        detail: state.detail ?? null,
        version: state.version ?? null,
      });
  }

  private getCourseCandidateReview(candidateId: string): CourseCandidateReview | undefined {
    const row = this.db
      .prepare("SELECT * FROM candidate_reviews WHERE candidate_id = ?")
      .get(candidateId) as CourseCandidateReviewRow | undefined;
    return row ? mapCourseCandidateReview(row) : undefined;
  }
}

function mapCourse(row: CourseRow): CourseWorkspace {
  return {
    courseId: row.course_id,
    name: row.name,
    teacher: row.teacher,
    term: row.term,
    ...(row.remote_course_id ? { remoteCourseId: row.remote_course_id } : {}),
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCourseCandidate(
  row: CourseCandidateRow,
  review: CourseCandidateReview | undefined,
): CourseCandidate {
  return {
    candidateId: row.candidate_id,
    name: row.name,
    teacher: row.teacher,
    aliases: parseStringArray(row.aliases_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(review ? { review } : {}),
  };
}

function mapCourseCandidateReview(row: CourseCandidateReviewRow): CourseCandidateReview {
  return {
    teachingClarity: row.teaching_clarity,
    contentValue: row.content_value,
    grading: row.grading,
    workload: row.workload,
    predictability: row.predictability,
    overall: row.overall,
    confidence: row.confidence,
    summary: row.summary,
    positives: parseStringArray(row.positives_json),
    negatives: parseStringArray(row.negatives_json),
    relatedPids: parseStringArray(row.related_pids_json),
    reviewedAt: row.reviewed_at,
  };
}

function mapJob(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    ...(row.message ? { message: row.message } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.requires_action ? { requiresAction: row.requires_action } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignmentApproval(row: AssignmentApprovalRow): AssignmentApproval {
  return {
    approvalId: row.approval_id,
    courseId: row.course_id,
    assignmentRemoteId: row.assignment_remote_id,
    filePath: row.file_path,
    sha256: row.sha256,
    expiresAt: row.expires_at,
  };
}

function mapRemoteResource(row: RemoteResourceRow): RemoteResourceRef {
  return {
    resourceId: row.resource_id,
    courseId: row.course_id,
    provider: row.provider,
    remoteCourseId: row.remote_course_id,
    remoteResourceId: row.remote_resource_id,
    kind: row.kind,
    title: row.title,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    hasDetails: Boolean(row.has_details),
    isImported: Boolean(row.is_imported),
    ...(row.local_path ? { localPath: row.local_path } : {}),
    updatedAt: row.updated_at,
  };
}

function mapIntegrationState(row: IntegrationRow): IntegrationState {
  return {
    provider: row.provider,
    authState: row.auth_state,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.version ? { version: row.version } : {}),
    updatedAt: row.updated_at,
  };
}

function mapTeachingItem(row: TeachingItemRow): TeachingItem {
  return {
    itemId: row.item_id,
    courseId: row.course_id,
    provider: row.provider,
    remoteId: row.remote_id,
    remoteIdStable: Boolean(row.remote_id_stable),
    kind: row.kind,
    title: row.title,
    courseLabel: row.course_label,
    ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
    ...(row.occurred_text ? { occurredText: row.occurred_text } : {}),
    ...(row.due_at ? { dueAt: row.due_at } : {}),
    ...(row.due_text ? { dueText: row.due_text } : {}),
    ...(row.completed === null ? {} : { completed: Boolean(row.completed) }),
    ...(row.score === null ? {} : { score: row.score }),
    ...(row.possible_score === null ? {} : { possibleScore: row.possible_score }),
    ...(row.attachment_count === null ? {} : { attachmentCount: row.attachment_count }),
    updatedAt: row.updated_at,
  };
}

function mapDocumentBlock(row: DocumentBlockRow): CourseDocumentBlock {
  return {
    blockId: row.block_id,
    courseId: row.course_id,
    sourcePath: row.source_path,
    title: row.title,
    ...(row.page === null ? {} : { page: row.page }),
    contentType: row.content_type,
    text: row.text,
    updatedAt: row.updated_at,
  };
}

function teachingItemParams(item: TeachingItem): Record<string, unknown> {
  return {
    ...item,
    remoteIdStable: item.remoteIdStable ? 1 : 0,
    occurredAt: item.occurredAt ?? null,
    occurredText: item.occurredText ?? null,
    dueAt: item.dueAt ?? null,
    dueText: item.dueText ?? null,
    completed: item.completed === undefined ? null : item.completed ? 1 : 0,
    score: item.score ?? null,
    possibleScore: item.possibleScore ?? null,
    attachmentCount: item.attachmentCount ?? null,
  };
}

function jobParams(job: JobRecord): Record<string, unknown> {
  return {
    ...job,
    message: job.message ?? null,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    requiresAction: job.requiresAction ?? null,
  };
}

function approvalParams(approval: AssignmentApproval): Record<string, unknown> {
  return { ...approval };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
