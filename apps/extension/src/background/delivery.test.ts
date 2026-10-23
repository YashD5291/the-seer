import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  expiredResumeNotice,
  failedNotificationId,
  failureNotice,
  fileUrlFor,
  MAX_EDITOR_JOBS,
  parseNotificationId,
  readyDelivery,
  readyNotificationId,
  resumeCoverage,
  resumeOpenAction,
  retainRecentJobs,
} from './delivery.ts';
import type { JobRef } from './job-runner.ts';
import type { WriteResult } from '../shared/host-protocol.ts';
import type { FitAnalysis } from '../shared/types.ts';

describe('retainRecentJobs', () => {
  it('keeps 20 jobs', () => {
    assert.equal(MAX_EDITOR_JOBS, 20);
  });

  it('adds the new job last', () => {
    assert.deepEqual(retainRecentJobs(['a', 'b'], 'c'), { kept: ['a', 'b', 'c'], dropped: [] });
  });

  it('drops the oldest jobs beyond the limit', () => {
    assert.deepEqual(retainRecentJobs(['a', 'b', 'c'], 'd', 2), { kept: ['c', 'd'], dropped: ['a', 'b'] });
  });

  it('moves a job that is already listed to the end instead of listing it twice', () => {
    assert.deepEqual(retainRecentJobs(['a', 'b', 'c'], 'a', 3), { kept: ['b', 'c', 'a'], dropped: [] });
  });

  it('keeps the newest 20 by default', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `job-${i}`);
    const { kept, dropped } = retainRecentJobs(ids, 'job-20');
    assert.equal(kept.length, 20);
    assert.equal(kept[19], 'job-20');
    assert.deepEqual(dropped, ['job-0']);
  });
});

describe('failureNotice', () => {
  it('titles the notice with company and role when both are known', () => {
    assert.deepEqual(failureNotice({ company: 'Acme', title: 'ML Engineer' }, 'Compile failed'), {
      title: 'Acme — ML Engineer',
      message: 'Resume failed — Compile failed',
    });
  });

  it('uses whichever of company or role is known', () => {
    assert.equal(failureNotice({ company: 'Acme', title: '' }, 'x').title, 'Acme');
    assert.equal(failureNotice({ company: '', title: 'ML Engineer' }, 'x').title, 'ML Engineer');
  });

  it("falls back to 'The Seer' when nothing is known", () => {
    assert.equal(failureNotice(null, 'x').title, 'The Seer');
    assert.equal(failureNotice({ company: '', title: '' }, 'x').title, 'The Seer');
  });

  it('cuts a long error to 150 characters, ending with an ellipsis', () => {
    const { message } = failureNotice(null, 'e'.repeat(400));
    assert.equal(message.length, 150);
    assert.ok(message.startsWith('Resume failed — eee'));
    assert.ok(message.endsWith('…'));
  });

  it('keeps a message of exactly 150 characters whole', () => {
    const error = 'e'.repeat(150 - 'Resume failed — '.length);
    assert.equal(failureNotice(null, error).message, `Resume failed — ${error}`);
  });
});

const JOB: JobRef = { tabId: 4, jobId: 'job-1', jobUrl: 'https://jobs.test/1', maxPages: 1 };

function writeResult(overrides: Partial<WriteResult> = {}): WriteResult {
  return {
    success: true,
    folderName: 'Acme_ML_Engineer',
    folderPath: '/out/Acme_ML_Engineer',
    texPath: '/out/Acme_ML_Engineer/resume.tex',
    pdfPath: '/out/Acme_ML_Engineer/resume.pdf',
    uploadPdfPath: '/out/Acme_ML_Engineer/Alex_Rivera_Resume.pdf',
    pages: 1,
    fits: true,
    trimmedBullets: 0,
    latexSource: '\\documentclass{article}',
    pdfBase64: 'UERG',
    pdfSizeBytes: 3,
    resumeText: 'Built CI/CD for PyTorch models in C++',
    keywords: [],
    ...overrides,
  };
}

function analysisWith(atsKeywords: string[]): FitAnalysis {
  return {
    fit_score: 80,
    confidence: 0.9,
    recommended_base: 'mle',
    base_reasoning: '',
    key_matches: [],
    gaps: [],
    gap_mitigation: [],
    tailoring_priorities: [],
    ats_keywords: atsKeywords,
    red_flags: [],
    estimated_competition: 'low',
    apply_recommendation: 'yes',
  };
}

describe('resumeCoverage', () => {
  it('scores the resume text against the scorer\'s ATS keywords', () => {
    assert.deepEqual(resumeCoverage('Built CI/CD for PyTorch models', analysisWith(['ci/cd', 'pytorch', 'Go'])), {
      matched: 2,
      total: 3,
      pct: 67,
      missing: ['Go'],
    });
  });

  it('is null without an analysis', () => {
    assert.equal(resumeCoverage('anything', null), null);
  });

  it('is null when the scorer found no keywords', () => {
    assert.equal(resumeCoverage('anything', analysisWith([])), null);
  });
});

