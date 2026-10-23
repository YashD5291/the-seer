import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHostMessage } from './host-protocol.ts';

const resultMessage = {
  type: 'result',
  success: true,
  folderName: 'Acme - ML Engineer',
  folderPath: '/out/Acme - ML Engineer',
  texPath: '/out/Acme - ML Engineer/resume.tex',
  pdfPath: '/out/Acme - ML Engineer/resume.pdf',
  uploadPdfPath: '/out/Acme - ML Engineer/Alex_Rivera_Resume.pdf',
  pages: 1,
  fits: true,
  trimmedBullets: 2,
  latexSource: '\\documentclass{article}',
  pdfBase64: 'JVBERi0=',
  pdfSizeBytes: 5,
  resumeText: 'Alex Rivera',
  keywords: ['python', 'pytorch'],
};

describe('isHostMessage progress', () => {
  it('accepts every known stage', () => {
    for (const stage of ['checking-login', 'scoring', 'writing', 'compiling', 'fitting']) {
      assert.equal(isHostMessage({ type: 'progress', stage }), true, stage);
    }
  });

  it('rejects an unknown or non-string stage', () => {
    assert.equal(isHostMessage({ type: 'progress', stage: 'sleeping' }), false);
    assert.equal(isHostMessage({ type: 'progress', stage: 3 }), false);
    assert.equal(isHostMessage({ type: 'progress' }), false);
  });
});

describe('isHostMessage result', () => {
  it('accepts a complete result', () => {
    assert.equal(isHostMessage(resultMessage), true);
  });

  it('accepts a result with an empty keyword list', () => {
    assert.equal(isHostMessage({ ...resultMessage, keywords: [] }), true);
  });

  it('rejects success other than true', () => {
    assert.equal(isHostMessage({ ...resultMessage, success: false }), false);
  });

  it('rejects a result missing any required field', () => {
    for (const field of Object.keys(resultMessage)) {
      if (field === 'type') continue;
      const { [field]: _removed, ...rest } = resultMessage as Record<string, unknown>;
      assert.equal(isHostMessage(rest), false, `missing ${field}`);
    }
  });

  it('rejects wrongly typed fields', () => {
    const wrong: Record<string, unknown> = {
      folderName: 1,
      folderPath: null,
      texPath: 1,
      pdfPath: 1,
      uploadPdfPath: 1,
      latexSource: 1,
      pdfBase64: 1,
      resumeText: 1,
      pages: '1',
      trimmedBullets: '2',
      pdfSizeBytes: '5',
      fits: 'yes',
      keywords: 'python',
    };
    for (const [field, value] of Object.entries(wrong)) {
      assert.equal(isHostMessage({ ...resultMessage, [field]: value }), false, field);
    }
  });

  it('rejects keywords that are not all strings', () => {
    assert.equal(isHostMessage({ ...resultMessage, keywords: ['python', 3] }), false);
  });
});

describe('isHostMessage error', () => {
  it('accepts an error with and without details', () => {
    assert.equal(isHostMessage({ type: 'error', error: 'Not logged in' }), true);
    assert.equal(isHostMessage({ type: 'error', error: 'Failed', details: 'stderr' }), true);
  });

  it('rejects a missing error message or non-string details', () => {
    assert.equal(isHostMessage({ type: 'error' }), false);
    assert.equal(isHostMessage({ type: 'error', error: 5 }), false);
    assert.equal(isHostMessage({ type: 'error', error: 'x', details: 5 }), false);
  });

  it('accepts an error that says the fix is on the setup page', () => {
    assert.equal(isHostMessage({ type: 'error', error: 'No readable files', needsSetup: true }), true);
    assert.equal(isHostMessage({ type: 'error', error: 'x', details: 'y', needsSetup: false }), true);
  });

  it('rejects a needsSetup that is not a boolean', () => {
    assert.equal(isHostMessage({ type: 'error', error: 'x', needsSetup: 'yes' }), false);
    assert.equal(isHostMessage({ type: 'error', error: 'x', needsSetup: 1 }), false);
    assert.equal(isHostMessage({ type: 'error', error: 'x', needsSetup: null }), false);
  });
});

const analysis = {
  fit_score: 72,
  confidence: 80,
  recommended_base: 'mle',
  base_reasoning: 'Production ML focus',
  key_matches: ['PyTorch'],
  gaps: ['Go'],
  gap_mitigation: ['Mention Rust services'],
  tailoring_priorities: ['Lead with MLOps'],
  ats_keywords: ['PyTorch', 'Kubernetes'],
  red_flags: [],
  estimated_competition: 'medium',
  apply_recommendation: 'yes',
};

