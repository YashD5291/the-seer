import { type ResumeAnalysis, type ResumeDoc, TONE_SCALES, type ToneScores } from './resume-doc';

// notes.md: the writer's analysis of the posting and its changelog, as Markdown the person reads next to the PDF.

export const NOTES_FILE = 'notes.md';

// What 1 and 10 mean is spelled out for the two-sided scales.
const TONE_LABELS: Record<keyof ToneScores, { label: string; ends?: string }> = {
  technical_depth: { label: 'Technical depth' },
  culture_emphasis: { label: 'Culture emphasis' },
  formality: { label: 'Formality' },
  innovation_vs_stability: { label: 'Innovation vs stability', ends: '1 = innovation, 10 = stability' },
  individual_vs_team: { label: 'Individual vs team', ends: '1 = individual, 10 = team' },
};

// The notes for a doc, or undefined when the reply had neither an analysis nor a changelog.
export function resumeNotes(doc: ResumeDoc): string | undefined {
  const { analysis, changelog } = doc;
  if (analysis === undefined && changelog === undefined) return undefined;
  const blocks = [
    `# ${doc.target.company} - ${doc.target.role}: resume notes`,
    `Started from: ${doc.base}`,
    ...(analysis === undefined ? [] : analysisBlocks(analysis)),
    ...(changelog === undefined ? [] : ['## Changelog', bulletList(changelog)]),
  ];
  return `${blocks.join('\n\n')}\n`;
}

function analysisBlocks(analysis: ResumeAnalysis): string[] {
  return [
    '## Role type',
    analysis.role_type,
    '## Company DNA',
    analysis.company_dna,
    '## Role requirements',
    `Seniority: ${analysis.seniority}`,
    `Must-have:\n\n${bulletList(analysis.must_haves)}`,
    `Nice-to-have:\n\n${bulletList(analysis.nice_to_haves)}`,
    `Core problems:\n\n${bulletList(analysis.core_problems)}`,
    '## Gap analysis',
    gapTable(analysis.gaps),
    '## Tone calibration',
    toneList(analysis.tone),
  ];
}

function bulletList(items: string[]): string {
  return items.length === 0 ? 'None' : items.map((item) => `- ${item}`).join('\n');
}

function gapTable(gaps: ResumeAnalysis['gaps']): string {
  if (gaps.length === 0) return 'None';
  const rows = gaps.map((gap) => `| ${cell(gap.requirement)} | ${cell(gap.evidence)} | ${cell(gap.action)} |`);
  return ['| Requirement | Evidence | Action |', '| --- | --- | --- |', ...rows].join('\n');
}

// A pipe would end the cell and a line break the row, so both are neutralised.
function cell(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '\\|');
}

function toneList(tone: ToneScores): string {
  return TONE_SCALES.map((scale) => {
    const { label, ends } = TONE_LABELS[scale];
    return `- ${label}: ${tone[scale]}/10${ends === undefined ? '' : ` (${ends})`}`;
  }).join('\n');
}
