import { ResumeFormatError, type Bullet, type ResumeDoc } from './resume-doc';

type Job = ResumeDoc['experience'][number];
type SkillRow = ResumeDoc['skills'][number];
type EducationEntry = ResumeDoc['education'][number];

// The old format has no bullet priorities, so every bullet gets the middle one.
const LEGACY_BULLET_PRIORITY: Bullet['priority'] = 2;

// The summary is the paragraph between the contact lines and "## Skills".
const SUMMARY_AFTER_GITHUB = /\*\*GitHub:\*\*[^\n]*\n\n([\s\S]*?)(?=\n## Skills)/;
const SUMMARY_AFTER_CONTACT =
  /\*\*(?:Email|Phone|LinkedIn|GitHub):\*\*[^\n]*\n(?:\*\*(?:Email|Phone|LinkedIn|GitHub):\*\*[^\n]*\n)*\n([\s\S]*?)(?=\n## Skills)/;

// Reads the markdown reply of the old chat prompts: an optional "# CHAT TITLE", then a
// "## TAILORED RESUME" section with the name, contact lines, summary, Skills, Experience
// and Education. The format has no projects, keywords or base-resume id.
export function parseLegacyMarkdown(text: string, fallbackTitle: string | null): ResumeDoc {
  const resume = extractResumeSection(text);
  return {
    version: 1,
    // An empty chat title is no title, so this falls back with `||` rather than `??`.
    target: targetFromTitle(extractChatTitle(text) || fallbackTitle),
    // The old format does not say which base resume the reply started from.
    base: 'mix',
    name: parseName(resume),
    contact: parseContact(resume),
    summary: parseSummary(resume),
    skills: parseSkills(resume),
    experience: parseExperience(resume),
    education: parseEducation(resume),
    keywords: [],
  };
}

// The bold line under "# CHAT TITLE", without the "Resume Analysis" suffix the old prompts added.
function extractChatTitle(input: string): string | null {
  const match = input.match(/^#\s*CHAT TITLE\s*\n\*\*(.+?)\*\*/m);
  if (!match) return null;
  return match[1]
    .replace(/\s*[-–—]\s*Resume Analysis\s*$/i, '')
    .replace(/\s*Resume Analysis\s*$/i, '')
    .trim();
}

function extractResumeSection(input: string): string {
  // Everything after "## TAILORED RESUME", minus a trailing CHANGELOG and the --- before it.
  const match = input.match(/#{1,6}\s+TAILORED RESUME\s*\n([\s\S]+)/);
  if (match) {
    return match[1]
      .replace(/\n-{3,}\s*\n#{1,6}\s+CHANGELOG[\s\S]*$/i, '')
      .replace(/\n#{1,6}\s+CHANGELOG[\s\S]*$/i, '')
      .replace(/\n-{3,}\s*$/, '')
      .trim();
  }
  const looksLikeResume = /^# .+\n/.test(input.trim()) && /## Experience/.test(input);
  if (looksLikeResume) return input.trim();
  throw new ResumeFormatError('missing', 'Could not find "## TAILORED RESUME" section in input.');
}

function targetFromTitle(title: string | null): ResumeDoc['target'] {
  const [company, role] = splitAtDash(title ?? '');
  return { company, role };
}

// Splits at the first dash that has whitespace on both sides, so "Coca-Cola - Analyst" keeps
// "Coca-Cola" whole. Without such a dash the second part is empty.
function splitAtDash(text: string): [string, string] {
  const match = text.match(/^(.*?)\s+[-–—]+\s+(.*)$/);
  return match ? [match[1], match[2]] : [text, ''];
}

function parseName(resume: string): string {
  const match = resume.match(/^# (.+)$/m);
  if (!match) {
    throw new ResumeFormatError('invalid', 'Could not parse name from resume (expected "# Name").');
  }
  return match[1].trim();
}

function parseContact(resume: string): ResumeDoc['contact'] {
  const contact: ResumeDoc['contact'] = {
    email: contactField(resume, 'Email'),
    phone: contactField(resume, 'Phone'),
  };
  const linkedin = contactField(resume, 'LinkedIn');
  const github = contactField(resume, 'GitHub');
  if (linkedin) contact.linkedin = linkedin;
  if (github) contact.github = github;
  return contact;
}

function contactField(resume: string, label: string): string {
  const match = resume.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
  return match ? match[1].trim() : '';
}

function parseSummary(resume: string): string {
  const match = resume.match(SUMMARY_AFTER_GITHUB) ?? resume.match(SUMMARY_AFTER_CONTACT);
  return match ? match[1].trim() : '';
}

function parseSkills(resume: string): SkillRow[] {
  const block = resume.match(/## Skills\s*\n([\s\S]*?)(?=\n## Experience)/);
  if (!block) return [];
  return compact(block[1].split('\n').map(parseSkillRow));
}

function parseSkillRow(line: string): SkillRow | null {
  const match = line.match(/\*\*(.+?):\*\*\s*(.+)/);
  return match ? { category: match[1].trim(), items: splitItems(match[2]) } : null;
}

// Splits on commas outside parentheses, so "Vector DBs (FAISS, Pinecone)" stays one item.
function splitItems(items: string): string[] {
  return items
    .split(/,(?![^()]*\))/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parseExperience(resume: string): Job[] {
  const block = resume.match(/## Experience\s*\n([\s\S]*?)(?=\n## Education)/);
  if (!block) throw new ResumeFormatError('invalid', 'Could not find Experience section.');
  return compact(block[1].trim().split(/(?=^\*\*[^*]+\*\*\s*\|)/m).map(parseJob));
}

// A job is a "**Title** | Company -- Location" line, a date line, then "- " bullets.
function parseJob(chunk: string): Job | null {
  const [heading = '', dateLine = '', ...rest] = chunk.trim().split('\n');
  const match = heading.match(/\*\*(.+?)\*\*\s*\|\s*(.+)/);
  if (!match) return null;
  const [company, location] = splitCompanyAndLocation(match[2].trim());
  const [start, end] = splitAtDash(dateLine.trim());
  const job: Job = { title: match[1].trim(), company, start, end, bullets: parseBullets(rest) };
  return location ? { ...job, location } : job;
}

function splitCompanyAndLocation(text: string): [string, string] {
  const match = text.match(/^(.+?)\s*--\s*(.+)$/);
  return match ? [match[1].trim(), match[2].trim()] : [text, ''];
}

function parseBullets(lines: string[]): Bullet[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line): Bullet => ({ text: line.slice(2).trim(), priority: LEGACY_BULLET_PRIORITY }));
}

function parseEducation(resume: string): EducationEntry[] {
  const block = resume.match(/## Education\s*\n([\s\S]*?)$/);
  if (!block) return [];
  return compact(block[1].trim().split(/(?=^\*\*)/m).map(parseSchool));
}

// A school is a bold name line, then the date line, then the degree line.
function parseSchool(chunk: string): EducationEntry | null {
  const [heading = '', date = '', degree = ''] = chunk
    .trim()
    .split('\n')
    .filter((line) => line.trim());
  const match = heading.match(/\*\*(.+?)\*\*/);
  return match ? { school: match[1].trim(), degree: degree.trim(), date: date.trim() } : null;
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}
