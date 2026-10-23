import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeLatex, readPreamble, renderResumeLatex } from './latex';
import { extractText } from './my-files/extract';
import type { Bullet, ResumeDoc } from './resume-doc';
import { SAMPLE_DOC } from './sample-doc';
import { VALID } from './test-fixtures';

const REAL_TEMPLATE = fileURLToPath(new URL('../GEN/GEN-V3.tex', import.meta.url));
const [JOB] = VALID.experience;

type Project = NonNullable<ResumeDoc['projects']>[number];

const PROJECT: Project = {
  name: 'Seer',
  link: 'github.com/alex-rivera-example/seer',
  bullets: [
    { text: 'Built a resume tailoring extension.', priority: 2 },
    { text: 'Wrote a deterministic LaTeX renderer.', priority: 3 },
  ],
};
const WITH_PROJECT: ResumeDoc = { ...VALID, projects: [PROJECT] };

const ALEX: ResumeDoc = {
  ...VALID,
  name: 'Alex Rivera',
  contact: {
    email: 'alex.rivera@example.com',
    phone: '+1 (555) 010-0199',
    linkedin: 'linkedin.com/in/alex-rivera-example',
    github: 'github.com/alex-rivera-example',
  },
};

// Every text field holds an underscore, which LaTeX rejects unless it is escaped.
const MARKED: ResumeDoc = {
  version: 1,
  target: { company: 'Acme', role: 'Engineer' },
  base: 'gen_ai',
  name: 'name_1',
  contact: {
    email: 'email_1@example.com',
    phone: '555_1',
    linkedin: 'linkedin.com/in/li_1',
    github: 'github.com/gh_1',
  },
  summary: 'summary_1',
  skills: [{ category: 'category_1', items: ['item_1', 'item_2'] }],
  experience: [
    {
      title: 'title_1',
      company: 'company_1',
      location: 'location_1',
      start: 'start_1',
      end: 'end_1',
      bullets: [{ text: 'jobbullet_1', priority: 1 }],
    },
  ],
  projects: [
    { name: 'project_1', link: 'github.com/p_1', bullets: [{ text: 'projectbullet_1', priority: 2 }] },
  ],
  education: [{ school: 'school_1', degree: 'degree_1', date: 'date_1' }],
  keywords: [],
};

