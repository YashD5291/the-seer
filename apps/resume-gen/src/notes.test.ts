import { describe, expect, it } from 'bun:test';
import { resumeNotes } from './notes';
import type { ResumeDoc } from './resume-doc';
import { VALID, VALID_ANALYSIS, VALID_CHANGELOG } from './test-fixtures';

const WITH_NOTES: ResumeDoc = { ...VALID, analysis: VALID_ANALYSIS, changelog: VALID_CHANGELOG };

// The text between a heading and the next heading of the same level.
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`No "${heading}" section`);
  const end = markdown.indexOf('\n## ', start + heading.length + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

describe('resumeNotes', () => {
  it('gives nothing for a doc without an analysis or a changelog', () => {
    expect(resumeNotes(VALID)).toBeUndefined();
  });

  const notes = resumeNotes(WITH_NOTES) ?? '';

  it('names the posting and the starting resume at the top', () => {
    expect(notes.startsWith('# Acme AI - ML Engineer: resume notes\n')).toBe(true);
    expect(notes).toContain('Started from: gen-ai');
  });

  it('has the analysis sections in order, then the changelog', () => {
    const headings = notes.split('\n').filter((line) => line.startsWith('## '));

    expect(headings).toEqual([
      '## Role type',
      '## Company DNA',
      '## Role requirements',
      '## Gap analysis',
      '## Tone calibration',
      '## Changelog',
    ]);
  });

  it('gives the role type and the company DNA as written', () => {
    expect(section(notes, '## Role type')).toContain(VALID_ANALYSIS.role_type);
    expect(section(notes, '## Company DNA')).toContain(VALID_ANALYSIS.company_dna);
  });

  it('lists the seniority, must-haves, nice-to-haves and core problems', () => {
    const requirements = section(notes, '## Role requirements');

    expect(requirements).toContain('Seniority: Senior individual contributor');
    expect(requirements).toContain('Must-have:\n\n- 5+ years of ML engineering\n- Production RAG systems');
    expect(requirements).toContain('Nice-to-have:\n\n- Fine-tuning with DPO');
    expect(requirements).toContain('Core problems:\n\n- Answer customer questions from a large document store');
  });

  it('puts the gaps in a requirement, evidence, action table', () => {
    expect(section(notes, '## Gap analysis')).toContain(
      [
        '| Requirement | Evidence | Action |',
        '| --- | --- | --- |',
        '| Production RAG systems | Northwind Labs: RAG pipeline, 2M queries a month | Reframe existing |',
        '| Fine-tuning with DPO | NO MATCH | Skip |',
      ].join('\n'),
    );
  });

  it('keeps a pipe or a line break in a gap from breaking the table', () => {
    const gaps = [{ requirement: 'Go | Rust', evidence: 'Line one\nline two', action: 'Highlight related' }];
    const doc = { ...WITH_NOTES, analysis: { ...VALID_ANALYSIS, gaps } };

    expect(resumeNotes(doc)).toContain('| Go \\| Rust | Line one line two | Highlight related |');
  });

  it('gives each tone score out of 10, with what the ends of a two-sided scale mean', () => {
    const tone = section(notes, '## Tone calibration');

    expect(tone).toContain('- Technical depth: 8/10');
    expect(tone).toContain('- Culture emphasis: 4/10');
    expect(tone).toContain('- Formality: 5/10');
    expect(tone).toContain('- Innovation vs stability: 3/10 (1 = innovation, 10 = stability)');
    expect(tone).toContain('- Individual vs team: 6/10 (1 = individual, 10 = team)');
  });

  it('lists every changelog entry', () => {
    expect(section(notes, '## Changelog')).toContain(VALID_CHANGELOG.map((entry) => `- ${entry}`).join('\n'));
  });

  it('keeps a line break inside a list entry from breaking the list', () => {
    const doc = { ...WITH_NOTES, changelog: ['Summary: REPHRASE\n  of the old summary.'], analysis: undefined };

    expect(resumeNotes(doc)).toContain('\n- Summary: REPHRASE of the old summary.\n');
  });

  it('says "None" for an empty list', () => {
    const doc = { ...WITH_NOTES, analysis: { ...VALID_ANALYSIS, nice_to_haves: [], gaps: [] } };
    const empty = resumeNotes(doc) ?? '';

    expect(section(empty, '## Role requirements')).toContain('Nice-to-have:\n\nNone');
    expect(section(empty, '## Gap analysis')).toContain('None');
    expect(section(empty, '## Gap analysis')).not.toContain('| Requirement |');
  });

  it('has only the changelog when the analysis is missing', () => {
    const only = resumeNotes({ ...VALID, changelog: VALID_CHANGELOG }) ?? '';

    expect(only.split('\n').filter((line) => line.startsWith('## '))).toEqual(['## Changelog']);
  });

  it('has only the analysis when the changelog is missing', () => {
    const only = resumeNotes({ ...VALID, analysis: VALID_ANALYSIS }) ?? '';

    expect(only).toContain('## Tone calibration');
    expect(only).not.toContain('## Changelog');
  });

  it('ends with a single newline', () => {
    expect(notes.endsWith('\n')).toBe(true);
    expect(notes.endsWith('\n\n')).toBe(false);
  });
});
