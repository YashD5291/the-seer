import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBadgeStale, shouldDeliverAnalysis } from './stale-page.ts';

describe('shouldDeliverAnalysis', () => {
  it('delivers when the tab is still on the page the analysis was started on', () => {
    assert.equal(shouldDeliverAnalysis('https://jobs.test/1', 'https://jobs.test/1'), true);
  });

  it('delivers across a #fragment, a trailing slash and tracking parameters', () => {
    assert.equal(shouldDeliverAnalysis('https://jobs.test/1', 'https://jobs.test/1/?utm_source=x#apply'), true);
  });

  it('drops the analysis when the tab has moved to another job (SPA job board)', () => {
    assert.equal(
      shouldDeliverAnalysis('https://board.test/jobs?currentJobId=1', 'https://board.test/jobs?currentJobId=2'),
      false,
    );
  });

  it('drops the analysis when the tab has moved to another path', () => {
    assert.equal(shouldDeliverAnalysis('https://jobs.test/1', 'https://jobs.test/2'), false);
  });

  it('drops the analysis when the tab URL cannot be read', () => {
    assert.equal(shouldDeliverAnalysis('https://jobs.test/1', undefined), false);
  });
});

describe('isBadgeStale', () => {
  it('is stale when the tab moved to a different job than the stored one', () => {
    assert.equal(isBadgeStale('https://jobs.test/1', 'https://jobs.test/2'), true);
  });

  it('is not stale for a hash-only or tracking-only change', () => {
    assert.equal(isBadgeStale('https://jobs.test/1', 'https://jobs.test/1#apply'), false);
    assert.equal(isBadgeStale('https://jobs.test/1', 'https://jobs.test/1?trk=a'), false);
  });

  it('is not stale when there is no stored job URL to compare with', () => {
    assert.equal(isBadgeStale(undefined, 'https://jobs.test/2'), false);
  });
});
