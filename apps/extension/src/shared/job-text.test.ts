import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { htmlToText, pickJobText } from './job-text.ts';
import type { ExtractionResult, JobData } from './types.ts';

function jobWithDescription(description: string): JobData {
  return { title: 'Staff ML Engineer', company: 'Tifin', description, requirements: [], nice_to_haves: [] };
}

function extractionOf(overrides: Partial<ExtractionResult>): ExtractionResult {
  return {
    success: true,
    jobData: null,
    rawText: '',
    jsonLd: null,
    url: 'https://jobs.example/1',
    pageTitle: 'Staff ML Engineer',
    extractionMethod: 'page-text',
    ...overrides,
  };
}

describe('htmlToText', () => {
  it('turns block tags into lines and decodes entities', () => {
    assert.equal(htmlToText('<p>A &amp; B</p><ul><li>x</li><li>y</li></ul>'), 'A & B\nx\ny');
  });

  it('breaks lines on br, headings, divs, table rows and ordered lists', () => {
    const html = '<h2>Role</h2><div>Line one<br/>Line two</div><table><tr><td>cell</td></tr></table><ol><li>first</li></ol>';
    assert.equal(htmlToText(html), 'Role\nLine one\nLine two\ncell\nfirst');
  });

  it('keeps table cells on separate lines', () => {
    assert.equal(htmlToText('<table><tr><td>Salary</td><td>$100k</td></tr><tr><th>Team</th><th>ML</th></tr></table>'), 'Salary\n$100k\nTeam\nML');
  });

  it('breaks lines on section, article, pre, blockquote, hr and definition lists', () => {
    const html = '<section>one</section><article>two</article><pre>three</pre><blockquote>four</blockquote>five<hr/>six<dl><dt>term</dt><dd>meaning</dd></dl>';
    assert.equal(htmlToText(html), 'one\ntwo\nthree\nfour\nfive\nsix\nterm\nmeaning');
  });

  it('drops script and style bodies', () => {
    const html = '<style>.x { color: red; }</style><p>Role</p><script type="text/javascript">var a = "<b>";\nalert(1)</script><p>Details</p>';
    assert.equal(htmlToText(html), 'Role\nDetails');
  });

  it('drops HTML comments, including markup inside them', () => {
    const html = '<p>Role</p><!-- if a > b <div>hidden</div> --><p>Details</p><!---->';
    assert.equal(htmlToText(html), 'Role\nDetails');
  });

  it('drops noscript bodies', () => {
    const html = '<p>Role</p><noscript><p>Please enable JavaScript</p></noscript><p>Details</p>';
    assert.equal(htmlToText(html), 'Role\nDetails');
  });

  it('keeps inline tags inside their line', () => {
    assert.equal(htmlToText('<p>Build <b>RAG</b> pipelines with <a href="https://x.example">Python</a></p>'), 'Build RAG pipelines with Python');
  });

  it('decodes the named entities', () => {
    assert.equal(htmlToText('&lt;b&gt; &quot;quoted&quot; it&#39;s&nbsp;fine &amp; done'), '<b> "quoted" it\'s fine & done');
  });

  it('decodes the common typographic entities', () => {
    const html = '&lsquo;a&rsquo; &ldquo;b&rdquo; 2020&ndash;2024 &mdash; &bull; wait&hellip; &copy; &reg; &trade;';
    assert.equal(htmlToText(html), '\u2018a\u2019 \u201cb\u201d 2020\u20132024 \u2014 \u2022 wait\u2026 \u00a9 \u00ae \u2122');
  });

  it('decodes numeric entities, decimal and hex', () => {
    assert.equal(htmlToText('caf&#233; &#x2014; &#X41;'), 'café — A');
  });

  it('leaves unknown and invalid entities as written', () => {
    assert.equal(htmlToText('a &unknown; b &#99999999999; c'), 'a &unknown; b &#99999999999; c');
  });

  it('decodes once, so an escaped entity is not decoded twice', () => {
    assert.equal(htmlToText('&amp;lt;'), '&lt;');
  });

  it('does not turn escaped markup into tags', () => {
    assert.equal(htmlToText('<p>use &lt;div&gt; sparingly</p>'), 'use <div> sparingly');
  });

  it('collapses runs of spaces, trims lines and drops empty lines', () => {
    assert.equal(htmlToText('<p>  lots   of \t space  </p>\n\n<p>   </p><p>next</p>'), 'lots of space\nnext');
  });

  it('collapses non-breaking spaces and nothing else', () => {
    assert.equal(htmlToText('<p>\u00a0Build\u00a0\u00a0aura0 \\u\u00a0</p>'), 'Build aura0 \\u');
  });

  it('returns plain text unchanged apart from whitespace tidying', () => {
    assert.equal(htmlToText('Title: ML Engineer\n\nCompany: Tifin'), 'Title: ML Engineer\nCompany: Tifin');
  });

  it('returns an empty string for empty input', () => {
    assert.equal(htmlToText(''), '');
  });
});

