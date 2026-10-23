import {
  isRecord,
  type JsonObject,
  omitNullOptionals,
  optionalString,
  requireStringArray,
  requireText,
} from '../json-validation';
import type { Profile } from '../profile';
import {
  documentBlocks,
  object,
  type Schema,
  stringList,
  tagged,
  text,
  type WriterJob,
  type WriterRequest,
} from '../writer/request';
import INSTRUCTIONS from './instructions.md' with { type: 'text' };

const COMPETITION = ['low', 'medium', 'high'] as const;
const RECOMMENDATIONS = ['strong_yes', 'yes', 'maybe', 'no'] as const;
const OPTIONAL_JOB_KEYS = ['location', 'salary_range', 'job_type'] as const;
const JOB_KEYS = ['title', 'company', ...OPTIONAL_JOB_KEYS, 'requirements', 'nice_to_haves'] as const;
const PHRASE_LISTS = [
  'key_matches',
  'gaps',
  'gap_mitigation',
  'tailoring_priorities',
  'ats_keywords',
  'red_flags',
] as const;
const TOP_LEVEL_KEYS = [
  'job',
  'fit_score',
  'confidence',
  'recommended_base',
  'base_reasoning',
  ...PHRASE_LISTS,
  'estimated_competition',
  'apply_recommendation',
] as const;
export const MAX_SCORE = 100;

export interface FitJob {
  title: string;
  company: string;
  location?: string;
  salary_range?: string;
  job_type?: string;
  requirements: string[];
  nice_to_haves: string[];
}

export interface FitResult {
  job: FitJob;
  fit_score: number; // whole number, 0 to 100
  confidence: number; // whole number, 0 to 100
  recommended_base: string; // name of a document in My files
  base_reasoning: string;
  key_matches: string[];
  gaps: string[];
  gap_mitigation: string[];
  tailoring_priorities: string[];
  ats_keywords: string[];
  red_flags: string[];
  estimated_competition: (typeof COMPETITION)[number];
  apply_recommendation: (typeof RECOMMENDATIONS)[number];
}

// What the extension shows as the score; the job facts travel next to it.
export type FitAnalysis = Omit<FitResult, 'job'>;

// missing: no fit score JSON in the reply. invalid: JSON was found but is not valid or fails validation.
type ScoreFormatErrorKind = 'missing' | 'invalid';

export class ScoreFormatError extends Error {
  readonly kind: ScoreFormatErrorKind;
  readonly problems: string[];

