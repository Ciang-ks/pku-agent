import type { Lesson } from "./types.js";

export function isLessonDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
}

function calendarDate(value?: string): string | undefined {
  const match = value?.match(/(?:^|[^\d])(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日|(?=[^\d]|$))/);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  return isLessonDate(date) ? date : undefined;
}

/** Prefer the recording's displayed local date; never substitute upload/sync time. */
export function recordingLessonDate(recording: { occurredAt?: string; occurredText?: string }): string | undefined {
  const displayed = calendarDate(recording.occurredText);
  if (displayed) return displayed;
  const timestamp = recording.occurredAt;
  if (!timestamp || !calendarDate(timestamp)) return undefined;
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return calendarDate(timestamp);
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function compareLessons(a: Pick<Lesson, "date" | "title" | "lessonId">, b: Pick<Lesson, "date" | "title" | "lessonId">): number {
  const aDated = isLessonDate(a.date), bDated = isLessonDate(b.date);
  if (aDated !== bDated) return aDated ? -1 : 1;
  return (aDated ? a.date.localeCompare(b.date) : 0)
    || a.title.localeCompare(b.title, "zh", { numeric: true }) || a.lessonId.localeCompare(b.lessonId);
}