describe('pickJobText', () => {
  it('uses the job data description, not the whole-page HTML in rawText', () => {
    const extraction = extractionOf({
      jobData: jobWithDescription('Build RAG pipelines & evals'),
      rawText: '<nav>Menu</nav><div>' + 'page chrome '.repeat(50) + '</div>',
      extractionMethod: 'json-ld',
    });
    const text = pickJobText({ extraction, iframeTexts: [] });
    assert.equal(text, 'Build RAG pipelines & evals');
  });

  it('keeps literal angle brackets in a plain-text description', () => {
    const description = 'Latency <100ms and QPS >1k required.\nWe use Map<String, Object> and List<Integer>.';
    const extraction = extractionOf({ jobData: jobWithDescription(description), extractionMethod: 'json-ld' });
    assert.equal(pickJobText({ extraction, iframeTexts: [] }), description);
  });

  it('uses the page text as-is when the scraper found text but no job data', () => {
    const rawText = 'Title: ML Engineer\nLatency <100ms and Map<String, Object> support\nBuild things';
    const extraction = extractionOf({ rawText, success: true, jobData: null });
    assert.equal(pickJobText({ extraction, iframeTexts: [] }), rawText);
  });

  it('turns the page HTML into text when the scraper failed (iframe-only page)', () => {
    const nested = '<div><span><a href="https://example.com/some/long/path">Menu</a></span></div>'.repeat(30);
    const extraction = extractionOf({
      success: false,
      jobData: null,
      rawText: nested,
      extractionMethod: 'none',
      iframeUrls: ['https://boards.greenhouse.io/embed/job_app?for=x'],
    });
    const iframeText = 'Staff ML Engineer\nBuild RAG pipelines.\n' + 'Responsibilities. '.repeat(15);
    assert.ok(nested.length > iframeText.length);
    const text = pickJobText({ extraction, iframeTexts: [iframeText] });
    assert.ok(!text.includes('<div'));
    assert.equal(text, iframeText);
  });

  it('falls back to the page HTML as text when a failed scrape has nothing else', () => {
    const extraction = extractionOf({ success: false, jobData: null, rawText: '<div><p>Only this</p></div>', extractionMethod: 'none' });
    assert.equal(pickJobText({ extraction, iframeTexts: [] }), 'Only this');
  });

  it('prefers the longest iframe text over shorter candidates', () => {
    const extraction = extractionOf({ rawText: 'tiny' });
    const iframeTexts = ['short iframe', 'the longest iframe text of them all', 'medium iframe text'];
    assert.equal(pickJobText({ extraction, iframeTexts }), 'the longest iframe text of them all');
  });

  it('caps the result at 20 000 characters', () => {
    const extraction = extractionOf({});
    const text = pickJobText({ extraction, iframeTexts: ['x'.repeat(25_000)] });
    assert.equal(text.length, 20_000);
  });

  it('returns an empty string when there is nothing to pick', () => {
    assert.equal(pickJobText({ extraction: extractionOf({}), iframeTexts: [] }), '');
  });

  it('returns an empty string, not the whole-page HTML, when job data has no description', () => {
    const extraction = extractionOf({ jobData: jobWithDescription(''), rawText: '<div>whole page</div>' });
    assert.equal(pickJobText({ extraction, iframeTexts: [] }), '');
  });
});
