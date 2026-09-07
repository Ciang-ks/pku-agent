import type { TeachingItem, TeachingItemKind, TeachingNetworkAnnouncementDetail } from "../../domain/types.js";
import { stableResourceId, stripAnsi } from "./output.js";

interface ParseContext {
  courseId: string;
  syncedAt?: Date;
}

export function parseAnnouncementList(output: string, context: ParseContext): TeachingItem[] {
  const updatedAt = (context.syncedAt ?? new Date()).toISOString();
  return cleanLines(output).flatMap((line) => {
    // `announcement list` prefixes each row with a display index. Keep the
    // remote id as the final token because course and title may contain spaces.
    const match = /^\[\s*\d+\]\s+(.+?)\s+>\s+(.+?)(?:\s+\((\d+)\s+个附件\))?\s+(\S+)$/.exec(line);
    if (!match) return [];
    const [, courseLabel, title, rawAttachments, remoteId] = match;
    if (!courseLabel || !title || !remoteId) return [];
    return [
      baseItem(context.courseId, "announcement", remoteId, title, courseLabel, updatedAt, true, {
        ...(rawAttachments ? { attachmentCount: Number(rawAttachments) } : {}),
      }),
    ];
  });
}

export function parseAnnouncementDetail(
  output: string,
  context: { courseId: string; announcementId: string },
): TeachingNetworkAnnouncementDetail | undefined {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^>.+<$/.test(line) && line !== "公告详情");
  let courseLabel = "";
  let title = "";
  let publishedAt: string | undefined;
  let bodyStarted = false;
  let bodyComplete = false;
  const descriptions: string[] = [];
  const attachments: string[] = [];
  for (const line of lines) {
    if (!courseLabel) {
      const header = /^(.+?)\s+>\s+(.+)$/.exec(line);
      if (header?.[1] && header[2]) {
        courseLabel = header[1];
        title = header[2];
        continue;
      }
    }
    if (/^ID\s*[:：]/.test(line)) continue;
    const time = /^发布时间\s*[:：]\s*(.+)$/.exec(line);
    if (time?.[1]) {
      publishedAt = time[1];
      continue;
    }
    const attachment = /^\[附件\]\s*(.+)$/.exec(line);
    if (attachment?.[1]) {
      attachments.push(attachment[1]);
      bodyComplete = true;
      continue;
    }
    if (courseLabel && !bodyComplete) {
      bodyStarted = true;
      if (bodyStarted) descriptions.push(line);
    }
  }
  if (!courseLabel || !title) return undefined;
  return {
    courseId: context.courseId,
    announcementId: context.announcementId,
    courseLabel,
    title,
    ...(publishedAt ? { publishedAt } : {}),
    descriptions,
    attachments,
  };
}

export function parseAssignmentList(output: string, context: ParseContext): TeachingItem[] {
  const syncedAt = context.syncedAt ?? new Date();
  const updatedAt = syncedAt.toISOString();
  return cleanLines(output).flatMap((line) => {
    const match = /^(.+?)\s+>\s+(.+?)\s+\((.+)\)\s+(\S+)$/.exec(line);
    if (!match) return [];
    const [, courseLabel, title, dueText, remoteId] = match;
    if (!courseLabel || !title || !dueText || !remoteId) return [];
    const completed = /^已完成(?:\s*:|$)/.test(dueText);
    const dueAt = completed ? undefined : relativeDueAt(dueText, syncedAt);
    return [
      baseItem(context.courseId, "assignment", remoteId, title, courseLabel, updatedAt, true, {
        completed,
        dueText,
        ...(dueAt ? { dueAt } : {}),
      }),
    ];
  });
}

export function parseVideoList(output: string, context: ParseContext): TeachingItem[] {
  const updatedAt = (context.syncedAt ?? new Date()).toISOString();
  const items: TeachingItem[] = [];
  let courseLabel = "";
  for (const line of cleanLines(output)) {
    const course = /^\[(.+)]$/.exec(line);
    if (course?.[1]) {
      courseLabel = course[1];
      continue;
    }
    const video = /^•\s+(.+?)\s+\((.+)\)\s+(\S+)$/.exec(line);
    if (!video || !courseLabel || !video[1] || !video[2] || !video[3]) continue;
    const occurredAt = parsePkuDateTime(video[2]);
    items.push(
      baseItem(context.courseId, "video", video[3], video[1], courseLabel, updatedAt, true, {
        occurredText: video[2],
        ...(occurredAt ? { occurredAt } : {}),
      }),
    );
  }
  return items;
}

export function parseGrades(output: string, context: ParseContext): TeachingItem[] {
  const updatedAt = (context.syncedAt ?? new Date()).toISOString();
  const items: TeachingItem[] = [];
  let courseLabel = "";
  for (const line of cleanLines(output)) {
    if (line.startsWith("* ")) {
      const grade = /^\*\s+(.+?)\s+(-?\d+(?:\.\d+)?)(?:\s*\/\s*(-?\d+(?:\.\d+)?))?$/.exec(line);
      if (!grade || !courseLabel || !grade[1] || !grade[2]) continue;
      const remoteId = `column:${grade[1]}`;
      items.push(
        baseItem(context.courseId, "grade", remoteId, grade[1], courseLabel, updatedAt, false, {
          score: Number(grade[2]),
          ...(grade[3] ? { possibleScore: Number(grade[3]) } : {}),
        }),
      );
      continue;
    }
    if (!line.startsWith(">") && line !== "暂无成绩数据" && !/^成绩查询/.test(line)) {
      courseLabel = line;
    }
  }
  return items;
}

export function courseLabelMatches(label: string, localCourseName: string): boolean {
  return normalizeCourseLabel(label) === normalizeCourseLabel(localCourseName);
}

function cleanLines(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^>.+<$/.test(line));
}

function baseItem(
  courseId: string,
  kind: TeachingItemKind,
  remoteId: string,
  title: string,
  courseLabel: string,
  updatedAt: string,
  remoteIdStable: boolean,
  extra: Partial<TeachingItem>,
): TeachingItem {
  return {
    itemId: stableResourceId(`pku3b-${kind}`, `${courseId}\0${remoteId}`),
    courseId,
    provider: "pku3b",
    remoteId,
    remoteIdStable,
    kind,
    title,
    courseLabel,
    ...extra,
    updatedAt,
  };
}

function normalizeCourseLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s*[（(](?:20\d{2}|春|秋|Spring|Fall|Summer|Autumn).*?[）)]\s*$/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function relativeDueAt(text: string, anchor: Date): string | undefined {
  if (text === "due" || text === "无截止时间") return undefined;
  const match = /^in\s+(?:(\d+)d\s+)?(?:(\d+)h\s+)?(?:(\d+)m\s+)?(?:(\d+)s)?$/.exec(text);
  if (!match) return parsePkuDateTime(text);
  const [, days, hours, minutes, seconds] = match;
  const duration =
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000;
  return new Date(anchor.getTime() + duration).toISOString();
}

function parsePkuDateTime(value: string): string | undefined {
  const match = /(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})日?(?:\s+|星期.\s*)?(上午|下午)?\s*(\d{1,2}):(\d{2})/.exec(
    value,
  );
  if (!match) return undefined;
  const [, year, month, day, period, rawHour, minute] = match;
  if (!year || !month || !day || !rawHour || !minute) return undefined;
  let hour = Number(rawHour);
  if (period === "下午" && hour < 12) hour += 12;
  if (period === "上午" && hour === 12) hour = 0;
  const date = new Date(Number(year), Number(month) - 1, Number(day), hour, Number(minute));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
