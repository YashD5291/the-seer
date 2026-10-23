import type { JobData, ExtractionResult } from '../shared/types.js';

export type { ExtractionResult };

/**
 * Universal job extractor - works on ANY page.
 *
 * Collects from ALL tiers and merges the best result:
 * - JSON-LD: metadata (title, company, location, salary)
 * - Embedded <code> tags: full description (LinkedIn stores full JD here)
 * - Page HTML: fallback description
 *
 * Always picks the LONGEST description available.
 */

export function extractPageContent(): ExtractionResult {
  const url = window.location.href;
  const pageTitle = document.title;

  console.log('[Seer Scraper] Starting extraction on:', url);

  // ─── Collect from ALL sources ──────────────────────────────────

  // Source 1: JSON-LD
  console.log('[Seer Scraper] Checking JSON-LD...');
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  console.log(`[Seer Scraper] Found ${scripts.length} JSON-LD script tags`);
  const jsonLd = extractJsonLd();
  let jsonLdJob: JobData | null = null;

  if (jsonLd) {
    console.log('[Seer Scraper] JSON-LD HIT:', jsonLd.title || jsonLd.name || '(no title)');
    jsonLdJob = mapJsonLdToJobData(jsonLd, url);
    console.log(`[Seer Scraper] JSON-LD description: ${jsonLdJob.description.length} chars`);
  } else {
    console.log('[Seer Scraper] JSON-LD MISS');
  }

  // Source 2: Embedded <code> tags (LinkedIn full JD lives here)
  console.log('[Seer Scraper] Checking <code> tags...');
  const codeBlocks = document.querySelectorAll('code');
  console.log(`[Seer Scraper] Found ${codeBlocks.length} <code> tags`);
  const embedded = extractEmbeddedJobData();

  if (embedded) {
    console.log(`[Seer Scraper] Embedded HIT: ${embedded.length} chars`);
  } else {
    console.log('[Seer Scraper] Embedded MISS');
  }

  // Source 3: Expand hidden content + grab page text
  console.log('[Seer Scraper] Expanding hidden content...');
  expandAllContent();
  const pageText = getCleanPageText();
  console.log(`[Seer Scraper] Page text: ${pageText.length} chars`);

  // ─── Merge: pick the best description ──────────────────────────

  // Candidates for description, longest wins
  const descCandidates: { source: string; text: string }[] = [];

  if (jsonLdJob && jsonLdJob.description.length > 50) {
    descCandidates.push({ source: 'json-ld', text: jsonLdJob.description });
  }
  if (embedded && embedded.length > 100) {
    descCandidates.push({ source: 'embedded', text: embedded });
  }
  if (pageText.length > 200) {
    descCandidates.push({ source: 'page-text', text: pageText });
  }

  descCandidates.sort((a, b) => b.text.length - a.text.length);

  if (descCandidates.length > 0) {
    console.log('[Seer Scraper] Description candidates:');
    descCandidates.forEach(c => console.log(`  ${c.source}: ${c.text.length} chars`));
  }

  const bestDesc = descCandidates[0] || null;

  // ─── Build result ──────────────────────────────────────────────

  // Case 1: We have JSON-LD metadata — use it for structured fields, swap in best description
  if (jsonLdJob && bestDesc) {
    jsonLdJob.description = bestDesc.text;
    const method = bestDesc.source === 'json-ld' ? 'json-ld' as const
      : bestDesc.source === 'embedded' ? 'embedded' as const
      : 'page-text' as const;

    console.log(`[Seer Scraper] Result: JSON-LD metadata + ${bestDesc.source} description (${bestDesc.text.length} chars)`);
    console.log(`[Seer Scraper] "${jsonLdJob.title}" @ ${jsonLdJob.company}`);

    return {
      success: true,
      jobData: jsonLdJob,
      rawText: bestDesc.text,
      jsonLd,
      url,
      pageTitle,
      extractionMethod: method,
    };
  }

  // Case 2: No JSON-LD but we have embedded or page content — the host's scorer reads the facts from it
  if (bestDesc) {
    const method = bestDesc.source === 'embedded' ? 'embedded' as const : 'page-text' as const;
    console.log(`[Seer Scraper] Result: No JSON-LD, using ${bestDesc.source} (${bestDesc.text.length} chars) → the scorer will extract the facts`);

    return {
      success: true,
      jobData: null,
      rawText: bestDesc.text,
      jsonLd,
      url,
      pageTitle,
      extractionMethod: method,
    };
  }

  // Failures pass the page's HTML on: the background turns it into text (see pickJobText).
  const pageHtml = getCleanPageHtml();
  console.log(`[Seer Scraper] Page HTML: ${pageHtml.length} chars`);

  // Case 3: Nothing in DOM — check for cross-origin iframes (Greenhouse, Lever, etc.)
  const iframeUrls = collectIframeUrls();
  if (iframeUrls.length > 0) {
    console.log(`[Seer Scraper] DOM empty but found ${iframeUrls.length} iframe(s):`, iframeUrls);
    return {
      success: false,
      jobData: null,
      rawText: pageHtml,
      jsonLd: null,
      url,
      pageTitle,
      extractionMethod: 'none',
      iframeUrls,
    };
  }

  console.log('[Seer Scraper] FAILED: No usable content found');
  return {
    success: false,
    jobData: null,
    rawText: pageHtml,
    jsonLd: null,
    url,
    pageTitle,
    extractionMethod: 'none',
  };
}

