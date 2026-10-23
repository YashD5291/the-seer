import { describe, expect, it } from 'bun:test';
import {
  extractResumeDoc,
  ResumeFormatError,
  resumePlainText,
  validateResumeDoc,
  type ResumeDoc,
} from './resume-doc';
import { VALID, VALID_ANALYSIS, VALID_CHANGELOG } from './test-fixtures';

const FENCE = '```';
const [JOB] = VALID.experience;

const FULL: ResumeDoc = {
  ...VALID,
  contact: { ...VALID.contact, linkedin: 'linkedin.com/in/alex-rivera-example', location: 'Austin, TX' },
  experience: [{ ...JOB, location: 'Remote' }],
  projects: [
    {
      name: 'Seer',
      link: 'github.com/alex-rivera-example/seer',
      bullets: [{ text: 'Built a resume tailoring extension.', priority: 2 }],
    },
  ],
};

function jsonBlock(body: unknown): string {
  return `${FENCE}json\n${JSON.stringify(body)}\n${FENCE}`;
}

function catchFormatError(run: () => unknown): ResumeFormatError {
  try {
    run();
  } catch (error) {
    if (error instanceof ResumeFormatError) return error;
    throw error;
  }
  throw new Error('Expected the call to throw a ResumeFormatError');
}

function withJob(changes: Record<string, unknown>): unknown {
  return { ...VALID, experience: [{ ...JOB, ...changes }] };
}

function withProject(changes: Record<string, unknown>): unknown {
  return { ...VALID, projects: [{ name: 'Seer', bullets: [], ...changes }] };
}

function withAnalysis(changes: Record<string, unknown>): unknown {
  return { ...VALID, analysis: { ...VALID_ANALYSIS, ...changes } };
}

function withTone(changes: Record<string, unknown>): unknown {
  return withAnalysis({ tone: { ...VALID_ANALYSIS.tone, ...changes } });
}

