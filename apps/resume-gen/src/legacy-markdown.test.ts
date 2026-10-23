import { describe, expect, it } from 'bun:test';
import { parseLegacyMarkdown } from './legacy-markdown';
import { ResumeFormatError, validateResumeDoc, type ResumeDoc } from './resume-doc';

const FINAL_DEGREE = 'Bachelor of Science, Software Engineering';

// The trailing double spaces are markdown line breaks, as the old prompts produced them.
const RESUME = [
  '# Alex Rivera',
  '',
  '**Email:** alex.rivera@example.com  ',
  '**Phone:** +1 (555) 010-0199  ',
  '**GitHub:** github.com/alex-rivera-example',
  '',
  'ML engineer who ships retrieval-augmented generation systems to production.',
  '',
  '## Skills',
  '',
  '**Languages:** Python, Go, SQL',
  '**Data & Storage:** Vector DBs (FAISS, Pinecone), Redis',
  '',
  '## Experience',
  '',
  '**Senior ML Engineer** | Northwind Labs -- Remote (Austin, TX)  ',
  'Jan 2023 - Present  ',
  '',
  '- Built a RAG pipeline answering 2M queries per month.',
  '- Cut inference latency 40% by batching PyTorch requests.',
  '- Mentored four engineers on evaluation and prompt testing.',
  '',
  '**Data Engineer** | Globex -- Charlotte, NC  ',
  'Jun 2020 - Dec 2021',
  '',
  '- Built Kafka pipelines for real-time analytics.',
  '- Reduced month-end processing from 8 hours to 3.',
  '',
  '## Education',
  '',
  '**State University**  ',
  'May 2018  ',
  'Master of Science, Computer Science',
  '',
  '**City College**  ',
  'May 2016  ',
  FINAL_DEGREE,
].join('\n');

// With the last degree line gone, anything that leaks into the Education block shows up as the degree.
const RESUME_WITHOUT_FINAL_DEGREE = RESUME.replace(`\n${FINAL_DEGREE}`, '');

const CHANGELOG = [
  '## CHANGELOG',
  '',
  '| Section | Original | Modified | Rationale |',
  '|---------|----------|----------|-----------|',
  '| Skills | Rust, Go | Go | Swapped Rust for Go because the JD asks for Go |',
].join('\n');

const LEGACY = ['---', '## TAILORED RESUME', '', RESUME, '', '---', CHANGELOG].join('\n');

const EDUCATION: ResumeDoc['education'] = [
  { school: 'State University', degree: 'Master of Science, Computer Science', date: 'May 2018' },
  { school: 'City College', degree: FINAL_DEGREE, date: 'May 2016' },
];

function catchFormatError(run: () => unknown): ResumeFormatError {
  try {
    run();
  } catch (error) {
    if (error instanceof ResumeFormatError) return error;
    throw error;
  }
  throw new Error('Expected the call to throw a ResumeFormatError');
}

function replyOf(resume: string): string {
  return `## TAILORED RESUME\n\n${resume}`;
}