const tempDir = mkdtempSync(join(tmpdir(), 'seer-latex-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function writeTemplate(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function render(doc: ResumeDoc): string {
  return renderResumeLatex(doc, '%PRE');
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// Collapses all whitespace, so assertions on LaTeX structure ignore the indentation.
function flat(tex: string): string {
  return tex.replace(/\s+/g, ' ');
}

// The header's contact lines (paragraphs after \normalsize), each with its whitespace collapsed.
function contactLines(tex: string): string[] {
  const block = tex.slice(tex.indexOf('\\normalsize') + '\\normalsize'.length, tex.indexOf('\\end{header}'));
  return block
    .split(/\n\s*\n/)
    .map((line) => flat(line).trim())
    .filter((line) => line !== '');
}

function sectionTitles(tex: string): string[] {
  return [...tex.matchAll(/\\section\{([^}]*)\}/g)].map((match) => match[1]);
}

// Counts \begin{x} against \end{x} for every environment and names the ones that differ.
function unbalancedEnvironments(tex: string): string[] {
  const balance = new Map<string, number>();
  for (const [, name] of tex.matchAll(/\\begin\{(\w+)\}/g)) balance.set(name, (balance.get(name) ?? 0) + 1);
  for (const [, name] of tex.matchAll(/\\end\{(\w+)\}/g)) balance.set(name, (balance.get(name) ?? 0) - 1);
  return [...balance].filter(([, difference]) => difference !== 0).map(([name]) => name);
}

describe('escapeLatex', () => {
  it('escapes every special character exactly once', () => {
    expect(escapeLatex('R&D 100% $5 #1 a_b {x} ~ ^ \\ — –')).toBe(
      'R\\&D 100\\% \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{} -- --',
    );
  });

  it('leaves ordinary punctuation and non-ASCII letters alone', () => {
    const text = 'A/B testing, C++ (v2) + "quoted" @ 3.5 é “smart”';

    expect(escapeLatex(text)).toBe(text);
  });
});

describe('readPreamble', () => {
  it('returns the template up to and including the line with the separator box', () => {
    const path = writeTemplate(
      'cut.tex',
      '\\documentclass{article}\n\\begin{document}\n  \\sbox\\ANDbox{$|$}\n\\section{Skills}\nsample body\n',
    );

    expect(readPreamble(path)).toBe('\\documentclass{article}\n\\begin{document}\n  \\sbox\\ANDbox{$|$}');
  });

  it('stops the real template before its sample content', () => {
    const preamble = readPreamble(REAL_TEMPLATE);

    expect(preamble).toContain('\\newenvironment{twocolentry}');
    expect(preamble.split('\n').at(-1)).toContain('\\sbox\\ANDbox');
    expect(preamble).not.toContain('\\section{Skills}');
  });

  it('leaves nothing but the end of the document after the separator box in the real template', () => {
    const lines = readFileSync(REAL_TEMPLATE, 'utf-8').split('\n');
    const marker = lines.findIndex((line) => line.includes('\\sbox\\ANDbox'));

    const rest = lines.slice(marker + 1).filter((line) => line.trim() !== '');

    expect(marker).toBeGreaterThan(-1);
    expect(rest).toEqual(['\\end{document}']);
  });

  it('leaves the PDF author of the real template empty', () => {
    const template = readFileSync(REAL_TEMPLATE, 'utf-8');

    expect(count(template, 'pdfauthor')).toBe(1);
    expect(template).toContain('pdfauthor={}');
  });

  it('rejects a template without the separator box line', () => {
    const path = writeTemplate('no-marker.tex', '\\documentclass{article}\n\\begin{document}\n');

    expect(() => readPreamble(path)).toThrow('Cannot find preamble end marker in template');
  });
});

describe('renderResumeLatex', () => {
  it('puts the preamble first and closes the document last', () => {
    const tex = render(VALID);

    expect(tex.startsWith('%PRE\n')).toBe(true);
    expect(tex.endsWith('\\end{document}')).toBe(true);
  });

  it('opens and closes every environment, including the template preamble', () => {
    const doc: ResumeDoc = { ...VALID, projects: [PROJECT, { name: 'Bare', bullets: [] }] };

    expect(unbalancedEnvironments(renderResumeLatex(doc, readPreamble(REAL_TEMPLATE)))).toEqual([]);
  });

  describe('sections', () => {
    it('lists Skills, Experience and Education, with no Projects when there are none', () => {
      expect(sectionTitles(render(VALID))).toEqual(['Skills', 'Experience', 'Education']);
    });

    it('puts Projects between Experience and Education', () => {
      expect(sectionTitles(render(WITH_PROJECT))).toEqual(['Skills', 'Experience', 'Projects', 'Education']);
    });

    it('prints no heading and no stray blank lines for empty projects or education lists', () => {
      const tex = render({ ...VALID, projects: [], education: [] });

      expect(sectionTitles(tex)).toEqual(['Skills', 'Experience']);
      expect(tex).not.toContain('\n\n\n');
    });

    it('puts the header, then the summary, before the first section', () => {
      const tex = render(VALID);
      const positions = [
        tex.indexOf(`\\textbf{${VALID.name}}`),
        tex.indexOf(VALID.summary),
        tex.indexOf('\\section{Skills}'),
      ];

      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('renders each skill category as a bold label and a comma-separated row', () => {
      const tex = render(VALID);

      expect(tex).toContain('\\textbf{Languages:} Python, TypeScript, SQL');
      expect(tex).toContain('\\textbf{Frameworks:} LangChain, Hugging Face');
    });

    it('renders an education entry with its date, bold school and degree', () => {
      const tex = render(VALID);

      expect(flat(tex)).toContain('\\begin{twocolentry}{ May 2020 } \\textbf{State University}');
      expect(tex).toContain('B.S. Computer Science');
    });
  });

  describe('experience', () => {
    it('renders a job as a bold title, the company and a start -- end date', () => {
      const tex = render(VALID);

      expect(flat(tex)).toContain(
        '\\begin{twocolentry}{ Jan 2023 -- Present } ' +
          '\\textbf{Machine Learning Engineer} | Northwind Labs \\end{twocolentry}',
      );
    });

    it('appends the location to the company', () => {
      const tex = render({ ...VALID, experience: [{ ...JOB, location: 'Remote (Austin, TX)' }] });

      expect(tex).toContain('\\textbf{Machine Learning Engineer} | Northwind Labs -- Remote (Austin, TX)');
    });

    it('shows only the start date when a job has no end date', () => {
      const tex = render({ ...VALID, experience: [{ ...JOB, start: 'Summer 2023', end: '' }] });

      expect(flat(tex)).toContain('\\begin{twocolentry}{ Summer 2023 }');
    });

    it('puts the template separator between jobs only', () => {
      const twoJobs = { ...VALID, experience: [JOB, { ...JOB, company: 'Globex' }] };

      expect(count(render(twoJobs), '\\experienceSeparator')).toBe(1);
      expect(count(render(VALID), '\\experienceSeparator')).toBe(0);
    });

    it('renders one item per bullet, escaped', () => {
      const tex = render(VALID);

      expect(count(tex, '\\item')).toBe(3);
      expect(tex).toContain('\\item\\relax Built a RAG pipeline answering 2M queries per month.');
      expect(tex).toContain('\\item\\relax Cut inference latency 40\\% by batching PyTorch requests.');
    });

    it('keeps a leading bracket out of the optional item label', () => {
      const bullets: Bullet[] = [
        { text: '[x] shipped', priority: 1 },
        { text: '[unclosed bracket', priority: 2 },
      ];

      const tex = render({ ...VALID, experience: [{ ...JOB, bullets }] });

      expect(tex).toContain('\\item\\relax [x] shipped');
      expect(tex).toContain('\\item\\relax [unclosed bracket');
    });
  });

  describe('projects', () => {
    it('renders a project as a bold name with its link, then its bullets', () => {
      const tex = render(WITH_PROJECT);

      expect(tex).toContain(
        '\\textbf{Seer} | \\hrefWithoutArrow{https://github.com/alex-rivera-example/seer}{github.com/alex-rivera-example/seer}',
      );
      expect(tex).toContain('\\item\\relax Built a resume tailoring extension.');
      expect(count(tex, '\\item')).toBe(5);
    });

    it('renders a project without a link as just the bold name', () => {
      const tex = render({ ...VALID, projects: [{ name: 'Seer', bullets: PROJECT.bullets }] });

      expect(flat(tex)).toContain('\\textbf{Seer} \\end{onecolentry}');
    });

    it('keeps a leading bracket out of the optional item label', () => {
      const bullets: Bullet[] = [{ text: '[x] shipped', priority: 2 }];

      const tex = render({ ...VALID, projects: [{ name: 'Seer', bullets }] });

      expect(tex).toContain('\\item\\relax [x] shipped');
    });

    it('skips the bullet list of a project without bullets', () => {
      const tex = render({ ...VALID, projects: [{ name: 'Seer', bullets: [] }] });

      expect(tex).toContain('\\textbf{Seer}');
      expect(count(tex, '\\begin{highlights}')).toBe(1);
      expect(count(tex, '\\item')).toBe(3);
    });
  });

  describe('header', () => {
    it('renders the name in bold', () => {
      expect(render(VALID)).toContain(`\\textbf{${VALID.name}}`);
    });

    const EMAIL = '{\\hrefWithoutArrow{mailto:alex.rivera@example.com}{alex.rivera@example.com}}';
    const PHONE = '{\\hrefWithoutArrow{tel:+1-555-010-0199}{+1 (555) 010-0199}}';
    const LINKEDIN =
      '{\\hrefWithoutArrow{https://linkedin.com/in/alex-rivera-example}{linkedin.com/in/alex-rivera-example}}';
    const GITHUB = '{\\hrefWithoutArrow{https://github.com/alex-rivera-example}{github.com/alex-rivera-example}}';

    it('puts email and phone on the first line, LinkedIn and GitHub on the second, separated by bars', () => {
      const tex = render(ALEX);

      expect(contactLines(tex)).toEqual([`${EMAIL} {|} ${PHONE}`, `${LINKEDIN} {|} ${GITHUB}`]);
      expect(count(tex, '{|}')).toBe(2);
    });

    const layouts: [name: string, contact: ResumeDoc['contact'], lines: string[]][] = [
      [
        'keeps GitHub alone on the second line when there is no LinkedIn (3 links)',
        { email: ALEX.contact.email, phone: ALEX.contact.phone, github: ALEX.contact.github },
        [`${EMAIL} {|} ${PHONE}`, GITHUB],
      ],
      [
        'keeps the email alone on the first line when there is no phone (3 links)',
        { email: ALEX.contact.email, phone: '', linkedin: ALEX.contact.linkedin, github: ALEX.contact.github },
        [EMAIL, `${LINKEDIN} {|} ${GITHUB}`],
      ],
      [
        'has one line when there are only email and phone (2 links)',
        { email: ALEX.contact.email, phone: ALEX.contact.phone },
        [`${EMAIL} {|} ${PHONE}`],
      ],
      [
        'has two lines and no bar when there are only email and LinkedIn (2 links)',
        { email: ALEX.contact.email, phone: '', linkedin: ALEX.contact.linkedin },
        [EMAIL, LINKEDIN],
      ],
      ['has one line and no bar when there is only an email (1 link)', { email: ALEX.contact.email, phone: '' }, [EMAIL]],
      ['has no second line when there is only a phone (1 link)', { email: '', phone: ALEX.contact.phone }, [PHONE]],
    ];

    for (const [name, contact, lines] of layouts) {
      it(name, () => {
        const tex = render({ ...ALEX, contact });

        expect(contactLines(tex)).toEqual(lines);
        expect(count(tex, '{|}')).toBe(lines.join(' ').split('{|}').length - 1);
      });
    }

    it('omits the LinkedIn and GitHub links when there are none', () => {
      const contact = { email: ALEX.contact.email, phone: ALEX.contact.phone };
      const tex = render({ ...ALEX, contact });

      expect(tex.toLowerCase()).not.toContain('linkedin');
      expect(tex).not.toContain('github');
    });

    const emptyContacts: [name: string, contact: Partial<ResumeDoc['contact']>, absent: string][] = [
      ['phone', { phone: '' }, 'tel:'],
      ['email', { email: '' }, 'mailto:'],
    ];

    for (const [name, contact, absent] of emptyContacts) {
      it(`skips an empty ${name} and its separator`, () => {
        const tex = render({ ...VALID, contact: { ...VALID.contact, ...contact } });

        expect(tex).not.toContain(absent);
        expect(count(tex, '{|}')).toBe(0);
      });
    }

    it('builds the tel: link without spaces or parentheses', () => {
      const tex = render({ ...VALID, contact: { ...VALID.contact, phone: ALEX.contact.phone } });

      expect(tex).toContain('{\\hrefWithoutArrow{tel:+1-555-010-0199}{+1 (555) 010-0199}}');
    });

    const profileLinks: [name: string, key: 'linkedin' | 'github', link: string, target: string][] = [
      [
        'adds https:// to a LinkedIn link without a scheme',
        'linkedin',
        'linkedin.com/in/alex-rivera-example',
        'https://linkedin.com/in/alex-rivera-example',
      ],
      [
        'keeps the scheme of a LinkedIn link that has one',
        'linkedin',
        'https://linkedin.com/in/alex-rivera-example',
        'https://linkedin.com/in/alex-rivera-example',
      ],
      [
        'adds https:// to a GitHub link without a scheme',
        'github',
        'github.com/alex-rivera-example',
        'https://github.com/alex-rivera-example',
      ],
      [
        'keeps the scheme of a GitHub link that has one',
        'github',
        'https://github.com/alex-rivera-example',
        'https://github.com/alex-rivera-example',
      ],
    ];

    for (const [name, key, link, target] of profileLinks) {
      it(name, () => {
        const tex = render({ ...ALEX, contact: { ...ALEX.contact, [key]: link } });

        expect(tex).toContain(`{\\hrefWithoutArrow{${target}}{${link}}}`);
      });
    }
  });

  describe('PDF author', () => {
    it('is the name on the resume, once, in the real template', () => {
      const tex = renderResumeLatex(ALEX, readPreamble(REAL_TEMPLATE));

      expect(count(tex, 'pdfauthor')).toBe(1);
      expect(tex).toContain('pdfauthor={Alex Rivera}');
    });

    it('replaces an author already in the preamble', () => {
      const tex = renderResumeLatex(ALEX, '\\usepackage[pdfauthor={Someone Else}, colorlinks=true]{hyperref}');

      expect(tex).toContain('pdfauthor={Alex Rivera}, colorlinks=true');
      expect(tex).not.toContain('Someone Else');
    });

    it('escapes the name like any other text', () => {
      const tex = renderResumeLatex(MARKED, 'pdfauthor={}');

      expect(tex).toContain('pdfauthor={name\\_1}');
    });

    it('keeps a name with replacement-pattern characters literal', () => {
      const tex = renderResumeLatex({ ...ALEX, name: "Al$'ex $& Rivera" }, 'pdfauthor={}');

      expect(tex).toContain("pdfauthor={Al\\$'ex \\$\\& Rivera}");
    });

    it('adds nothing to a preamble that has no PDF author', () => {
      expect(render(ALEX)).not.toContain('pdfauthor');
    });
  });

  describe('escaping', () => {
    const escapedFields: [field: string, escaped: string][] = [
      ['name', 'name\\_1'],
      ['email', 'email\\_1@example.com'],
      ['phone', '555\\_1'],
      ['LinkedIn', 'linkedin.com/in/li\\_1'],
      ['GitHub', 'github.com/gh\\_1'],
      ['summary', 'summary\\_1'],
      ['skill category', 'category\\_1'],
      ['skill items', 'item\\_1, item\\_2'],
      ['job title', 'title\\_1'],
      ['company and location', 'company\\_1 -- location\\_1'],
      ['job dates', 'start\\_1 -- end\\_1'],
      ['job bullet', 'jobbullet\\_1'],
      ['project name', 'project\\_1'],
      ['project link', 'github.com/p\\_1'],
      ['project bullet', 'projectbullet\\_1'],
      ['school', 'school\\_1'],
      ['degree', 'degree\\_1'],
      ['education date', 'date\\_1'],
    ];

    for (const [field, escaped] of escapedFields) {
      it(`escapes the ${field}`, () => {
        expect(render(MARKED)).toContain(escaped);
      });
    }

    it('leaves link targets unescaped', () => {
      const tex = render(MARKED);

      expect(tex).toContain('mailto:email_1@example.com');
      expect(tex).toContain('https://linkedin.com/in/li_1');
      expect(tex).toContain('https://github.com/gh_1');
      expect(tex).toContain('https://github.com/p_1');
    });
  });
});

// Compiles `doc` with the real template and returns the PDF's path.
function compileWithTectonic(doc: ResumeDoc): string {
  const tex = renderResumeLatex(doc, readPreamble(REAL_TEMPLATE));
  const dir = mkdtempSync(join(tempDir, 'compile-'));
  writeFileSync(join(dir, 'resume.tex'), tex, 'utf-8');

  const result = spawnSync('tectonic', ['--outdir', dir, 'resume.tex'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 120_000,
  });

  const failure = result.status === 0 ? '' : `tectonic exited ${result.status}: ${result.stderr}`;
  expect(failure).toBe('');
  const pdfPath = join(dir, 'resume.pdf');
  expect(existsSync(pdfPath)).toBe(true);
  return pdfPath;
}

describe.skipIf(!Bun.which('tectonic'))('renderResumeLatex compiled with tectonic', () => {
  it('compiles bullets with a leading bracket and every special character', () => {
    const bullets: Bullet[] = [
      { text: '[x] shipped', priority: 1 },
      { text: '[unclosed bracket', priority: 2 },
      { text: '100% of C++ & CUDA_kernels — {fast} ~ ^ é “q”', priority: 3 },
    ];
    compileWithTectonic({ ...VALID, experience: [{ ...JOB, bullets }] });
  }, 120_000);

  it('never leaves a bar at the start or end of a header line when all four links are present', async () => {
    const text = await extractText(compileWithTectonic(SAMPLE_DOC), 'pdf');
    const lines = text.split(/\r?\n/).map((line) => line.trim());

    expect(lines).toContain('alex.rivera@example.com | +1 (555) 010-0199');
    expect(lines).toContain('linkedin.com/in/alex-rivera-example | github.com/alex-rivera-example');
    expect(lines.filter((line) => line.startsWith('|') || line.endsWith('|'))).toEqual([]);
  }, 120_000);
});
