import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSameJobPage, normalizeJobUrl } from './job-page.ts';

describe('normalizeJobUrl', () => {
  it('drops the #fragment', () => {
    assert.equal(normalizeJobUrl('https://jobs.test/1?gh_jid=7#apply'), 'https://jobs.test/1?gh_jid=7');
  });

  it('drops a trailing slash on the path', () => {
    assert.equal(normalizeJobUrl('https://jobs.test/jobs/view/123/'), normalizeJobUrl('https://jobs.test/jobs/view/123'));
  });

  it('treats the bare origin with and without a slash as one page', () => {
    assert.equal(normalizeJobUrl('https://jobs.test/'), normalizeJobUrl('https://jobs.test'));
  });

  it('drops every utm_ parameter', () => {
    assert.equal(
      normalizeJobUrl('https://jobs.test/1?utm_source=x&gh_jid=7&utm_medium=y&utm_campaign=z'),
      'https://jobs.test/1?gh_jid=7',
    );
  });

  it('drops the known tracking parameters', () => {
    const tracked = 'https://jobs.test/1?refId=a&trackingId=b&trk=c&trkInfo=d&lipi=e&eBP=f&src=g&ref=h&gh_jid=7';
    assert.equal(normalizeJobUrl(tracked), 'https://jobs.test/1?gh_jid=7');
  });

  it('keeps the parameters that pick the job', () => {
    assert.equal(normalizeJobUrl('https://board.test/jobs?currentJobId=1'), 'https://board.test/jobs?currentJobId=1');
  });

  it('sorts the remaining query parameters', () => {
    assert.equal(
      normalizeJobUrl('https://board.test/jobs?x=2&currentJobId=1'),
      normalizeJobUrl('https://board.test/jobs?currentJobId=1&x=2'),
    );
  });

  it('returns a URL that cannot be parsed unchanged', () => {
    assert.equal(normalizeJobUrl('not a url#frag'), 'not a url#frag');
  });
});

describe('isSameJobPage', () => {
  it('matches the same URL', () => {
    assert.equal(isSameJobPage('https://jobs.test/1', 'https://jobs.test/1'), true);
  });

  it('ignores the #fragment on either side', () => {
    assert.equal(isSameJobPage('https://jobs.test/1#top', 'https://jobs.test/1'), true);
    assert.equal(isSameJobPage('https://jobs.test/1', 'https://jobs.test/1#apply'), true);
  });

  it('tells apart pages that differ only in the query (SPA job boards)', () => {
    assert.equal(
      isSameJobPage('https://board.test/jobs?currentJobId=1', 'https://board.test/jobs?currentJobId=2'),
      false,
    );
  });

  it('tells apart different paths', () => {
    assert.equal(isSameJobPage('https://jobs.test/1', 'https://jobs.test/2'), false);
  });

  it('matches a LinkedIn job URL with and without tracking parameters', () => {
    assert.equal(
      isSameJobPage('https://www.linkedin.com/jobs/view/123/?refId=a&trackingId=b', 'https://www.linkedin.com/jobs/view/123'),
      true,
    );
  });

  it('ignores the order of query parameters', () => {
    assert.equal(
      isSameJobPage('https://board.test/jobs?currentJobId=1&x=2', 'https://board.test/jobs?x=2&currentJobId=1'),
      true,
    );
  });
});
