import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MISSING_SHOWN,
  errorStatus,
  errorToastText,
  plural,
  readyStatus,
  readySummary,
  skippedStatus,
  workingStatus,
} from './resume-status.ts';
import type { PdfReadyMessage } from './types.ts';

function readyMessage(overrides: Partial<PdfReadyMessage> = {}): PdfReadyMessage {
  return {
    type: 'SEER_PDF_READY',
    jobId: 'job-1',
    jobUrl: 'https://jobs.test/1',
    pdfPath: '/out/Acme/resume.pdf',
    folderName: 'Acme',
    pages: 1,
    fits: true,
    trimmedBullets: 0,
    maxPages: 1,
    ...overrides,
  };
}

describe('plural', () => {
  it('uses the singular for one and the plural otherwise', () => {
    assert.equal(plural(1, 'page'), '1 page');
    assert.equal(plural(0, 'page'), '0 pages');
    assert.equal(plural(2, 'page'), '2 pages');
  });

  it('groups the digits of large counts', () => {
    assert.equal(plural(12345, 'word'), '12,345 words');
  });
});

describe('readySummary', () => {
  it('counts pages, singular for one', () => {
    assert.equal(readySummary(1), 'Resume ready · 1 page');
  });

  it('counts pages, plural otherwise', () => {
    assert.equal(readySummary(2), 'Resume ready · 2 pages');
  });

  it('adds the keyword count when the resume was scored', () => {
    assert.equal(readySummary(2, { matched: 9, total: 12 }), 'Resume ready · 2 pages · 9/12 keywords');
  });

  it('adds the trimmed bullet count, singular for one', () => {
    assert.equal(readySummary(1, undefined, 1), 'Resume ready · 1 page · trimmed 1 bullet');
  });

  it('adds the trimmed bullet count after the keywords, plural otherwise', () => {
    assert.equal(
      readySummary(2, { matched: 9, total: 12 }, 3),
      'Resume ready · 2 pages · 9/12 keywords · trimmed 3 bullets',
    );
  });

  it('leaves the trim out when no bullet was trimmed', () => {
    assert.equal(readySummary(1, undefined, 0), 'Resume ready · 1 page');
  });
});

describe('workingStatus', () => {
  it('labels every writer stage', () => {
    assert.equal(workingStatus('checking-login').text, 'Checking Claude login…');
    assert.equal(workingStatus('scoring').text, 'Scoring fit…');
    assert.equal(workingStatus('writing').text, 'Writing resume…');
    assert.equal(workingStatus('compiling').text, 'Building PDF…');
    assert.equal(workingStatus('fitting').text, 'Fitting to page budget…');
  });

  it('is a working state', () => {
    assert.equal(workingStatus('writing').state, 'working');
  });
});

describe('readyStatus', () => {
  it('shows the page count when there is no score', () => {
    assert.deepEqual(readyStatus(readyMessage({ pages: 2, maxPages: 2 })), {
      state: 'ready',
      text: 'Resume ready · 2 pages',
      note: null,
      missing: [],
      moreMissing: 0,
    });
  });

  it('shows the keyword count and the missing keywords', () => {
    const status = readyStatus(
      readyMessage({ coverage: { matched: 2, total: 4, pct: 50, missing: ['Go', 'Rust'] } }),
    );
    assert.equal(status.text, 'Resume ready · 1 page · 2/4 keywords');
    assert.deepEqual(status.missing, ['Go', 'Rust']);
    assert.equal(status.moreMissing, 0);
  });

  it('lists at most 12 missing keywords and counts the rest', () => {
    const missing = Array.from({ length: 15 }, (_, i) => `kw${i}`);
    const status = readyStatus(readyMessage({ coverage: { matched: 5, total: 20, pct: 25, missing } }));
    assert.equal(MAX_MISSING_SHOWN, 12);
    assert.deepEqual(status.missing, missing.slice(0, 12));
    assert.equal(status.moreMissing, 3);
  });

  it('lists exactly 12 missing keywords without a "more" count', () => {
    const missing = Array.from({ length: 12 }, (_, i) => `kw${i}`);
    const status = readyStatus(readyMessage({ coverage: { matched: 1, total: 13, pct: 8, missing } }));
    assert.equal(status.missing.length, 12);
    assert.equal(status.moreMissing, 0);
  });

  it('says so when the resume did not fit the page budget', () => {
    const status = readyStatus(readyMessage({ pages: 2, fits: false, trimmedBullets: 3, maxPages: 1 }));
    assert.equal(status.note, "Couldn't fit 1 page; trimmed 3 bullets");
  });

  it('uses the singular for one trimmed bullet and the plural for two pages', () => {
    const status = readyStatus(readyMessage({ pages: 3, fits: false, trimmedBullets: 1, maxPages: 2 }));
    assert.equal(status.note, "Couldn't fit 2 pages; trimmed 1 bullet");
  });

  it('has no note when the resume fits without trimming', () => {
    assert.equal(readyStatus(readyMessage({ fits: true, trimmedBullets: 0 })).note, null);
  });

  it('says how many bullets were trimmed to make the resume fit', () => {
    assert.equal(readyStatus(readyMessage({ fits: true, trimmedBullets: 2 })).note, 'Trimmed 2 bullets to fit');
  });

  it('uses the singular for one bullet trimmed to fit', () => {
    assert.equal(readyStatus(readyMessage({ fits: true, trimmedBullets: 1 })).note, 'Trimmed 1 bullet to fit');
  });
});

describe('errorStatus', () => {
  it('shows the error', () => {
    assert.deepEqual(errorStatus('Compile failed'), {
      state: 'error',
      text: 'Resume failed: Compile failed',
      note: null,
      missing: [],
      moreMissing: 0,
    });
  });
});

describe('skippedStatus', () => {
  it('says the fit score is below the threshold and no resume was written', () => {
    assert.deepEqual(skippedStatus(39, 40), {
      state: 'skipped',
      text: 'Fit 39/100 is below 40 — no resume written.',
      note: null,
      missing: [],
      moreMissing: 0,
    });
  });
});

describe('errorToastText', () => {
  it('is the error alone without details', () => {
    assert.equal(errorToastText('Compile failed'), 'Compile failed');
    assert.equal(errorToastText('Compile failed', ''), 'Compile failed');
  });

  it('adds the first line of the details', () => {
    assert.equal(
      errorToastText('Compile failed', "! Undefined control sequence.\nl.42 \\foo\nmore"),
      'Compile failed — ! Undefined control sequence.',
    );
  });

  it('skips leading blank lines and trims the line', () => {
    assert.equal(errorToastText('Compile failed', '\r\n  \n  tectonic exited 1  \nnext'), 'Compile failed — tectonic exited 1');
  });

  it('is the error alone when the details are only whitespace', () => {
    assert.equal(errorToastText('Compile failed', ' \n \n'), 'Compile failed');
  });
});
