import {
  asRecord,
  isRecord,
  type JsonObject,
  omitNullOptionals,
  optionalString,
  requireString,
  requireStringArray,
  requireText,
} from './json-validation';

export type Bullet = {
  text: string;
  priority: 1 | 2 | 3; // 1 = must keep, 3 = cut first
};

export interface ResumeDoc {
  version: 1;
  target: { company: string; role: string };
  base: string; // name of the document in My files the resume started from
  name: string;
  contact: { email: string; phone: string; linkedin?: string; github?: string; location?: string };
  summary: string;
  skills: { category: string; items: string[] }[];
  experience: {
    title: string;
    company: string;
    location?: string;
    start: string;
    end: string; // "Jan 2023", "Present"
    bullets: Bullet[];
  }[];
  projects?: { name: string; link?: string; bullets: Bullet[] }[];
  education: { school: string; degree: string; date: string }[];
  keywords: string[]; // JD terms Claude worked in truthfully
}

// missing: no resume JSON in the reply. cut-off: the reply ended inside a json fence.
// invalid: a resume JSON block was found but is not valid JSON or fails validation.
type FormatErrorKind = 'missing' | 'cut-off' | 'invalid';

export class ResumeFormatError extends Error {
  readonly kind: FormatErrorKind;
  readonly problems: string[];

  constructor(kind: FormatErrorKind, message: string, problems: string[] = [message]) {
    super(message);
    this.name = 'ResumeFormatError';
    this.kind = kind;
    this.problems = problems;
  }
}

type FencedBlock = { label: string; body: string };

// Captures each fence's label and pairs fences in order, so a ```latex block cannot swallow
// the opener of the json block that follows it.
const FENCED_BLOCK = /```([^\n`]*)\n([\s\S]*?)```/g;
// A ```json opener that ends its line; prose mentioning a ```json fence mid-line does not match.
const JSON_FENCE_OPENER = /```json[ \t]*(?:\r?\n|$)/gi;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractResumeDoc(responseText: string): ResumeDoc {
  // A reply cut off inside a json fence must never fall back to an earlier, stale block.
  if (endsInsideJsonFence(responseText)) {
    throw new ResumeFormatError(
      'cut-off',
      'The resume JSON was cut off: the reply ended before the closing ``` fence',
    );
  }

  // The last block is Claude's final answer, so scan from the end and skip drafts.
  const candidates = fencedBlocks(responseText).filter(isCandidate).reverse();
  let latestFailure: ResumeFormatError | undefined;

  for (const block of candidates) {
    try {
      const doc = readResumeBlock(block);
      if (doc) return doc;
    } catch (error) {
      if (!(error instanceof ResumeFormatError)) throw error;
      latestFailure ??= error;
    }
  }

  if (latestFailure) throw latestFailure;
  throw new ResumeFormatError('missing', 'No resume JSON found: expected a fenced json block with "version": 1');
}

function fencedBlocks(text: string): FencedBlock[] {
  return [...text.matchAll(FENCED_BLOCK)].map(([, label, body]) => ({
    label: label.trim().toLowerCase(),
    body,
  }));
}

// Only unlabeled and json fences can hold the resume; other labels are code samples or other content.
function isCandidate({ label }: FencedBlock): boolean {
  return label === '' || label === 'json';
}

// Returns undefined for content that is not a version 1 resume, so unrelated blocks are skipped.
function readResumeBlock(block: FencedBlock): ResumeDoc | undefined {
  const parsed = parseJson(block);
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  return validateResumeDoc(parsed);
}

function parseJson({ label, body }: FencedBlock): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // An unlabeled fence that is not JSON is just other content in the reply.
    if (label === '') return undefined;
    throw new ResumeFormatError('invalid', `The resume JSON block is not valid JSON (${error.message})`);
  }
}

function endsInsideJsonFence(text: string): boolean {
  const lastOpener = [...text.matchAll(JSON_FENCE_OPENER)].at(-1);
  return lastOpener !== undefined && !text.includes('```', lastOpener.index + lastOpener[0].length);
}

// ---------------------------------------------------------------------------
// Validation: the input is untrusted JSON, so every check starts from `unknown`.
// ---------------------------------------------------------------------------

// Returns a copy of the input in which optional keys given as null are dropped.
export function validateResumeDoc(value: unknown): ResumeDoc {
  const doc = withoutNullOptionals(value);
  const problems = findProblems(doc);
  if (problems.length > 0) {
    throw new ResumeFormatError('invalid', `Resume JSON failed validation: ${problems.join('; ')}`, problems);
  }
  // findProblems checked every field of ResumeDoc, so this assertion is sound.
  return doc as ResumeDoc;
}

