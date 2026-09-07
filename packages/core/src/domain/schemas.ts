import { z } from "zod";

export const createCourseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  teacher: z.string().trim().min(1).max(100),
  term: z.string().trim().min(1).max(50),
  remoteCourseId: z.string().trim().min(1).max(100).optional(),
});

export const createCourseCandidateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  teacher: z.string().trim().min(1).max(100),
  aliases: z.array(z.string().trim().min(1).max(100)).max(10).optional().default([]),
}).strict();

export const updateCourseCandidateSchema = z.object({
  status: z.enum(["followed", "rejected"]),
}).strict();

const candidateScore = z.number().int().min(1).max(5);
export const candidateReviewSchema = z.object({
  teachingClarity: candidateScore,
  contentValue: candidateScore,
  grading: candidateScore,
  workload: candidateScore,
  predictability: candidateScore,
  overall: candidateScore,
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().trim().min(1).max(4000),
  positives: z.array(z.string().trim().min(1).max(500)).max(20),
  negatives: z.array(z.string().trim().min(1).max(500)).max(20),
  relatedPids: z.array(z.string().trim().min(1).max(100)).max(100),
}).strict();

export const reviewCourseCandidateSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  review: candidateReviewSchema.optional(),
}).strict();

export const treeholeAskSchema = z.object({
  query: z.string().trim().min(1).max(500),
  keywords: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
}).strict();

export const treeholeLoginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
  verificationCode: z.string().trim().min(1).max(32).optional(),
}).strict();

export const courseIdSchema = z.uuid();

export const syncCourseContentSchema = z.object({
  force: z.boolean().optional().default(false),
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits").optional(),
});

export const resumeTeachingNetworkJobSchema = z.object({
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits"),
});

export const importRemoteResourceSchema = z.object({
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits").optional(),
});

export const transcribeRecordingSchema = z.object({
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits").optional(),
}).strict();

export const downloadAssignmentSchema = z.object({
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits").optional(),
}).strict();

export const showAnnouncementSchema = z.object({
  force: z.boolean().optional().default(false),
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits").optional(),
}).strict();

export const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  range: z.enum(["today", "week", "all"]).optional().default("week"),
}).strict();

export const approveAssignmentSchema = z.object({}).strict();

export const submitAssignmentSchema = z.object({
  approvalId: z.uuid(),
  otp: z.string().trim().regex(/^\d{4,12}$/, "OTP must contain 4-12 digits").optional(),
}).strict();

export const indexCourseAssetSchema = z.object({
  path: z.string().trim().min(1).max(1000),
});

export const searchCourseSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

export const rebuildCourseIndexSchema = z.object({}).strict();

export const sendAgentMessageSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
});

export const createAgentSessionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
}).strict();

export const createLectureNotesSessionSchema = z.object({
  sourcePaths: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
}).strict();
