import { createHash } from "node:crypto";
import type { RemoteResourceKind, RemoteResourceRef } from "../../domain/types.js";

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function parsePku3bVersion(output: string): string | undefined {
  return /(?:pku3b\s+)?(\d+\.\d+\.\d+)/i.exec(stripAnsi(output))?.[1];
}

export function isSupportedPku3bVersion(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major === 0 && minor === 16;
}

export interface ParsedCourseContent {
  courseTitle: string;
  resource: RemoteResourceRef;
  attachmentCount: number;
}

export function parseCourseContentList(output: string, courseId: string): ParsedCourseContent[] {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const resources: ParsedCourseContent[] = [];
  let courseTitle = "";

  for (const line of lines) {
    if (!line.startsWith("•")) {
      courseTitle = line;
      continue;
    }

    const match = /^•\s+\(([^)]+)\)\s+(.+?)\s+(?:\[(\d+)\s+附件\]\s+)?([^\s:]+:[^\s]+)$/.exec(
      line,
    );
    if (!match) throw new Error(`Unsupported pku3b course-content line: ${line}`);
    const [, rawKind, title, rawAttachmentCount, ccid] = match;
    if (!rawKind || !title || !ccid) throw new Error(`Incomplete pku3b content line: ${line}`);
    const remoteCourseId = ccid.split(":", 1)[0];
    if (!remoteCourseId) throw new Error(`Missing remote course ID in: ${ccid}`);
    const updatedAt = new Date().toISOString();
    resources.push({
      courseTitle,
      attachmentCount: Number(rawAttachmentCount ?? 0),
      resource: {
        resourceId: stableResourceId("pku3b", ccid),
        courseId,
        provider: "pku3b",
        remoteCourseId,
        remoteResourceId: ccid,
        kind: mapKind(rawKind),
        title,
        hasDetails: true,
        isImported: false,
        updatedAt,
      },
    });
  }

  return resources;
}

export function stableResourceId(provider: string, remoteId: string): string {
  return createHash("sha256").update(`${provider}\0${remoteId}`).digest("hex").slice(0, 32);
}

function mapKind(kind: string): RemoteResourceKind {
  const normalized = kind.toLowerCase();
  const known: Record<string, RemoteResourceKind> = {
    document: "document",
    file: "file",
    assignment: "assignment",
    announcement: "announcement",
    audio: "audio",
    folder: "folder",
    quiz: "quiz",
  };
  return known[normalized] ?? "unknown";
}