// ─── Tier 1: JSON-LD ────────────────────────────────────────────────

function extractJsonLd(): any | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const raw = JSON.parse(script.textContent || '');

      // Direct JobPosting
      if (raw['@type'] === 'JobPosting') return raw;

      // @graph array
      if (Array.isArray(raw['@graph'])) {
        const posting = raw['@graph'].find((item: any) => item['@type'] === 'JobPosting');
        if (posting) return posting;
      }

      // Top-level array
      if (Array.isArray(raw)) {
        const posting = raw.find((item: any) => item['@type'] === 'JobPosting');
        if (posting) return posting;
      }
    } catch { /* skip */ }
  }
  return null;
}

function mapJsonLdToJobData(posting: any, pageUrl: string): JobData {
  let company = 'Unknown Company';
  if (typeof posting.hiringOrganization === 'string') {
    company = posting.hiringOrganization;
  } else if (posting.hiringOrganization?.name) {
    company = posting.hiringOrganization.name;
  }

  let location: string | undefined;
  const loc = posting.jobLocation;
  if (typeof loc === 'string') {
    location = loc;
  } else if (Array.isArray(loc)) {
    location = loc.map(formatLocation).filter(Boolean).join('; ');
  } else if (loc) {
    location = formatLocation(loc);
  }
  if (posting.jobLocationType) {
    location = location ? `${location} (${posting.jobLocationType})` : posting.jobLocationType;
  }

  let salary_range: string | undefined;
  const salary = posting.baseSalary || posting.estimatedSalary;
  if (salary) {
    const value = salary.value || salary;
    if (value.minValue && value.maxValue) {
      salary_range = `$${fmtNum(value.minValue)} - $${fmtNum(value.maxValue)}`;
    } else if (value.value) {
      salary_range = `$${fmtNum(value.value)}`;
    }
  }

  let description = '';
  if (posting.description) {
    description = stripHtml(posting.description);
  }

  let job_type: string | undefined;
  if (posting.employmentType) {
    job_type = Array.isArray(posting.employmentType)
      ? posting.employmentType.join(', ')
      : posting.employmentType;
  }

  const requirements: string[] = [];
  if (posting.qualifications) {
    const quals = Array.isArray(posting.qualifications) ? posting.qualifications : [posting.qualifications];
    for (const q of quals) {
      if (typeof q === 'string') requirements.push(q);
      else if (q.name) requirements.push(q.name);
    }
  }

  return {
    title: posting.title || posting.name || '',
    company,
    url: posting.url || pageUrl,
    location,
    salary_range,
    job_type,
    description,
    requirements,
    nice_to_haves: [],
    platform: 'json-ld',
  };
}

