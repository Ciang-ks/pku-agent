import { z } from "zod";
import { materialRoles } from "./types.js";
const path = z.string().trim().min(1).max(1000);
export const createLessonSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.iso.date().optional(),
  recordingIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  recordingAssetIds: z.array(z.uuid()).max(20).optional(),
  transcriptPaths: z.array(path).max(20).optional(),
}).strict();
export const outlineSchema = z.object({
  basis: z.enum(["recording", "materials", "manual"]),
  topics: z.array(z.object({
    topicId: z.string().min(1).max(100), title: z.string().trim().min(1).max(200),
    summary: z.string().max(5000),
    startSeconds: z.number().nonnegative().optional(),
    endSeconds: z.number().nonnegative().optional(),
  }).strict().refine(t => (t.startSeconds === undefined && t.endSeconds === undefined) ||
    (t.startSeconds !== undefined && t.endSeconds !== undefined && t.endSeconds > t.startSeconds), "Invalid time range"))
    .min(1).max(100),
}).strict().refine(o => new Set(o.topics.map(t => t.topicId)).size === o.topics.length, "Topic IDs must be unique");
export const selectionsSchema = z.array(z.object({
  topicId: z.string().min(1).max(100), sourcePath: path,
  blockIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
}).strict()).max(300);
export const revisionSchema = z.number().int().nonnegative();
export const saveOutlineSchema = z.object({ revision: revisionSchema, outline: outlineSchema }).strict();
export const saveSelectionsSchema = z.object({ revision: revisionSchema, selections: selectionsSchema }).strict();
export const saveLearningDocumentSchema = z.object({
  revision: revisionSchema, markdown: z.string().trim().min(1).max(1_000_000),
}).strict();
export const classifyMaterialSchema = z.object({ role: z.enum(materialRoles) }).strict();

export const lessonInputsSchema = z.object({
  revision: revisionSchema,
  materialRefs: z.array(z.object({ assetId: z.uuid(), blockIds: z.array(z.string().min(1).max(100)).max(300) }).strict()).max(100),
  autoPublic: z.boolean(), focus: z.string().max(2000),
  excludedBlockIds: z.array(z.string().min(1).max(100)).max(1000).default([]),
}).strict();
export const lessonSessionSchema = z.object({
  contextId: z.string().min(1).max(100),
  assetIds: z.array(z.uuid()).max(20).default([]),
}).strict();
