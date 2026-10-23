import type { SourceDocument } from '../my-files/store';
import type { Profile } from '../profile';
import INSTRUCTIONS from './resume-writer.md' with { type: 'text' };

// The most characters of extra instructions the writer takes; the setup page's box holds the same.
export const MAX_WRITER_NOTES = 2000;

export interface WriterJob {
  text: string;
  url: string;
  title: string;
}

export interface WriterRequest {
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
}

export type Schema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Schema. Only keywords every JSON Schema consumer understands: type, properties, required,
// items, enum, additionalProperties, minItems, description (short guidance for the model).
// The builders are shared with the scorer's schema.
// ---------------------------------------------------------------------------

const PRIORITIES = [1, 2, 3];

export function text(description: string): Schema {
  return { type: 'string', description };
}

export function object(description: string, properties: Record<string, Schema>, required: string[]): Schema {
  return { type: 'object', description, properties, required, additionalProperties: false };
}

export function list(description: string, items: Schema, minItems?: number): Schema {
  return { type: 'array', description, items, ...(minItems !== undefined && { minItems }) };
}

export function stringList(description: string, minItems?: number): Schema {
  return list(description, { type: 'string' }, minItems);
}

function bulletSchema(): Schema {
  return object(
    'One achievement.',
    {
      text: text('Verb first; what was done, how, and the result. At most 30 words on a one-page budget.'),
      priority: {
        type: 'integer',
        enum: [...PRIORITIES],
        description: '1 = must keep, 2 = strong support, 3 = cut first when the page is full.',
      },
    },
    ['text', 'priority'],
  );
}

function jobSchema(): Schema {
  return object(
    'One role, titled and dated exactly as the documents state it.',
    {
      title: text('Job title as in the documents.'),
      company: text('Employer as in the documents.'),
      location: text('Location as in the documents; omit if they give none.'),
      start: text('Start date as the documents give it, e.g. "Jan 2023" or "2019".'),
      end: text('End date as the documents give it, e.g. "May 2024" or "2021", or "Present".'),
      bullets: list('Bullets in display order, most relevant first.', bulletSchema(), 1),
    },
    ['title', 'company', 'start', 'end', 'bullets'],
  );
}

function projectSchema(): Schema {
  return object(
    'A personal or open-source project.',
    {
      name: text('Project name.'),
      link: text('URL or repo path; omit if none.'),
      bullets: list('Bullets in display order.', bulletSchema(), 1),
    },
    ['name', 'bullets'],
  );
}

function educationSchema(): Schema {
  return object(
    'One degree, copied from the documents.',
    {
      school: text('Institution, exactly as in the documents.'),
      degree: text('Degree and field, exactly as in the documents.'),
      date: text('Graduation date, exactly as in the documents.'),
    },
    ['school', 'degree', 'date'],
  );
}

export function resumeJsonSchema(documentNames: string[]): Schema {
  return object(
    'A tailored resume.',
    {
      version: { type: 'integer', enum: [1], description: 'Always 1.' },
      target: object(
        'The posting this resume targets; used only to name the output.',
        { company: text('Employer named in the posting.'), role: text('Title as posted.') },
        ['company', 'role'],
      ),
      base: {
        type: 'string',
        enum: [...documentNames],
        description: 'Name of the document you started from: the closest resume, else the most complete document.',
      },
      name: text('Full name, exactly as in the document named in base.'),
      contact: object(
        'Contact block: each detail as in the most recently modified resume that gives it, or the documents if none is a resume.',
        {
          email: text('Email address.'),
          phone: text('Phone number as written there.'),
          linkedin: text('LinkedIn URL or path; omit if none gives one.'),
          github: text('GitHub URL or path; omit if none gives one.'),
          location: text('City and region; omit if none gives one.'),
        },
        ['email', 'phone'],
      ),
      summary: text('Two or three sentences written for this posting; at most 45 words on a one-page budget.'),
      skills: list(
        'Skill rows, most relevant to the posting first.',
        object(
          'One row of the skills section.',
          {
            category: text('Short row label, e.g. "Languages".'),
            items: stringList('Skills in this row, most relevant first.', 1),
          },
          ['category', 'items'],
        ),
        1,
      ),
      experience: list(
        "Roles, newest first: the starting resume's plus any newer role the documents show; with no resume, the documents' roles.",
        jobSchema(),
        1,
      ),
      projects: list(
        'Omit unless the starting resume has projects or one clearly strengthens the match.',
        projectSchema(),
      ),
      education: list('Degrees, copied from the starting resume or the documents.', educationSchema()),
      keywords: stringList('Posting terms that appear verbatim in the resume text.'),
    },
    ['version', 'target', 'base', 'name', 'contact', 'summary', 'skills', 'experience', 'education', 'keywords'],
  );
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ATTRIBUTE_ESCAPES[char]);
}

export function tagged(name: string, body: string, attributes: Record<string, string> = {}): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');
  return `<${name}${attrs}>\n${body.trim()}\n</${name}>`;
}

// The modified date lets the model settle documents that disagree: the newest wins.
export function documentBlocks(documents: SourceDocument[]): string[] {
  return documents.map((source) => tagged('document', source.text, { name: source.name, modified: source.modified }));
}

// The person's own extra instructions, after everything else, or nothing when they left the box empty.
function extraInstructionBlocks(writerNotes: string | undefined): string[] {
  return writerNotes === undefined || writerNotes.trim() === '' ? [] : [tagged('extra_instructions', writerNotes)];
}

// The terms a screen will look for in this posting (the scorer's ats_keywords), or nothing when there are none.
function screeningTermBlocks(screeningTerms: string[] | undefined): string[] {
  return screeningTerms === undefined || screeningTerms.length === 0
    ? []
    : [tagged('screening_terms', screeningTerms.join('\n'))];
}

// Static content (instructions, documents, extra instructions) goes in the system prompt so repeated runs share
// the prompt cache; the job and its screening terms, which change every run, go in the user message. The built-in
// instructions always come first; the extra instructions are added after the documents and never replace them.
export function buildWriterRequest(p: {
  profile: Profile;
  job: WriterJob;
  maxPages: number;
  writerNotes?: string;
  screeningTerms?: string[];
}): WriterRequest {
  const { profile, job, maxPages, writerNotes, screeningTerms } = p;
  const jobBlock = tagged('job', job.text, { url: job.url, title: job.title });

  return {
    systemPrompt: [
      INSTRUCTIONS.trim(),
      ...documentBlocks(profile.documents),
      ...extraInstructionBlocks(writerNotes),
    ].join('\n\n'),
    userMessage: [jobBlock, ...screeningTermBlocks(screeningTerms), `Page budget: ${maxPages} page(s).`].join('\n\n'),
    schema: resumeJsonSchema(profile.documents.map((source) => source.name)),
  };
}
