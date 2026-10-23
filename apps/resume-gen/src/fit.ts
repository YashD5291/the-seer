import type { Bullet, ResumeDoc } from './resume-doc';

type Section = 'experience' | 'projects';

export type BulletRef = { section: Section; entry: number; bullet: number };

export type FitResult = { doc: ResumeDoc; pages: number; fits: boolean; removed: number };

type Measure = (doc: ResumeDoc) => Promise<number>;

type Candidate = BulletRef & { priority: Bullet['priority'] };

type Entry = { bullets: Bullet[] };

// Each entry keeps this many of its best bullets, however long the resume is.
const FLOORS: Record<Section, number> = { experience: 2, projects: 1 };
// Projects go before experience when everything else is equal.
const SECTION_RANK: Record<Section, number> = { projects: 0, experience: 1 };

// ---------------------------------------------------------------------------
// Removal order
// ---------------------------------------------------------------------------

// Removable bullets, least important first. Never lists a priority 1 bullet or a floor bullet.
export function removalOrder(doc: ResumeDoc): BulletRef[] {
  const candidates = [
    ...candidatesIn('experience', doc.experience),
    ...candidatesIn('projects', doc.projects ?? []),
  ];
  return candidates.sort(cutFirst).map(({ section, entry, bullet }) => ({ section, entry, bullet }));
}

function candidatesIn(section: Section, entries: Entry[]): Candidate[] {
  return entries.flatMap(({ bullets }, entry) => {
    const keep = protectedIndexes(bullets, FLOORS[section]);
    return bullets.flatMap(({ priority }, bullet) =>
      keep.has(bullet) ? [] : [{ section, entry, bullet, priority }],
    );
  });
}

// The `floor` best bullets (priority asc, then position) plus every priority 1 bullet.
function protectedIndexes(bullets: Bullet[], floor: number): Set<number> {
  const ranked = bullets
    .map(({ priority }, index) => ({ priority, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
  const keep = ranked.filter(({ priority }, rank) => rank < floor || priority === 1);
  return new Set(keep.map(({ index }) => index));
}

// Priority 3 before 2, projects before jobs, later (older) entries first, bottom bullets first.
function cutFirst(a: Candidate, b: Candidate): number {
  return (
    b.priority - a.priority ||
    SECTION_RANK[a.section] - SECTION_RANK[b.section] ||
    b.entry - a.entry ||
    b.bullet - a.bullet
  );
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

// Returns a copy of the doc without the referenced bullets. The input is never changed.
export function withoutBullets(doc: ResumeDoc, refs: BulletRef[]): ResumeDoc {
  const removed = new Set(refs.map(refKey));
  const { projects } = doc;
  return {
    ...doc,
    experience: trimEntries('experience', doc.experience, removed),
    ...(projects && { projects: trimEntries('projects', projects, removed) }),
  };
}

function trimEntries<T extends Entry>(section: Section, entries: T[], removed: Set<string>): T[] {
  return entries.map((entry, entryIndex) => ({
    ...entry,
    bullets: entry.bullets.filter(
      (_, bullet) => !removed.has(refKey({ section, entry: entryIndex, bullet })),
    ),
  }));
}

function refKey({ section, entry, bullet }: BulletRef): string {
  return `${section}:${entry}:${bullet}`;
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

// Every measure call is a real compile, so this binary-searches the number of bullets to remove.
// It assumes removing more bullets never adds pages.
export async function fitToPages(
  doc: ResumeDoc,
  maxPages: number,
  measure: Measure,
): Promise<FitResult> {
  const order = removalOrder(doc);
  const attempts = new Map<number, Promise<FitResult>>();

  const attempt = (removed: number): Promise<FitResult> => {
    const cached = attempts.get(removed);
    if (cached) return cached;
    const next = measureWithout(doc, order.slice(0, removed), measure, maxPages);
    attempts.set(removed, next);
    return next;
  };

  const untrimmed = await attempt(0);
  if (untrimmed.fits || order.length === 0) return untrimmed;

  let low = 1;
  let high = order.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await attempt(middle)).fits) high = middle;
    else low = middle + 1;
  }
  return attempt(low);
}

async function measureWithout(
  doc: ResumeDoc,
  refs: BulletRef[],
  measure: Measure,
  maxPages: number,
): Promise<FitResult> {
  const trimmed = withoutBullets(doc, refs);
  const pages = await measure(trimmed);
  return { doc: trimmed, pages, fits: pages <= maxPages, removed: refs.length };
}
