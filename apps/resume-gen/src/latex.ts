import { readFileSync } from 'node:fs';
import type { Bullet, ResumeDoc } from './resume-doc';

type Job = ResumeDoc['experience'][number];
type Project = NonNullable<ResumeDoc['projects']>[number];
type Link = { url: string; text: string };

const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '$': '\\$',
  '#': '\\#',
  '_': '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '–': '--',
  '—': '--',
};

// The template's header separator box is the last line of the fixed preamble.
const PREAMBLE_END_MARKER = '\\sbox\\ANDbox';

// The hyperref option that sets the PDF's author, with whatever value the template holds.
const PDF_AUTHOR = /pdfauthor=\{[^}]*\}/;

// Indentation of the generated body, one step per nesting level of the template's own layout.
const I = '    ';
const II = I + I;
const III = II + I;

// One pass over the text: escaping one character at a time would escape the braces
// of \textbackslash{} and \textasciitilde{} a second time.
export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^–—]/g, (char) => LATEX_ESCAPES[char]);
}

// The template's existence is checked first (requireTemplate in config.ts).
export function readPreamble(templatePath: string): string {
  const lines = readFileSync(templatePath, 'utf-8').split('\n');
  const endIdx = lines.findIndex((line) => line.includes(PREAMBLE_END_MARKER));
  if (endIdx === -1) throw new Error('Cannot find preamble end marker in template');
  return lines.slice(0, endIdx + 1).join('\n');
}

export function renderResumeLatex(doc: ResumeDoc, preamble: string): string {
  const blocks = [
    header(doc),
    onecolentry(`${II}${escapeLatex(doc.summary)}`),
    skillsSection(doc.skills),
    experienceSection(doc.experience),
    projectsSection(doc.projects ?? []),
    educationSection(doc.education),
  ].filter((block) => block !== '');
  return `${withPdfAuthor(preamble, doc.name)}\n${blocks.join('\n\n')}\n\n\\end{document}`;
}

// The template ships with an empty author; the name on the resume fills it.
// A replacer function keeps "$" in a name from being read as a replacement pattern.
function withPdfAuthor(preamble: string, name: string): string {
  return preamble.replace(PDF_AUTHOR, () => `pdfauthor={${escapeLatex(name)}}`);
}

// The header lists email and phone on one line and LinkedIn and GitHub on the next, each when
// present; there is no location line. Four links on one line overflow the text width and strand a bar.
function header({ name, contact }: ResumeDoc): string {
  return [
    `${I}\\begin{header}`,
    `${II}\\fontsize{22pt}{22pt}\\selectfont`,
    `${II}\\textbf{${escapeLatex(name)}}`,
    '',
    `${II}\\vspace{6pt}`,
    '',
    `${II}\\normalsize`,
    contactLines(contact).join('\n\n'),
    `${I}\\end{header}`,
    '',
    `${I}\\vspace{0.3cm}`,
  ].join('\n');
}

// Each non-empty line's links, separated by bars; a blank line between lines starts a new one.
function contactLines({ email, phone, linkedin, github }: ResumeDoc['contact']): string[] {
  const reach: Link[] = [];
  if (email) reach.push({ url: `mailto:${email}`, text: email });
  if (phone) reach.push({ url: `tel:${telNumber(phone)}`, text: phone });
  const profiles: Link[] = [];
  if (linkedin) profiles.push({ url: withScheme(linkedin), text: linkedin });
  if (github) profiles.push({ url: withScheme(github), text: github });
  return [reach, profiles]
    .filter((links) => links.length > 0)
    .map((links) => links.map((link) => `${II}{${hyperlink(link)}}`).join(`\n${II}{|}\n`));
}

function telNumber(phone: string): string {
  return phone.replace(/[()]/g, '').replace(/\s/g, '-');
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// hyperref reads the link target verbatim, so only the visible text is escaped.
function hyperlink({ url, text }: Link): string {
  return `\\hrefWithoutArrow{${url}}{${escapeLatex(text)}}`;
}

function skillsSection(skills: ResumeDoc['skills']): string {
  const rows = skills.map(({ category, items }) =>
    onecolentry(`${II}\\textbf{${escapeLatex(category)}:} ${escapeLatex(items.join(', '))}`),
  );
  return section('Skills', rows, `${I}\\vspace{0.15cm}`);
}

function experienceSection(jobs: Job[]): string {
  const entries = jobs.map((job) =>
    withBullets(datedEntry(jobHeading(job), escapeLatex(dateRange(job))), job.bullets),
  );
  return section('Experience', entries, `${I}\\experienceSeparator`);
}

function jobHeading({ title, company, location }: Job): string {
  const where = location ? `${company} -- ${location}` : company;
  return `\\textbf{${escapeLatex(title)}} | ${escapeLatex(where)}`;
}

function dateRange({ start, end }: Job): string {
  return end ? `${start} -- ${end}` : start;
}

function projectsSection(projects: Project[]): string {
  const entries = projects.map((project) =>
    withBullets(onecolentry(`${II}${projectHeading(project)}`), project.bullets),
  );
  return section('Projects', entries, `${I}\\vspace{0.20cm}`);
}

function projectHeading({ name, link }: Project): string {
  const bold = `\\textbf{${escapeLatex(name)}}`;
  return link ? `${bold} | ${hyperlink({ url: withScheme(link), text: link })}` : bold;
}

function educationSection(education: ResumeDoc['education']): string {
  const entries = education.map(({ school, degree, date }) =>
    withDetail(
      datedEntry(`\\textbf{${escapeLatex(school)}}`, escapeLatex(date)),
      onecolentry(`${II}${escapeLatex(degree)}`),
    ),
  );
  return section('Education', entries, `${I}\\vspace{0.20cm}`);
}

// A section without entries prints no heading.
function section(title: string, entries: string[], separator: string): string {
  if (entries.length === 0) return '';
  return `${I}\\section{${title}}\n\n${entries.join(`\n\n${separator}\n\n`)}`;
}

function onecolentry(...lines: string[]): string {
  return [`${I}\\begin{onecolentry}`, ...lines, `${I}\\end{onecolentry}`].join('\n');
}

// The heading sits on the left and the date flush right, in the template's second column.
function datedEntry(heading: string, date: string): string {
  return [
    `${I}\\begin{twocolentry}{`,
    `${II}${date}`,
    `${I}}`,
    `${II}${heading}`,
    `${I}\\end{twocolentry}`,
  ].join('\n');
}

function withDetail(heading: string, detail: string): string {
  return `${heading}\n\n${I}\\vspace{0.10cm}\n${detail}`;
}

// An entry without bullets gets no list, since LaTeX rejects an empty itemize.
function withBullets(heading: string, bullets: Bullet[]): string {
  return bullets.length === 0 ? heading : withDetail(heading, highlights(bullets));
}

// \relax stops \item from reading a bullet that starts with "[" as its optional label.
function highlights(bullets: Bullet[]): string {
  return onecolentry(
    `${II}\\begin{highlights}`,
    ...bullets.map(({ text }) => `${III}\\item\\relax ${escapeLatex(text)}`),
    `${II}\\end{highlights}`,
  );
}
