import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { JobRecord, JobStatus } from "../domain/types.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

const allowedTransitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set([
    "waiting_for_auth",
    "waiting_for_review",
    "completed",
    "failed",
    "cancelled",
  ]),
  waiting_for_auth: new Set(["running", "failed", "cancelled"]),
  waiting_for_review: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export interface JobUpdate {
  status?: JobStatus;
  progress?: number;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
  requiresAction?: string;
}

const clearableFields = [
  "message",
  "errorCode",
  "errorMessage",
  "requiresAction",
] as const satisfies readonly (keyof JobUpdate)[];

export class JobManager extends EventEmitter {
  constructor(private readonly store: SqliteStore) {
    super();
  }

  create(kind: string, message?: string): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      jobId: randomUUID(),
      kind,
      status: "queued",
      progress: 0,
      ...(message ? { message } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertJob(job);
    this.emit("job", job);
    return job;
  }

  get(jobId: string): JobRecord | undefined {
    return this.store.getJob(jobId);
  }

  listActive(): JobRecord[] {
    return this.store.listActiveJobs();
  }

  update(jobId: string, update: JobUpdate): JobRecord {
    const current = this.store.getJob(jobId);
    if (!current) throw new Error(`Job not found: ${jobId}`);

    if (update.status && update.status !== current.status) {
      if (!allowedTransitions[current.status].has(update.status)) {
        throw new Error(`Invalid job transition: ${current.status} -> ${update.status}`);
      }
    }

    const progress = update.progress ?? current.progress;
    if (progress < 0 || progress > 1) throw new Error("Job progress must be between 0 and 1");

    const job: JobRecord = {
      ...current,
      ...(update.status ? { status: update.status } : {}),
      progress,
      updatedAt: new Date().toISOString(),
    };
    for (const field of clearableFields) {
      if (!(field in update)) continue;
      const value = update[field];
      if (value) job[field] = value;
      else delete job[field];
    }
    this.store.updateJob(job);
    this.emit("job", job);
    return job;
  }
}