// ─── Tier 2: Embedded data ──────────────────────────────────────────

function extractEmbeddedJobData(): string | null {
  // LinkedIn and others embed full job data as JSON in <code> tags
  const codeBlocks = document.querySelectorAll('code');
  let bestResult: string | null = null;
  let bestLength = 0;

  for (const block of codeBlocks) {
    try {
      const data = JSON.parse(block.textContent || '');
      // LinkedIn pattern: { title, companyName, description: { text } }
      if (data?.description?.text && data?.title) {
        const result = [
          `Title: ${data.title}`,
          data.companyName ? `Company: ${data.companyName}` : '',
          data.formattedLocation ? `Location: ${data.formattedLocation}` : '',
          '',
          data.description.text,
        ].filter(Boolean).join('\n');
        if (result.length > bestLength) {
          bestResult = result;
          bestLength = result.length;
        }
      }
      // Generic: any object with a long description field
      if (typeof data?.description === 'string' && data.description.length > 200) {
        const result = [
          data.title ? `Title: ${data.title}` : '',
          (data.company || data.companyName) ? `Company: ${data.company || data.companyName}` : '',
          '',
          data.description,
        ].filter(Boolean).join('\n');
        if (result.length > bestLength) {
          bestResult = result;
          bestLength = result.length;
        }
      }
    } catch { /* not JSON */ }
  }

  if (bestResult) return bestResult;

  // Check window.__INITIAL_STATE__ and similar patterns in <script> tags
  const scripts = document.querySelectorAll('script:not([src]):not([type])');
  for (const script of scripts) {
    const text = script.textContent || '';
    const patterns = [
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
      /window\.__data__\s*=\s*(\{[\s\S]*?\});/,
      /window\.__JOB_DATA__\s*=\s*(\{[\s\S]*?\});/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          const desc = findDeepValue(data, 'description');
          if (typeof desc === 'string' && desc.length > 200) return desc;
        } catch { /* skip */ }
      }
    }
  }

  return null;
}

function findDeepValue(obj: any, key: string, depth = 0): any {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;
  if (obj[key] && typeof obj[key] === 'string' && obj[key].length > 100) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findDeepValue(v, key, depth + 1);
    if (found) return found;
  }
  return null;
}

// ─── Tier 3: Content expansion ──────────────────────────────────────