describe('parseLegacyMarkdown', () => {
  it('reads the name, contact details and summary', () => {
    const doc = parseLegacyMarkdown(LEGACY, null);

    expect(doc.name).toBe('Alex Rivera');
    expect(doc.contact).toStrictEqual({
      email: 'alex.rivera@example.com',
      phone: '+1 (555) 010-0199',
      github: 'github.com/alex-rivera-example',
    });
    expect(doc.summary).toBe('ML engineer who ships retrieval-augmented generation systems to production.');
  });

  it('keeps LinkedIn when the reply has it', () => {
    const reply = LEGACY.replace('**GitHub:**', '**LinkedIn:** linkedin.com/in/alex-rivera-example  \n**GitHub:**');

    expect(parseLegacyMarkdown(reply, null).contact.linkedin).toBe('linkedin.com/in/alex-rivera-example');
  });

  it('reads the summary and omits GitHub when the contact block has no GitHub line', () => {
    const reply = LEGACY.replace('**GitHub:** github.com/alex-rivera-example\n', '');

    const doc = parseLegacyMarkdown(reply, null);

    expect(doc.contact).toStrictEqual({ email: 'alex.rivera@example.com', phone: '+1 (555) 010-0199' });
    expect(doc.summary).toBe('ML engineer who ships retrieval-augmented generation systems to production.');
  });

  describe('skills', () => {
    it('splits each row into items and keeps a parenthesised list whole', () => {
      expect(parseLegacyMarkdown(LEGACY, null).skills).toStrictEqual([
        { category: 'Languages', items: ['Python', 'Go', 'SQL'] },
        { category: 'Data & Storage', items: ['Vector DBs (FAISS, Pinecone)', 'Redis'] },
      ]);
    });

    it('drops empty items left by stray commas', () => {
      const reply = LEGACY.replace('Python, Go, SQL', 'Python,, Go, SQL,');

      expect(parseLegacyMarkdown(reply, null).skills[0].items).toEqual(['Python', 'Go', 'SQL']);
    });

    it('ignores lines that are not category rows', () => {
      const reply = LEGACY.replace('**Languages:**', 'langchain, langgraph, crewai\n**Languages:**');

      const categories = parseLegacyMarkdown(reply, null).skills.map((row) => row.category);

      expect(categories).toEqual(['Languages', 'Data & Storage']);
    });

    it('reads rows only from the Skills section', () => {
      const reply = LEGACY.replace('- Built Kafka', '- **Impact:** Built Kafka');

      const categories = parseLegacyMarkdown(reply, null).skills.map((row) => row.category);

      expect(categories).toEqual(['Languages', 'Data & Storage']);
    });

    it('returns no skills when the reply has no Skills section', () => {
      const resume = RESUME.replace(/## Skills[\s\S]*?(?=## Experience)/, '');

      expect(parseLegacyMarkdown(replyOf(resume), null).skills).toEqual([]);
    });
  });

  describe('experience', () => {
    it('reads each job with its location, dates and bullets at priority 2', () => {
      expect(parseLegacyMarkdown(LEGACY, null).experience).toStrictEqual([
        {
          title: 'Senior ML Engineer',
          company: 'Northwind Labs',
          location: 'Remote (Austin, TX)',
          start: 'Jan 2023',
          end: 'Present',
          bullets: [
            { text: 'Built a RAG pipeline answering 2M queries per month.', priority: 2 },
            { text: 'Cut inference latency 40% by batching PyTorch requests.', priority: 2 },
            { text: 'Mentored four engineers on evaluation and prompt testing.', priority: 2 },
          ],
        },
        {
          title: 'Data Engineer',
          company: 'Globex',
          location: 'Charlotte, NC',
          start: 'Jun 2020',
          end: 'Dec 2021',
          bullets: [
            { text: 'Built Kafka pipelines for real-time analytics.', priority: 2 },
            { text: 'Reduced month-end processing from 8 hours to 3.', priority: 2 },
          ],
        },
      ]);
    });

    it('omits the location of a job whose company line has none', () => {
      const reply = LEGACY.replace(' -- Charlotte, NC', '');

      expect(parseLegacyMarkdown(reply, null).experience[1]).toStrictEqual({
        title: 'Data Engineer',
        company: 'Globex',
        start: 'Jun 2020',
        end: 'Dec 2021',
        bullets: [
          { text: 'Built Kafka pipelines for real-time analytics.', priority: 2 },
          { text: 'Reduced month-end processing from 8 hours to 3.', priority: 2 },
        ],
      });
    });

    it('keeps a hyphenated company name whole', () => {
      const reply = LEGACY.replace('Globex -- Charlotte, NC', 'Coca-Cola -- Atlanta, GA');

      expect(parseLegacyMarkdown(reply, null).experience[1]).toMatchObject({
        company: 'Coca-Cola',
        location: 'Atlanta, GA',
      });
    });

    it('ignores text before the first job', () => {
      const reply = LEGACY.replace('## Experience\n', '## Experience\n\nSelected roles:\n');

      const companies = parseLegacyMarkdown(reply, null).experience.map((job) => job.company);

      expect(companies).toEqual(['Northwind Labs', 'Globex']);
    });

    it('reads only lines that start with "- " as bullets', () => {
      const reply = LEGACY.replace(
        '- Mentored four engineers on evaluation and prompt testing.',
        '- Mentored four engineers on evaluation and prompt testing.\n-not a bullet\n* nor this',
      );

      expect(parseLegacyMarkdown(reply, null).experience[0].bullets).toHaveLength(3);
    });

    it('reads an indented bullet without its dash', () => {
      const reply = LEGACY.replace('- Built Kafka', '  - Built Kafka');

      expect(parseLegacyMarkdown(reply, null).experience[1].bullets[0].text).toBe(
        'Built Kafka pipelines for real-time analytics.',
      );
    });
  });

  describe('education', () => {
    it('reads every entry', () => {
      expect(parseLegacyMarkdown(LEGACY, null).education).toStrictEqual(EDUCATION);
    });

    it('returns no education when nothing follows the Education heading', () => {
      const upToEducation = RESUME.slice(0, RESUME.indexOf('**State University**')).trimEnd();

      expect(parseLegacyMarkdown(replyOf(upToEducation), null).education).toEqual([]);
    });
  });

  it('produces a doc that passes the ResumeDoc validation', () => {
    const doc = parseLegacyMarkdown(LEGACY, 'Acme AI - ML Engineer');

    expect(validateResumeDoc(doc)).toEqual(doc);
  });

  describe('dates', () => {
    const dateLines: [dateLine: string, start: string, end: string][] = [
      ['Jan 2023 - Present', 'Jan 2023', 'Present'],
      ['Jun 2024 – Oct 2025', 'Jun 2024', 'Oct 2025'],
      ['Jan 2022 — May 2024', 'Jan 2022', 'May 2024'],
      ['Jun 2020 -- Dec 2021', 'Jun 2020', 'Dec 2021'],
      ['Summer 2023', 'Summer 2023', ''],
    ];

    for (const [dateLine, start, end] of dateLines) {
      it(`splits "${dateLine}" into "${start}" and "${end}"`, () => {
        const reply = replyOf(RESUME.replace('Jan 2023 - Present', dateLine));

        const [job] = parseLegacyMarkdown(reply, null).experience;

        expect({ start: job.start, end: job.end }).toEqual({ start, end });
      });
    }
  });

  describe('reply framing', () => {
    it('leaves the CHANGELOG out of the doc', () => {
      const serialized = JSON.stringify(parseLegacyMarkdown(LEGACY, null));

      expect(serialized).not.toContain('CHANGELOG');
      expect(serialized).not.toContain('Swapped Rust for Go');
    });

    const bare = RESUME_WITHOUT_FINAL_DEGREE;
    const framings: [name: string, reply: string][] = [
      ['a CHANGELOG without a --- separator', `## TAILORED RESUME\n\n${bare}\n\n${CHANGELOG}`],
      ['a CHANGELOG after a --- separator', `## TAILORED RESUME\n\n${bare}\n\n---\n${CHANGELOG}`],
      ['two --- separators before the CHANGELOG', `## TAILORED RESUME\n\n${bare}\n\n---\n---\n${CHANGELOG}`],
      ['a --- right under the heading', `## TAILORED RESUME\n---\n${bare}\n\n---\n${CHANGELOG}`],
      ['a trailing --- and no CHANGELOG', `## TAILORED RESUME\n\n${bare}\n\n---`],
      [
        'analysis text before the heading',
        `# CHAT TITLE\n**Acme - Role**\n\n## ANALYSIS\n\nNotes.\n\n---\n## TAILORED RESUME\n\n${bare}`,
      ],
    ];

    for (const [name, reply] of framings) {
      it(`reads a reply with ${name}`, () => {
        const doc = parseLegacyMarkdown(reply, null);

        expect(doc.name).toBe('Alex Rivera');
        expect(doc.experience).toHaveLength(2);
        expect(doc.education).toStrictEqual([
          EDUCATION[0],
          { school: 'City College', degree: '', date: 'May 2016' },
        ]);
      });
    }

    it('reads a bare resume that has no TAILORED RESUME heading', () => {
      const doc = parseLegacyMarkdown(RESUME, null);

      expect(doc.name).toBe('Alex Rivera');
      expect(doc.experience).toHaveLength(2);
    });
  });

  describe('target', () => {
    const titles: [name: string, title: string, target: ResumeDoc['target']][] = [
      [
        'a title ending in Resume Analysis',
        'Acme AI - ML Engineer Resume Analysis',
        { company: 'Acme AI', role: 'ML Engineer' },
      ],
      [
        'a title ending in - Resume Analysis',
        'Acme AI - ML Engineer - Resume Analysis',
        { company: 'Acme AI', role: 'ML Engineer' },
      ],
      [
        'a role that has its own dash',
        'Acme AI - Staff ML Engineer - Agents Resume Analysis',
        { company: 'Acme AI', role: 'Staff ML Engineer - Agents' },
      ],
      [
        'a hyphenated company',
        'Coca-Cola - Data Scientist Resume Analysis',
        { company: 'Coca-Cola', role: 'Data Scientist' },
      ],
      [
        'an en dash separator',
        'Acme AI – ML Engineer Resume Analysis',
        { company: 'Acme AI', role: 'ML Engineer' },
      ],
      ['no role', 'Acme AI Resume Analysis', { company: 'Acme AI', role: '' }],
    ];

    for (const [name, title, target] of titles) {
      it(`splits the reply chat title with ${name}`, () => {
        const reply = `# CHAT TITLE\n**${title}**\n\n${LEGACY}`;

        expect(parseLegacyMarkdown(reply, null).target).toStrictEqual(target);
      });
    }

    it('prefers the chat title in the reply over the fallback title', () => {
      const reply = `# CHAT TITLE\n**Acme AI - ML Engineer Resume Analysis**\n\n${LEGACY}`;

      expect(parseLegacyMarkdown(reply, 'Globex - Data Scientist').target).toStrictEqual({
        company: 'Acme AI',
        role: 'ML Engineer',
      });
    });

    it('uses the fallback title when the reply has no chat title', () => {
      expect(parseLegacyMarkdown(LEGACY, 'Globex - Data Scientist').target).toStrictEqual({
        company: 'Globex',
        role: 'Data Scientist',
      });
    });

    it('uses the fallback title when the reply chat title is empty', () => {
      const reply = `# CHAT TITLE\n**Resume Analysis**\n\n${LEGACY}`;

      expect(parseLegacyMarkdown(reply, 'Globex - Data Scientist').target).toStrictEqual({
        company: 'Globex',
        role: 'Data Scientist',
      });
    });

    it('leaves the target empty when there is no title at all', () => {
      expect(parseLegacyMarkdown(LEGACY, null).target).toStrictEqual({ company: '', role: '' });
    });
  });

  describe('errors', () => {
    it('reports text that has no resume section as missing', () => {
      const error = catchFormatError(() => parseLegacyMarkdown('Just some chatter.', null));

      expect(error.kind).toBe('missing');
      expect(error.message).toContain('TAILORED RESUME');
    });

    it('reports a resume without a name as invalid', () => {
      const error = catchFormatError(() => parseLegacyMarkdown('## TAILORED RESUME\n\nNo heading.\n', null));

      expect(error.kind).toBe('invalid');
      expect(error.message).toContain('name');
    });

    it('reports a resume without an Experience section as invalid', () => {
      const reply = '## TAILORED RESUME\n\n# Alex Rivera\n\n## Skills\n\n**Languages:** Python\n';

      const error = catchFormatError(() => parseLegacyMarkdown(reply, null));

      expect(error.kind).toBe('invalid');
      expect(error.message).toContain('Experience');
    });
  });
});