describe('extractResumeDoc', () => {
  it('returns the doc from a json block surrounded by prose', () => {
    const reply = 'Here you go:\n```json\n' + JSON.stringify(VALID) + '\n```\nGood luck';

    expect(extractResumeDoc(reply)).toEqual(VALID);
  });

  it('skips an invalid draft block and returns the valid block after it', () => {
    const reply = [jsonBlock({ version: 1, draft: true }), 'Final version:', jsonBlock(VALID)].join('\n');

    expect(extractResumeDoc(reply)).toEqual(VALID);
  });

  it('returns the last block when several blocks are valid', () => {
    const reply = [jsonBlock({ ...VALID, name: 'First Draft' }), jsonBlock(VALID)].join('\n');

    expect(extractResumeDoc(reply).name).toBe(VALID.name);
  });

  it('accepts a fence without a language label', () => {
    const reply = `${FENCE}\n${JSON.stringify(VALID)}\n${FENCE}`;

    expect(extractResumeDoc(reply)).toEqual(VALID);
  });

  it('accepts an uppercase JSON label', () => {
    const reply = `${FENCE}JSON\n${JSON.stringify(VALID)}\n${FENCE}`;

    expect(extractResumeDoc(reply)).toEqual(VALID);
  });

  it('accepts CRLF line endings', () => {
    const reply = `Here you go:\r\n${FENCE}json\r\n${JSON.stringify(VALID)}\r\n${FENCE}\r\n`;

    expect(extractResumeDoc(reply)).toEqual(VALID);
  });

  for (const label of ['latex', 'text']) {
    it(`finds the json block that follows a ${label} fence`, () => {
      const reply = `${FENCE}${label}\nsome snippet\n${FENCE}\n\nResume:\n${jsonBlock(VALID)}`;

      expect(extractResumeDoc(reply)).toEqual(VALID);
    });
  }

  it('returns the doc when trailing prose mentions a json fence mid-line', () => {
    const reply = `${jsonBlock(VALID)}\nNote: I used a ${FENCE}json fence above.\nThanks!`;

    expect(extractResumeDoc(reply)).toEqual(VALID);
  });

  const truncatedReplies: [name: string, reply: string][] = [
    ['a reply that stops inside the json fence', '```json\n{"version":1,"name":"A"'],
    ['a reply that stops right after the json fence opener', 'Here you go:\n```json'],
    ['a CRLF reply that stops inside the json fence', '```json\r\n{"version":1'],
    ['an uppercase JSON fence that stops early', '```JSON\n{"version":1'],
    ['an opener with trailing spaces that stops early', '```json  \n{"version":1'],
  ];

  for (const [name, reply] of truncatedReplies) {
    it(`reports ${name} as cut off`, () => {
      const error = catchFormatError(() => extractResumeDoc(reply));

      expect(error.kind).toBe('cut-off');
      expect(error.message).toContain('cut off');
    });
  }

  it('reports cut off even when an earlier block is valid', () => {
    const reply = `${jsonBlock(VALID)}\n${FENCE}json\n{"version":1,"name":"A"`;

    const error = catchFormatError(() => extractResumeDoc(reply));

    expect(error.kind).toBe('cut-off');
    expect(error.message).toContain('cut off');
  });

  it('reports cut off even when an earlier block was complete but invalid', () => {
    const reply = `${jsonBlock({ version: 1, draft: true })}\n${FENCE}json\n{"version":1,"name":"A"`;

    const error = catchFormatError(() => extractResumeDoc(reply));

    expect(error.kind).toBe('cut-off');
  });

  it('reports a reply without a fenced block', () => {
    const error = catchFormatError(() => extractResumeDoc(JSON.stringify(VALID)));

    expect(error.kind).toBe('missing');
    expect(error.message).toContain('No resume JSON');
    expect(error.problems).toEqual([error.message]);
  });

  it('treats a block without "version": 1 as no resume JSON', () => {
    const error = catchFormatError(() => extractResumeDoc(jsonBlock({ name: 'A' })));

    expect(error.kind).toBe('missing');
    expect(error.message).toContain('No resume JSON');
  });

  it('ignores an unlabeled fence that is not JSON', () => {
    const reply = `## TAILORED RESUME\n\n${FENCE}\nSKILLS: Python, SQL\n${FENCE}\n`;

    expect(catchFormatError(() => extractResumeDoc(reply)).kind).toBe('missing');
  });

  it('ignores a fence labeled with another language', () => {
    const reply = `${FENCE}latex\n\\section{Skills}\n${FENCE}`;

    expect(catchFormatError(() => extractResumeDoc(reply)).kind).toBe('missing');
  });

  it('reports a block that is not valid JSON', () => {
    const error = catchFormatError(() => extractResumeDoc('```json\n{"version":1,}\n```'));

    expect(error.kind).toBe('invalid');
    expect(error.message).toContain('not valid JSON');
  });

  it('reports the validation problems when the only resume block is invalid', () => {
    const broken = { ...VALID, target: { role: 'ML Engineer' } };

    const error = catchFormatError(() => extractResumeDoc(jsonBlock(broken)));

    expect(error.kind).toBe('invalid');
    expect(error.problems).toContain('target.company is required');
  });

  it('reports the problems of the last block when several blocks are invalid', () => {
    const reply = [jsonBlock({ ...VALID, name: '' }), jsonBlock({ ...VALID, summary: '' })].join('\n');

    const error = catchFormatError(() => extractResumeDoc(reply));

    expect(error.problems).toEqual(['summary is required']);
  });
});