  constructor(kind: ScoreFormatErrorKind, message: string, problems: string[] = [message]) {
    super(message);
    this.name = 'ScoreFormatError';
    this.kind = kind;
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Schema: the same widely supported keywords as the writer's. JSON Schema ranges (minimum,
// maximum) are not among them, so the 0 to 100 bounds are in the descriptions and the validator.
// ---------------------------------------------------------------------------

function score(description: string): Schema {
  return { type: 'integer', description };
}

function choice(values: readonly string[], description: string): Schema {
  return { type: 'string', enum: [...values], description };
}

function jobFactsSchema(): Schema {
  return object(
    'Facts copied from the posting, not inferred.',
    {
      title: text('Job title as posted.'),
      company: text('Employer named in the posting.'),
      location: text('Location or remote policy as posted; omit if not stated.'),
      salary_range: text('Pay range as posted; omit if not stated.'),
      job_type: text('Full-time, part-time, contract and so on, as posted; omit if not stated.'),
      requirements: stringList("Must-have requirements, short phrases in the posting's terms."),
      nice_to_haves: stringList('Preferred qualifications, short phrases.'),
    },
    ['title', 'company', 'requirements', 'nice_to_haves'],
  );
}

export function fitResultJsonSchema(documentNames: string[]): Schema {
  return object(
    'An honest assessment of how well the candidate fits the posting.',
    {
      job: jobFactsSchema(),
      fit_score: score('Whole number from 0 to 100: 85+ strong, 60-84 good, 40-59 stretch, under 40 poor.'),
      confidence: score('Whole number from 0 to 100: how sure you are of fit_score.'),
      recommended_base: choice(documentNames, 'Name of the document closest to the posting.'),
      base_reasoning: text('One or two sentences on why that document fits best.'),
      key_matches: stringList('Strongest evidence of fit, short phrases.'),
      gaps: stringList('Requirements the materials do not cover, short phrases.'),
      gap_mitigation: stringList('Nearest real experience for the main gaps, short phrases.'),
      tailoring_priorities: stringList('What a tailored resume should lead with, most important first.'),
      ats_keywords: stringList('10 to 20 exact screening terms from the posting, spelled as posted.'),
      red_flags: stringList('Stated deal-breakers the candidate may not meet; empty if none.'),
      estimated_competition: choice(COMPETITION, 'How many strong applicants to expect.'),
      apply_recommendation: choice(RECOMMENDATIONS, 'Consistent with fit_score and red_flags.'),
    },
    [...TOP_LEVEL_KEYS],
  );
}

// ---------------------------------------------------------------------------
// Prompt: instructions and documents in the system prompt; the job in the user message.
// ---------------------------------------------------------------------------

export function buildScoreRequest(p: { profile: Profile; job: WriterJob }): WriterRequest {
  const { profile, job } = p;
  return {
    systemPrompt: [INSTRUCTIONS.trim(), ...documentBlocks(profile.documents)].join('\n\n'),
    userMessage: tagged('job', job.text, { url: job.url, title: job.title }),
    schema: fitResultJsonSchema(profile.documents.map((source) => source.name)),
  };
}

// ---------------------------------------------------------------------------
// Reading the reply: structured output first, else the result text
// ---------------------------------------------------------------------------

// The text fallback is the JSON object itself, or the last ```json block around it.
const JSON_BLOCK = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;

// `structured` is undefined when Claude gave no structured output.
export function fitResultFromReply(structured: unknown, resultText: string): FitResult {
  return validateFitResult(structured === undefined ? parseReplyText(resultText) : structured);
}

function parseReplyText(text: string): unknown {
  const whole = parseWhole(text.trim());
  if (whole.parsed) return whole.value;
  const block = [...text.matchAll(JSON_BLOCK)].at(-1)?.[1];
  if (block === undefined) throw new ScoreFormatError('missing', 'No fit score JSON found in the reply');
  try {
    return JSON.parse(block);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ScoreFormatError('invalid', `The fit score JSON block is not valid JSON (${error.message})`);
  }
}

function parseWhole(text: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) return { parsed: false };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Validation: the input is untrusted JSON, so every check starts from `unknown`.
// ---------------------------------------------------------------------------

// Returns a copy in which optional job facts given as null are dropped; the input is never changed.
export function validateFitResult(value: unknown): FitResult {
  const result = withoutNullOptionals(value);
  const problems = findProblems(result);
  if (problems.length > 0) {
    throw new ScoreFormatError('invalid', `Fit score JSON failed validation: ${problems.join('; ')}`, problems);
  }
  // findProblems checked every field of FitResult and rejected any other key, so this is sound.
  return result as FitResult;
}

function withoutNullOptionals(value: unknown): unknown {
  const copy = structuredClone(value);
  if (isRecord(copy) && isRecord(copy.job)) omitNullOptionals(copy.job, OPTIONAL_JOB_KEYS);
  return copy;
}

function findProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['fit result must be an object'];
  const problems: string[] = [];
  checkJob(value.job, problems);
  requireScore(value.fit_score, 'fit_score', problems);
  requireScore(value.confidence, 'confidence', problems);
  requireText(value.recommended_base, 'recommended_base', problems);
  requireText(value.base_reasoning, 'base_reasoning', problems);
  for (const key of PHRASE_LISTS) requireStringArray(value[key], key, problems);
  requireChoice(value.estimated_competition, 'estimated_competition', COMPETITION, problems);
  requireChoice(value.apply_recommendation, 'apply_recommendation', RECOMMENDATIONS, problems);
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, '', problems);
  return problems;
}

function checkJob(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push('job must be an object');
    return;
  }
  requireText(value.title, 'job.title', problems);
  requireText(value.company, 'job.company', problems);
  for (const key of OPTIONAL_JOB_KEYS) optionalString(value[key], `job.${key}`, problems);
  requireStringArray(value.requirements, 'job.requirements', problems);
  requireStringArray(value.nice_to_haves, 'job.nice_to_haves', problems);
  rejectUnknownKeys(value, JOB_KEYS, 'job.', problems);
}

function requireScore(value: unknown, path: string, problems: string[]): void {
  const valid = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SCORE;
  if (!valid) problems.push(`${path} must be a whole number from 0 to ${MAX_SCORE}`);
}

function requireChoice(value: unknown, path: string, choices: readonly string[], problems: string[]): void {
  if (!choices.some((candidate) => candidate === value)) {
    problems.push(`${path} must be one of ${choices.join(', ')}`);
  }
}

function rejectUnknownKeys(value: JsonObject, allowed: readonly string[], prefix: string, problems: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${prefix}${key} is not an allowed key`);
  }
}
