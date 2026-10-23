/** Which page a job belongs to. A job is tied to the URL its FAB click was made on. */

/** Query parameters that say how a visitor arrived, never which job is shown. `utm_*` is matched by prefix. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'refId', 'trackingId', 'trk', 'trkInfo', 'lipi', 'eBP', 'src', 'ref',
]);

function isTrackingParam(name: string): boolean {
  return name.startsWith('utm_') || TRACKING_PARAMS.has(name);
}

/**
 * The URL reduced to what picks the job: no `#fragment`, no trailing `/` on the path, no tracking
 * parameters, and the remaining query parameters sorted. A string that is not a URL is returned as is.
 */
export function normalizeJobUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);

  const query = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParam(name)) query.append(name, value);
  }
  query.sort();

  const path = parsed.pathname.replace(/\/+$/, '');
  const search = query.size > 0 ? `?${query.toString()}` : '';
  return `${parsed.protocol}//${parsed.host}${path}${search}`;
}

/** True when a message about the job at `jobUrl` belongs to the page now at `href`. */
export function isSameJobPage(jobUrl: string, href: string): boolean {
  return normalizeJobUrl(jobUrl) === normalizeJobUrl(href);
}