const jobFacts = {
  title: 'ML Engineer',
  company: 'Acme',
  location: 'Remote',
  salary_range: '$150k',
  job_type: 'Full-time',
  requirements: ['Python'],
  nice_to_haves: [],
};

const scoreMessage = { type: 'score', analysis, job: jobFacts };

describe('isHostMessage score', () => {
  it('accepts a complete score', () => {
    assert.equal(isHostMessage(scoreMessage), true);
  });

  it('accepts any non-empty base id (the host profile defines them)', () => {
    const custom = { ...scoreMessage, analysis: { ...analysis, recommended_base: 'data-eng' } };
    assert.equal(isHostMessage(custom), true);
  });

  it('rejects an empty base id', () => {
    const empty = { ...scoreMessage, analysis: { ...analysis, recommended_base: '' } };
    assert.equal(isHostMessage(empty), false);
  });

  it('accepts a job without the optional facts', () => {
    const { location: _l, salary_range: _s, job_type: _t, ...required } = jobFacts;
    assert.equal(isHostMessage({ ...scoreMessage, job: required }), true);
  });

  it('rejects optional job facts that are not strings', () => {
    for (const field of ['location', 'salary_range', 'job_type']) {
      assert.equal(isHostMessage({ ...scoreMessage, job: { ...jobFacts, [field]: 3 } }), false, field);
    }
  });

  it('rejects an analysis missing any field', () => {
    for (const field of Object.keys(analysis)) {
      const { [field]: _removed, ...rest } = analysis as Record<string, unknown>;
      assert.equal(isHostMessage({ ...scoreMessage, analysis: rest }), false, `missing ${field}`);
    }
  });

  it('rejects a job missing any required fact', () => {
    for (const field of ['title', 'company', 'requirements', 'nice_to_haves']) {
      const { [field]: _removed, ...rest } = jobFacts as Record<string, unknown>;
      assert.equal(isHostMessage({ ...scoreMessage, job: rest }), false, `missing ${field}`);
    }
  });

  it('rejects wrongly typed analysis fields', () => {
    const wrong: Record<string, unknown> = {
      fit_score: '72',
      confidence: null,
      recommended_base: 3,
      base_reasoning: 1,
      key_matches: 'PyTorch',
      gaps: [1],
      gap_mitigation: null,
      tailoring_priorities: {},
      ats_keywords: ['ok', 2],
      red_flags: 'none',
      estimated_competition: 'extreme',
      apply_recommendation: 'definitely',
    };
    for (const [field, value] of Object.entries(wrong)) {
      assert.equal(isHostMessage({ ...scoreMessage, analysis: { ...analysis, [field]: value } }), false, field);
    }
  });

  it('rejects wrongly typed job facts', () => {
    const wrong: Record<string, unknown> = { title: 1, company: null, requirements: 'Python', nice_to_haves: [2] };
    for (const [field, value] of Object.entries(wrong)) {
      assert.equal(isHostMessage({ ...scoreMessage, job: { ...jobFacts, [field]: value } }), false, field);
    }
  });

  it('rejects a missing or non-object analysis or job', () => {
    assert.equal(isHostMessage({ type: 'score', job: jobFacts }), false);
    assert.equal(isHostMessage({ type: 'score', analysis }), false);
    assert.equal(isHostMessage({ type: 'score', analysis: [], job: jobFacts }), false);
    assert.equal(isHostMessage({ type: 'score', analysis, job: 'Acme' }), false);
  });
});

describe('isHostMessage skipped', () => {
  it('accepts a score and threshold', () => {
    assert.equal(isHostMessage({ type: 'skipped', score: 32, threshold: 40 }), true);
  });

  it('rejects a missing or non-numeric score or threshold', () => {
    assert.equal(isHostMessage({ type: 'skipped', threshold: 40 }), false);
    assert.equal(isHostMessage({ type: 'skipped', score: 32 }), false);
    assert.equal(isHostMessage({ type: 'skipped', score: '32', threshold: 40 }), false);
    assert.equal(isHostMessage({ type: 'skipped', score: 32, threshold: '40' }), false);
  });
});

describe('isHostMessage other values', () => {
  it('rejects non-objects and unknown types', () => {
    for (const value of [null, undefined, 'result', 7, [], { type: 'ping' }, {}]) {
      assert.equal(isHostMessage(value), false);
    }
  });
});
