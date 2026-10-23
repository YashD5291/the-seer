import type { ResumeDoc } from './resume-doc';

type Role = ResumeDoc['experience'][number];

// Each date as a month count (year * 12 + month, January = 0), so every written form compares as a number.
type RoleDates = { end: number; start: number };

type DatedRole = { role: Role; dates: RoleDates | undefined };

// After any real date, so a current role always sorts first.
const CURRENT_END = Number.MAX_SAFE_INTEGER;
// Before any real date, so a start that cannot be read only loses ties on the end date.
const UNREADABLE_START = Number.MIN_SAFE_INTEGER;
const CURRENT_WORDS = new Set(['present', 'current', 'now']);
const DECEMBER = 11;
const JANUARY = 0;

const MONTHS = new Map<string, number>([
  ['jan', 0], ['january', 0],
  ['feb', 1], ['february', 1],
  ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3],
  ['may', 4],
  ['jun', 5], ['june', 5],
  ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7],
  ['sep', 8], ['sept', 8], ['september', 8],
  ['oct', 9], ['october', 9],
  ['nov', 10], ['november', 10],
  ['dec', 11], ['december', 11],
]);

const MONTH_NAME_YEAR = /^([a-z]+)\.?\s+(\d{4})$/; // "Jan 2023", "Jan. 2023", "January 2023"
const MONTH_SLASH_YEAR = /^(\d{1,2})\/(\d{4})$/; // "01/2023"
const YEAR_ONLY = /^(\d{4})$/; // "2023"

// Roles newest first: a current role, then the latest end date, then the latest start date. Roles
// with equal dates keep their order. A role whose end date cannot be read keeps its place and the
// others are sorted around it; a start date that cannot be read only loses ties. Only the order
// changes; the input is never changed.
export function sortExperienceNewestFirst(doc: ResumeDoc): ResumeDoc {
  const dated: DatedRole[] = doc.experience.map((role) => ({ role, dates: roleDates(role) }));
  const sorted = dated.filter(hasDates).sort((a, b) => newerFirst(a.dates, b.dates));
  let next = 0;
  const experience = dated.map(({ role, dates }) => (dates === undefined ? role : sorted[next++].role));
  return { ...doc, experience };
}

function hasDates(entry: DatedRole): entry is { role: Role; dates: RoleDates } {
  return entry.dates !== undefined;
}

function newerFirst(a: RoleDates, b: RoleDates): number {
  return b.end - a.end || b.start - a.start;
}

function roleDates(role: Role): RoleDates | undefined {
  const end = endMonth(role.end);
  if (end === undefined) return undefined;
  return { end, start: monthCount(role.start, JANUARY) ?? UNREADABLE_START };
}

// A year-only end date stands for the end of that year.
function endMonth(text: string): number | undefined {
  if (CURRENT_WORDS.has(text.trim().toLowerCase())) return CURRENT_END;
  return monthCount(text, DECEMBER);
}

// `yearOnlyMonth` is the month a bare year stands for: December for an end date, January for a start date.
function monthCount(text: string, yearOnlyMonth: number): number | undefined {
  const value = text.trim().toLowerCase();
  const named = MONTH_NAME_YEAR.exec(value);
  if (named) return withMonth(named[2], MONTHS.get(named[1]));
  const slashed = MONTH_SLASH_YEAR.exec(value);
  if (slashed) return withMonth(slashed[2], monthIndex(Number(slashed[1])));
  const year = YEAR_ONLY.exec(value);
  return year ? withMonth(year[1], yearOnlyMonth) : undefined;
}

function monthIndex(month: number): number | undefined {
  return month >= 1 && month <= 12 ? month - 1 : undefined;
}

function withMonth(year: string, month: number | undefined): number | undefined {
  return month === undefined ? undefined : Number(year) * 12 + month;
}