function expandAllContent(): void {
  let expanded = 0;

  const expandPatterns = [
    'show more', 'see more', 'read more', 'view more',
    'expand', 'more details', 'full description',
    '...more', 'show all', 'view full description',
  ];

  const clickTargets = document.querySelectorAll(
    'button, a, span, div[role="button"], [role="link"], [tabindex="0"]'
  );
  clickTargets.forEach(el => {
    const text = (el.textContent?.trim().toLowerCase() || '') + ' ' +
                 (el.getAttribute('aria-label')?.toLowerCase() || '');
    if (expandPatterns.some(p => text.includes(p))) {
      try {
        (el as HTMLElement).click();
        expanded++;
        console.log(`[Seer Scraper] Clicked expand: "${el.textContent?.trim().slice(0, 40)}"`);
      } catch { /* skip */ }
    }
  });

  const truncated = document.querySelectorAll(
    '[class*="truncat"], [class*="collapsed"], [class*="clamp"], ' +
    '[class*="ellipsis"], [class*="hidden-content"], [class*="fade-out"]'
  );
  truncated.forEach(el => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.maxHeight = 'none';
    htmlEl.style.overflow = 'visible';
    htmlEl.style.webkitLineClamp = 'unset';
    htmlEl.style.display = 'block';
  });
  if (truncated.length > 0) console.log(`[Seer Scraper] CSS un-truncated: ${truncated.length}`);

  const ariaCollapsed = document.querySelectorAll('[aria-expanded="false"]');
  ariaCollapsed.forEach(el => {
    el.setAttribute('aria-expanded', 'true');
    const controls = el.getAttribute('aria-controls');
    if (controls) {
      const target = document.getElementById(controls);
      if (target) {
        (target as HTMLElement).style.display = 'block';
        (target as HTMLElement).style.maxHeight = 'none';
      }
    }
  });
  if (ariaCollapsed.length > 0) console.log(`[Seer Scraper] Aria expanded: ${ariaCollapsed.length}`);

  const linkedInHidden = document.querySelectorAll('.jobs-description__content--hide');
  linkedInHidden.forEach(el => el.classList.remove('jobs-description__content--hide'));
  if (linkedInHidden.length > 0) console.log(`[Seer Scraper] LinkedIn unhid: ${linkedInHidden.length}`);

  console.log(`[Seer Scraper] Expansion done (${expanded} clicks, ${truncated.length + ariaCollapsed.length + linkedInHidden.length} un-hidden)`);
}

// ─── Shared helpers ─────────────────────────────────────────────────

function getCleanPageText(): string {
  const mainEl = document.querySelector('main')
    || document.querySelector('[role="main"]')
    || document.querySelector('article')
    || document.body;

  let text = (mainEl as HTMLElement).innerText || '';
  if (text.length > 15000) {
    text = text.slice(0, 15000);
  }
  return text;
}

function getCleanPageHtml(): string {
  const mainEl = document.querySelector('main')
    || document.querySelector('[role="main"]')
    || document.querySelector('article')
    || document.body;

  const clone = (mainEl as HTMLElement).cloneNode(true) as HTMLElement;

  const noiseSelectors = [
    'script', 'style', 'noscript', 'link', 'meta',
    'nav', 'header', 'footer', 'aside',
    'iframe', 'svg', 'img', 'video', 'audio', 'canvas',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-hidden="true"]',
  ];
  for (const sel of noiseSelectors) {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  }

  const keepAttrs = new Set(['href', 'role', 'aria-label']);
  clone.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (!keepAttrs.has(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  let html = clone.innerHTML
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();

  console.log(`[Seer Scraper] Clean HTML: ${html.length} chars`);

  if (html.length > 20000) {
    html = html.slice(0, 20000);
  }

  return html;
}

function formatLocation(loc: any): string {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  return [
    loc.name,
    loc.address?.addressLocality,
    loc.address?.addressRegion,
    loc.address?.addressCountry,
  ].filter(Boolean).join(', ');
}

function fmtNum(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent?.trim() || '';
}

// ─── Iframe detection ────────────────────────────────────────────────

function collectIframeUrls(): string[] {
  const iframes = document.querySelectorAll('iframe[src]');
  const urls: string[] = [];
  for (const iframe of iframes) {
    const src = iframe.getAttribute('src') || '';
    // Skip tracking/analytics iframes, only keep likely job content
    if (
      src.includes('greenhouse.io') ||
      src.includes('lever.co') ||
      src.includes('workday.com') ||
      src.includes('ashbyhq.com') ||
      src.includes('smartrecruiters.com') ||
      src.includes('jobvite.com') ||
      src.includes('icims.com') ||
      src.includes('myworkday') ||
      src.includes('breezy.hr') ||
      // Generic: iframe with a substantial URL that's not tracking
      (src.startsWith('https://') && !src.includes('google') && !src.includes('facebook')
        && !src.includes('analytics') && !src.includes('ads') && !src.includes('doubleclick')
        && !src.includes('twitter') && src.length > 30)
    ) {
      urls.push(src);
    }
  }
  return urls;
}