describe('readyDelivery', () => {
  it('tells the tab about the finished resume, with the keyword coverage', () => {
    const { message } = readyDelivery(JOB, writeResult({ pages: 2, fits: false, trimmedBullets: 3 }), analysisWith(['pytorch', 'Go']));
    assert.deepEqual(message, {
      type: 'SEER_PDF_READY',
      jobId: 'job-1',
      jobUrl: 'https://jobs.test/1',
      pdfPath: '/out/Acme_ML_Engineer/resume.pdf',
      folderName: 'Acme_ML_Engineer',
      pages: 2,
      fits: false,
      trimmedBullets: 3,
      maxPages: 1,
      coverage: { matched: 1, total: 2, pct: 50, missing: ['Go'] },
    });
  });

  it('omits the coverage without an analysis', () => {
    const { message } = readyDelivery(JOB, writeResult(), null);
    assert.equal('coverage' in message, false);
  });

  it('notifies with the page count and the keyword count', () => {
    const { notificationText } = readyDelivery(JOB, writeResult({ pages: 2 }), analysisWith(['ci/cd', 'pytorch', 'Go']));
    assert.equal(notificationText, 'Resume ready · 2 pages · 2/3 keywords — click to open');
  });

  it('notifies with the page count alone without an analysis', () => {
    assert.equal(readyDelivery(JOB, writeResult({ pages: 1 }), null).notificationText, 'Resume ready · 1 page — click to open');
  });

  it('notifies how many bullets were trimmed, singular for one', () => {
    assert.equal(
      readyDelivery(JOB, writeResult({ pages: 1, trimmedBullets: 1 }), null).notificationText,
      'Resume ready · 1 page · trimmed 1 bullet — click to open',
    );
  });

  it('notifies how many bullets were trimmed after the keyword count, plural otherwise', () => {
    assert.equal(
      readyDelivery(JOB, writeResult({ pages: 2, trimmedBullets: 4 }), analysisWith(['ci/cd', 'pytorch', 'Go'])).notificationText,
      'Resume ready · 2 pages · 2/3 keywords · trimmed 4 bullets — click to open',
    );
  });

  it('notifies with the page count alone when the scorer found no keywords', () => {
    assert.equal(
      readyDelivery(JOB, writeResult({ pages: 1 }), analysisWith([])).notificationText,
      'Resume ready · 1 page — click to open',
    );
  });
});

describe('expiredResumeNotice', () => {
  it('points the user to the output folder when the PDF path is unknown', () => {
    assert.deepEqual(expiredResumeNotice(), {
      title: 'The Seer',
      message: 'This resume is no longer in this session — find it in your output folder.',
    });
  });

  it("names the PDF's folder when the PDF path is known", () => {
    assert.deepEqual(expiredResumeNotice('/Users/me/Resumes/Acme - ML Engineer/resume.pdf'), {
      title: 'The Seer',
      message: 'This resume is no longer in this session — open it from /Users/me/Resumes/Acme - ML Engineer',
    });
  });
});

describe('fileUrlFor', () => {
  it('percent-encodes each path segment and keeps the slashes', () => {
    assert.equal(fileUrlFor('/a b/C# Lab - x.pdf'), 'file:///a%20b/C%23%20Lab%20-%20x.pdf');
  });

  it('encodes ? and % so they stay part of the file name', () => {
    assert.equal(fileUrlFor('/out/100% sure?.pdf'), 'file:///out/100%25%20sure%3F.pdf');
  });

  it('leaves a plain path as it is', () => {
    assert.equal(fileUrlFor('/out/Acme_ML_Engineer/resume.pdf'), 'file:///out/Acme_ML_Engineer/resume.pdf');
  });
});

describe('notification ids', () => {
  it('names the ready notification seer-<jobId>', () => {
    assert.equal(readyNotificationId('abc'), 'seer-abc');
  });

  it('names the failure notification seer-failed-<jobId>, apart from the ready one', () => {
    assert.equal(failedNotificationId('abc'), 'seer-failed-abc');
    assert.notEqual(failedNotificationId('abc'), readyNotificationId('abc'));
  });

  it('tells a ready notification from a failure notification', () => {
    assert.deepEqual(parseNotificationId('seer-abc'), { kind: 'ready', jobId: 'abc' });
    assert.deepEqual(parseNotificationId('seer-failed-abc'), { kind: 'failed', jobId: 'abc' });
  });

  it('reads back the ids it makes, for a real job id', () => {
    const jobId = '0b8f1c3e-5d2a-4e8b-9a7c-1f2e3d4c5b6a';
    assert.deepEqual(parseNotificationId(readyNotificationId(jobId)), { kind: 'ready', jobId });
    assert.deepEqual(parseNotificationId(failedNotificationId(jobId)), { kind: 'failed', jobId });
  });

  it('ignores ids that are not the Seer\'s or have no job id', () => {
    assert.equal(parseNotificationId('other-abc'), null);
    assert.equal(parseNotificationId('seer-'), null);
    assert.equal(parseNotificationId('seer-failed-'), null);
    assert.equal(parseNotificationId(''), null);
  });
});

describe('resumeOpenAction', () => {
  it('opens the editor while the resume is stored, even when the PDF path is known', () => {
    assert.equal(resumeOpenAction(true, '/out/resume.pdf'), 'editor');
    assert.equal(resumeOpenAction(true, undefined), 'editor');
  });

  it('opens the PDF file when the resume is gone but its path is known', () => {
    assert.equal(resumeOpenAction(false, '/out/resume.pdf'), 'file');
  });

  it('tells the user when the resume is gone and there is no PDF path to open', () => {
    assert.equal(resumeOpenAction(false, undefined), 'notice');
    assert.equal(resumeOpenAction(false, ''), 'notice');
  });
});
