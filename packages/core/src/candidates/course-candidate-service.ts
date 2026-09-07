import { randomUUID } from "node:crypto";
import {
  createCourseCandidateSchema,
  candidateReviewSchema,
} from "../domain/schemas.js";
import type {
  CandidateStatus,
  CourseCandidate,
  CourseCandidateReview,
  CreateCourseCandidateInput,
  TreeholeEvidence,
} from "../domain/types.js";
import type { TreeholeProvider } from "../integrations/treehole/treehole-provider.js";
import { SqliteStore } from "../storage/sqlite-store.js";

export interface CandidateReviewInput extends Omit<CourseCandidateReview, "reviewedAt"> {}

export interface CandidateEvidenceResult {
  candidate: CourseCandidate;
  evidence: TreeholeEvidence;
}

/**
 * Persists candidate metadata and curated conclusions only. Treehole post text
 * stays in the request result and is intentionally never handed to SqliteStore.
 */
export class CourseCandidateService {
  constructor(
    private readonly store: SqliteStore,
    private readonly treehole: TreeholeProvider,
  ) {}

  list(): CourseCandidate[] {
    return this.store.listCourseCandidates();
  }

  get(candidateId: string): CourseCandidate | undefined {
    return this.store.getCourseCandidate(candidateId);
  }

  create(rawInput: CreateCourseCandidateInput): CourseCandidate {
    const input = createCourseCandidateSchema.parse(rawInput);
    const now = new Date().toISOString();
    const candidate: Omit<CourseCandidate, "review"> = {
      candidateId: randomUUID(),
      name: input.name,
      teacher: input.teacher,
      aliases: uniqueKeywords(input.aliases),
      status: "followed",
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertCourseCandidate(candidate);
    return candidate;
  }

  updateStatus(candidateId: string, status: CandidateStatus): CourseCandidate {
    this.requireCandidate(candidateId);
    this.store.updateCourseCandidateStatus(candidateId, status);
    return this.requireCandidate(candidateId);
  }

  async collectEvidence(candidateId: string, requestedKeywords?: string[]): Promise<CandidateEvidenceResult> {
    const candidate = this.requireCandidate(candidateId);
    const keywords = uniqueKeywords([
      `${candidate.name} ${candidate.teacher}`,
      candidate.name,
      candidate.teacher,
      ...candidate.aliases,
      ...(requestedKeywords ?? []),
    ]).slice(0, 10);
    const evidence = await this.ask(candidate.name, keywords);
    return { candidate, evidence };
  }

  saveReview(candidateId: string, rawReview: CandidateReviewInput): CourseCandidate {
    this.requireCandidate(candidateId);
    const review = candidateReviewSchema.parse(rawReview);
    this.store.upsertCourseCandidateReview(candidateId, {
      ...review,
      relatedPids: uniqueKeywords(review.relatedPids),
      reviewedAt: new Date().toISOString(),
    });
    return this.requireCandidate(candidateId);
  }

  async ask(query: string, requestedKeywords?: string[]): Promise<TreeholeEvidence> {
    const keywords = uniqueKeywords(requestedKeywords?.length ? requestedKeywords : [query]).slice(0, 10);
    const byPid = new Map<string, TreeholeEvidence["posts"][number]>();
    for (const keyword of keywords) {
      const result = await this.treehole.searchPosts({ keyword, limit: 20, commentLimit: 10 });
      if (!result.ok) {
        throw new CourseCandidateError(result.error.code, result.error.message, result.error.retryable ? 503 : 400);
      }
      for (const post of result.data.posts) {
        const existing = byPid.get(post.pid);
        if (!existing || post.comments.length > existing.comments.length) byPid.set(post.pid, post);
      }
    }
    return { query, keywords, posts: [...byPid.values()] };
  }

  private requireCandidate(candidateId: string): CourseCandidate {
    const candidate = this.store.getCourseCandidate(candidateId);
    if (!candidate) throw new CourseCandidateError("CANDIDATE_NOT_FOUND", "Course candidate not found.", 404);
    return candidate;
  }
}

export class CourseCandidateError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

function uniqueKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const keyword = value.trim();
    const key = keyword.toLocaleLowerCase();
    if (keyword && !seen.has(key)) {
      seen.add(key);
      normalized.push(keyword);
    }
  }
  return normalized;
}