// Claude sometimes writes "linkedin": null for an absent optional key, so null counts as absent.
// It works on a deep copy, so the caller's object is never changed.
function withoutNullOptionals(value: unknown): unknown {
  const doc = structuredClone(value);
  if (!isRecord(doc)) return doc;

  omitNullOptionals(doc, ['projects']);
  if (isRecord(doc.contact)) omitNullOptionals(doc.contact, ['linkedin', 'github', 'location']);
  for (const job of recordsIn(doc.experience)) omitNullOptionals(job, ['location']);
  for (const project of recordsIn(doc.projects)) omitNullOptionals(project, ['link']);
  return doc;
}

function recordsIn(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function findProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['resume must be an object'];

  const problems: string[] = [];
  if (value.version !== 1) problems.push('version must be 1');
  checkTarget(value.target, problems);
  // The profile decides which document names exist, so any non-empty name is accepted here.
  requireText(value.base, 'base', problems);
  requireText(value.name, 'name', problems);
  checkContact(value.contact, problems);
  requireText(value.summary, 'summary', problems);
  checkSkills(value.skills, problems);
  checkExperience(value.experience, problems);
  checkProjects(value.projects, problems);
  checkEducation(value.education, problems);
  requireStringArray(value.keywords, 'keywords', problems);
  return problems;
}

function checkTarget(raw: unknown, problems: string[]): void {
  const target = asRecord(raw);
  requireText(target.company, 'target.company', problems);
  requireText(target.role, 'target.role', problems);
}

function checkContact(raw: unknown, problems: string[]): void {
  const contact = asRecord(raw);
  requireText(contact.email, 'contact.email', problems);
  requireString(contact.phone, 'contact.phone', problems);
  optionalString(contact.linkedin, 'contact.linkedin', problems);
  optionalString(contact.github, 'contact.github', problems);
  optionalString(contact.location, 'contact.location', problems);
}

function checkSkills(raw: unknown, problems: string[]): void {
  eachEntry(requireNonEmptyArray(raw, 'skills', problems), 'skills', (row, path) => {
    requireString(row.category, `${path}.category`, problems);
    requireStringArray(row.items, `${path}.items`, problems);
  });
}

function checkExperience(raw: unknown, problems: string[]): void {
  eachEntry(requireNonEmptyArray(raw, 'experience', problems), 'experience', (job, path) => {
    requireText(job.title, `${path}.title`, problems);
    requireText(job.company, `${path}.company`, problems);
    optionalString(job.location, `${path}.location`, problems);
    requireText(job.start, `${path}.start`, problems);
    requireString(job.end, `${path}.end`, problems);
    const bulletsPath = `${path}.bullets`;
    checkBullets(requireNonEmptyArray(job.bullets, bulletsPath, problems), bulletsPath, problems);
  });
}

function checkProjects(raw: unknown, problems: string[]): void {
  if (raw === undefined) return;
  eachEntry(requireArray(raw, 'projects', problems), 'projects', (project, path) => {
    requireString(project.name, `${path}.name`, problems);
    optionalString(project.link, `${path}.link`, problems);
    const bulletsPath = `${path}.bullets`;
    checkBullets(requireArray(project.bullets, bulletsPath, problems), bulletsPath, problems);
  });
}

function checkEducation(raw: unknown, problems: string[]): void {
  eachEntry(requireArray(raw, 'education', problems), 'education', (entry, path) => {
    requireString(entry.school, `${path}.school`, problems);
    requireString(entry.degree, `${path}.degree`, problems);
    requireString(entry.date, `${path}.date`, problems);
  });
}

function checkBullets(bullets: unknown[], path: string, problems: string[]): void {
  eachEntry(bullets, path, (bullet, bulletPath) => {
    requireText(bullet.text, `${bulletPath}.text`, problems);
    if (!isPriority(bullet.priority)) problems.push(`${bulletPath}.priority must be 1, 2 or 3`);
  });
}

function eachEntry(
  items: unknown[],
  path: string,
  check: (entry: JsonObject, entryPath: string) => void,
): void {
  items.forEach((item, index) => check(asRecord(item), `${path}[${index}]`));
}

function requireArray(value: unknown, path: string, problems: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  problems.push(`${path} must be an array`);
  return [];
}

function requireNonEmptyArray(value: unknown, path: string, problems: string[]): unknown[] {
  if (Array.isArray(value) && value.length === 0) {
    problems.push(`${path} must not be empty`);
    return [];
  }
  return requireArray(value, path, problems);
}

function isPriority(value: unknown): value is Bullet['priority'] {
  return value === 1 || value === 2 || value === 3;
}

// ---------------------------------------------------------------------------
// Plain text for keyword scoring
// ---------------------------------------------------------------------------

export function resumePlainText(doc: ResumeDoc): string {
  const skills = doc.skills.map((row) => row.items.join(', '));
  const bullets = doc.experience.flatMap((job) => bulletTexts(job.bullets));
  const projectBullets = (doc.projects ?? []).flatMap((project) => bulletTexts(project.bullets));
  return [doc.summary, ...skills, ...bullets, ...projectBullets].join('\n');
}

function bulletTexts(bullets: Bullet[]): string[] {
  return bullets.map((bullet) => bullet.text);
}