describe('validateResumeDoc', () => {
  it('returns a valid doc', () => {
    expect(validateResumeDoc(VALID)).toEqual(VALID);
  });

  it('accepts every optional field', () => {
    expect(validateResumeDoc(FULL)).toEqual(FULL);
  });

  it('keeps the analysis and the changelog when the reply has them', () => {
    const doc = { ...VALID, analysis: VALID_ANALYSIS, changelog: VALID_CHANGELOG };

    expect(validateResumeDoc(doc)).toStrictEqual(doc);
  });

  it('accepts a reply without the analysis and the changelog, as older replies are', () => {
    const result = validateResumeDoc(VALID);

    expect('analysis' in result).toBe(false);
    expect('changelog' in result).toBe(false);
  });

  it('treats a null analysis or changelog as absent', () => {
    expect(validateResumeDoc({ ...VALID, analysis: null, changelog: null })).toStrictEqual(VALID);
  });

  it('accepts every tone score from 1 to 10', () => {
    for (const score of [1, 5, 10]) {
      const tone = { ...VALID_ANALYSIS.tone, formality: score };

      expect(validateResumeDoc({ ...VALID, analysis: { ...VALID_ANALYSIS, tone } }).analysis?.tone.formality).toBe(score);
    }
  });

  it('omits a null contact.linkedin from the returned doc', () => {
    const doc = { ...VALID, contact: { ...VALID.contact, linkedin: null } };

    const result = validateResumeDoc(doc);

    expect('linkedin' in result.contact).toBe(false);
    expect(result).toEqual(VALID);
  });

  it('treats every null optional key as absent', () => {
    const doc = {
      ...VALID,
      contact: { email: 'a@b.co', phone: '555-0100', linkedin: null, github: null, location: null },
      experience: [{ ...JOB, location: null }],
      projects: null,
    };

    expect(validateResumeDoc(doc)).toStrictEqual({ ...VALID, contact: { email: 'a@b.co', phone: '555-0100' } });
  });

  it('treats a null project link as absent', () => {
    const doc = { ...VALID, projects: [{ name: 'Seer', link: null, bullets: [] }] };

    expect(validateResumeDoc(doc)).toStrictEqual({ ...VALID, projects: [{ name: 'Seer', bullets: [] }] });
  });

  it('leaves the input untouched when it drops null keys', () => {
    const doc = { ...VALID, contact: { ...VALID.contact, linkedin: null } };

    validateResumeDoc(doc);

    expect(doc.contact.linkedin).toBeNull();
  });

  it('rejects a bullet priority outside 1-3', () => {
    const doc = { ...VALID, experience: [{ ...JOB, bullets: [{ text: 'x', priority: 4 }] }] };

    const error = catchFormatError(() => validateResumeDoc(doc));

    expect(error.kind).toBe('invalid');
    expect(error.problems).toContain('experience[0].bullets[0].priority must be 1, 2 or 3');
  });

  it('requires target.company', () => {
    const doc = { ...VALID, target: { role: 'ML Engineer' } };

    const error = catchFormatError(() => validateResumeDoc(doc));

    expect(error.problems).toContain('target.company is required');
  });

  it('reports every problem at once', () => {
    const doc = { ...VALID, name: '', keywords: 'PyTorch', base: '' };

    const { problems } = catchFormatError(() => validateResumeDoc(doc));

    expect(problems).toHaveLength(3);
    expect(problems).toContain('name is required');
    expect(problems).toContain('keywords must be an array of strings');
    expect(problems).toContain('base is required');
  });

  it('accepts any non-empty base id, since the profile decides which bases exist', () => {
    const doc = { ...VALID, base: 'my-custom-base' };

    expect(validateResumeDoc(doc).base).toBe('my-custom-base');
  });

  it('puts every problem into the error message', () => {
    const doc = { ...VALID, name: '', summary: '' };

    const error = catchFormatError(() => validateResumeDoc(doc));

    expect(error.message).toContain('name is required');
    expect(error.message).toContain('summary is required');
  });

  it('rejects input that is not an object', () => {
    for (const value of [null, 'text', 42, [VALID]]) {
      const error = catchFormatError(() => validateResumeDoc(value));

      expect(error.kind).toBe('invalid');
      expect(error.problems).toEqual(['resume must be an object']);
    }
  });

  type InvalidCase = [name: string, doc: unknown, problem: string];
  const invalidDocs: InvalidCase[] = [
    ['a version other than 1', { ...VALID, version: 2 }, 'version must be 1'],
    ['a blank base', { ...VALID, base: ' ' }, 'base is required'],
    ['a missing base', { ...VALID, base: undefined }, 'base is required'],
    ['a non-string base', { ...VALID, base: 7 }, 'base must be a string'],
    ['a blank name', { ...VALID, name: '  ' }, 'name is required'],
    ['a non-string name', { ...VALID, name: 42 }, 'name must be a string'],
    ['a null name', { ...VALID, name: null }, 'name must be a string'],
    ['a missing target', { ...VALID, target: undefined }, 'target.role is required'],
    ['a missing email', { ...VALID, contact: { phone: '555-0100' } }, 'contact.email is required'],
    [
      'a null email',
      { ...VALID, contact: { ...VALID.contact, email: null } },
      'contact.email must be a string',
    ],
    ['a missing phone', { ...VALID, contact: { email: 'a@b.co' } }, 'contact.phone must be a string'],
    [
      'a null phone',
      { ...VALID, contact: { ...VALID.contact, phone: null } },
      'contact.phone must be a string',
    ],
    [
      'a non-string linkedin',
      { ...VALID, contact: { ...VALID.contact, linkedin: 5 } },
      'contact.linkedin must be a string',
    ],
    ['a missing summary', { ...VALID, summary: undefined }, 'summary is required'],
    ['skills that are not an array', { ...VALID, skills: 'Python' }, 'skills must be an array'],
    ['no skills', { ...VALID, skills: [] }, 'skills must not be empty'],
    [
      'a skill row without a category',
      { ...VALID, skills: [{ items: ['Python'] }] },
      'skills[0].category must be a string',
    ],
    [
      'skill items that are not all strings',
      { ...VALID, skills: [{ category: 'Languages', items: ['Python', 3] }] },
      'skills[0].items must be an array of strings',
    ],
    ['no experience', { ...VALID, experience: [] }, 'experience must not be empty'],
    ['a blank job title', withJob({ title: '' }), 'experience[0].title is required'],
    ['a missing job company', withJob({ company: undefined }), 'experience[0].company is required'],
    ['a missing job start', withJob({ start: undefined }), 'experience[0].start is required'],
    ['a missing job end', withJob({ end: undefined }), 'experience[0].end must be a string'],
    ['a null job end', withJob({ end: null }), 'experience[0].end must be a string'],
    ['a non-string job location', withJob({ location: 7 }), 'experience[0].location must be a string'],
    ['a job without bullets', withJob({ bullets: [] }), 'experience[0].bullets must not be empty'],
    [
      'a blank bullet text',
      withJob({ bullets: [JOB.bullets[0], { text: ' ', priority: 2 }] }),
      'experience[0].bullets[1].text is required',
    ],
    [
      'a bullet priority given as text',
      withJob({ bullets: [{ text: 'x', priority: '1' }] }),
      'experience[0].bullets[0].priority must be 1, 2 or 3',
    ],
    ['projects that are not an array', { ...VALID, projects: 'Seer' }, 'projects must be an array'],
    ['a project without a name', withProject({ name: undefined }), 'projects[0].name must be a string'],
    ['a non-string project link', withProject({ link: 9 }), 'projects[0].link must be a string'],
    [
      'project bullets that are not an array',
      withProject({ bullets: 'text' }),
      'projects[0].bullets must be an array',
    ],
    [
      'a project bullet priority of 0',
      withProject({ bullets: [{ text: 'x', priority: 0 }] }),
      'projects[0].bullets[0].priority must be 1, 2 or 3',
    ],
    ['education that is not an array', { ...VALID, education: {} }, 'education must be an array'],
    [
      'an education entry without a date',
      { ...VALID, education: [{ school: 'State University', degree: 'B.S.' }] },
      'education[0].date must be a string',
    ],
    [
      'keywords that are not an array',
      { ...VALID, keywords: 'PyTorch' },
      'keywords must be an array of strings',
    ],
    [
      'a non-string keyword',
      { ...VALID, keywords: ['PyTorch', 3] },
      'keywords must be an array of strings',
    ],
    ['an analysis that is not an object', { ...VALID, analysis: 'Backend role' }, 'analysis must be an object'],
    ['an analysis without a role type', withAnalysis({ role_type: undefined }), 'analysis.role_type must be a string'],
    ['a non-string company DNA', withAnalysis({ company_dna: 3 }), 'analysis.company_dna must be a string'],
    ['a non-string seniority', withAnalysis({ seniority: null }), 'analysis.seniority must be a string'],
    [
      'must-haves that are not an array',
      withAnalysis({ must_haves: 'Python' }),
      'analysis.must_haves must be an array of strings',
    ],
    [
      'a non-string nice-to-have',
      withAnalysis({ nice_to_haves: ['DPO', 4] }),
      'analysis.nice_to_haves must be an array of strings',
    ],
    [
      'core problems that are not an array',
      withAnalysis({ core_problems: undefined }),
      'analysis.core_problems must be an array of strings',
    ],
    ['gaps that are not an array', withAnalysis({ gaps: 'none' }), 'analysis.gaps must be an array'],
    [
      'a gap without evidence',
      withAnalysis({ gaps: [{ requirement: 'DPO', action: 'Skip' }] }),
      'analysis.gaps[0].evidence must be a string',
    ],
    [
      'a gap whose action is not a string',
      withAnalysis({ gaps: [{ requirement: 'DPO', evidence: 'NO MATCH', action: 4 }] }),
      'analysis.gaps[0].action must be a string',
    ],
    ['a missing tone', withAnalysis({ tone: undefined }), 'analysis.tone must be an object'],
    ['a tone score of 0', withTone({ technical_depth: 0 }), 'analysis.tone.technical_depth must be a whole number from 1 to 10'],
    ['a tone score of 11', withTone({ formality: 11 }), 'analysis.tone.formality must be a whole number from 1 to 10'],
    [
      'a fractional tone score',
      withTone({ culture_emphasis: 5.5 }),
      'analysis.tone.culture_emphasis must be a whole number from 1 to 10',
    ],
    [
      'a tone score given as text',
      withTone({ individual_vs_team: '6' }),
      'analysis.tone.individual_vs_team must be a whole number from 1 to 10',
    ],
    [
      'a missing tone score',
      withTone({ innovation_vs_stability: undefined }),
      'analysis.tone.innovation_vs_stability must be a whole number from 1 to 10',
    ],
    ['a changelog that is not an array', { ...VALID, changelog: 'Rewrote the summary.' }, 'changelog must be an array of strings'],
    ['a non-string changelog entry', { ...VALID, changelog: ['Rewrote the summary.', 2] }, 'changelog must be an array of strings'],
  ];

  for (const [name, doc, problem] of invalidDocs) {
    it(`reports ${name}`, () => {
      expect(catchFormatError(() => validateResumeDoc(doc)).problems).toContain(problem);
    });
  }
});

describe('resumePlainText', () => {
  it('contains every bullet text and every skill item', () => {
    const text = resumePlainText(VALID);

    for (const bullet of JOB.bullets) expect(text).toContain(bullet.text);
    for (const row of VALID.skills) {
      for (const item of row.items) expect(text).toContain(item);
    }
  });

  it('puts the summary and the project bullets on their own lines', () => {
    const lines = resumePlainText(FULL).split('\n');

    expect(lines).toContain(FULL.summary);
    expect(lines).toContain('Built a resume tailoring extension.');
  });
});
