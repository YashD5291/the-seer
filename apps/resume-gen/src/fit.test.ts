import { describe, expect, it } from 'bun:test';
import { fitToPages, removalOrder, withoutBullets, type BulletRef } from './fit';
import type { Bullet, ResumeDoc } from './resume-doc';
import { VALID } from './test-fixtures';

type Priorities = Bullet['priority'][];

function bulletsOf(prefix: string, priorities: Priorities): Bullet[] {
  return priorities.map((priority, index) => ({ text: `${prefix}.${index}`, priority }));
}

// Bullet text is "job<entry>.<bullet>" or "project<entry>.<bullet>", so tests can see which survived.
function buildDoc(jobs: Priorities[], projects?: Priorities[]): ResumeDoc {
  const [job] = VALID.experience;
  return {
    ...VALID,
    experience: jobs.map((priorities, entry) => ({ ...job, bullets: bulletsOf(`job${entry}`, priorities) })),
    ...(projects && {
      projects: projects.map((priorities, entry) => ({
        name: `Project ${entry}`,
        bullets: bulletsOf(`project${entry}`, priorities),
      })),
    }),
  };
}

function bulletTexts(doc: ResumeDoc): string[] {
  return [...doc.experience, ...(doc.projects ?? [])].flatMap((entry) => entry.bullets.map((b) => b.text));
}

function totalBullets(doc: ResumeDoc): number {
  return bulletTexts(doc).length;
}

function job(entry: number, bullet: number): BulletRef {
  return { section: 'experience', entry, bullet };
}

function project(entry: number, bullet: number): BulletRef {
  return { section: 'projects', entry, bullet };
}

// A stand-in for the compiler: counts calls and derives the page count from the doc.
function fakeMeasure(pagesFor: (doc: ResumeDoc) => number) {
  const calls: ResumeDoc[] = [];
  const measure = (doc: ResumeDoc): Promise<number> => {
    calls.push(doc);
    return Promise.resolve(pagesFor(doc));
  };
  return { measure, calls };
}

function maxCompiles(candidates: number): number {
  return Math.ceil(Math.log2(candidates)) + 2;
}

describe('removalOrder', () => {
  it('lists priority 3 first, projects before experience, older jobs first, bottom bullets first', () => {
    const doc = buildDoc(
      [
        [1, 2, 3, 3],
        [2, 3, 2],
      ],
      [[3, 2]],
    );

    expect(removalOrder(doc)).toEqual([project(0, 0), job(1, 1), job(0, 3), job(0, 2)]);
  });

  it('removes every priority 3 bullet before any priority 2 bullet', () => {
    const doc = buildDoc([[1, 2, 2, 2, 3]], [[2, 2]]);

    expect(removalOrder(doc)).toEqual([job(0, 4), project(0, 1), job(0, 3), job(0, 2)]);
  });

  it('never lists a priority 1 bullet, even beyond the floor', () => {
    const doc = buildDoc([[1, 1, 1, 3], [1, 1, 1]], [[1, 1]]);

    expect(removalOrder(doc)).toEqual([job(0, 3)]);
  });

  it('keeps two bullets per job and one per project, chosen by priority rather than position', () => {
    const doc = buildDoc([[3, 3, 2, 2], [2, 2, 2]], [[3], [2, 2]]);

    expect(removalOrder(doc)).toEqual([job(0, 1), job(0, 0), project(1, 1), job(1, 2)]);
  });

  it('handles a doc without projects', () => {
    expect(removalOrder(buildDoc([[1, 2, 3]]))).toEqual([job(0, 2)]);
  });

  it('is empty when every bullet is protected', () => {
    expect(removalOrder(buildDoc([[1, 2], [3]], [[3]]))).toEqual([]);
  });
});

describe('withoutBullets', () => {
  it('removes only the referenced bullets and keeps entries and remaining bullets in order', () => {
    const doc = buildDoc([[1, 2, 3], [2, 3]], [[2, 3]]);

    const trimmed = withoutBullets(doc, [job(0, 2), job(1, 0), project(0, 1)]);

    expect(trimmed.experience.map((entry) => entry.bullets.map((b) => b.text))).toEqual([
      ['job0.0', 'job0.1'],
      ['job1.1'],
    ]);
    expect(trimmed.projects?.map((entry) => entry.bullets.map((b) => b.text))).toEqual([['project0.0']]);
    expect(trimmed.experience.map((entry) => entry.title)).toEqual(doc.experience.map((entry) => entry.title));
  });

  it('does not mutate its input', () => {
    const doc = buildDoc([[1, 2, 3], [2, 3]], [[2, 3]]);
    const snapshot = structuredClone(doc);

    withoutBullets(doc, [job(0, 2), job(1, 1), project(0, 1)]);

    expect(doc).toEqual(snapshot);
  });

  it('returns an equal doc when there is nothing to remove', () => {
    const doc = buildDoc([[1, 2, 3]], [[3]]);

    expect(withoutBullets(doc, [])).toEqual(doc);
  });

  it('does not add a projects key to a doc that has none', () => {
    const trimmed = withoutBullets(buildDoc([[1, 2, 3]]), [job(0, 2)]);

    expect('projects' in trimmed).toBe(false);
  });
});

describe('fitToPages', () => {
  const overEightBullets = (doc: ResumeDoc): number => (totalBullets(doc) > 8 ? 2 : 1);

  it('measures once and removes nothing when the doc already fits', async () => {
    const doc = buildDoc([[1, 2, 3]]);
    const { measure, calls } = fakeMeasure(() => 1);

    const result = await fitToPages(doc, 1, measure);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ doc, pages: 1, fits: true, removed: 0 });
  });

  it('removes the fewest bullets that fit, in removal order', async () => {
    const doc = buildDoc([
      [1, 2, 3, 3],
      [1, 2, 3, 3],
      [1, 2, 3, 3],
    ]);
    const { measure, calls } = fakeMeasure(overEightBullets);

    const result = await fitToPages(doc, 1, measure);

    expect(result.fits).toBe(true);
    expect(result.removed).toBe(4);
    expect(result.pages).toBe(1);
    expect(totalBullets(result.doc)).toBe(8);
    expect(result.doc).toEqual(withoutBullets(doc, removalOrder(doc).slice(0, 4)));
    expect(calls.length).toBeLessThanOrEqual(maxCompiles(removalOrder(doc).length));
  });

  it('stays within the compile bound on a large doc', async () => {
    const jobs = Array.from({ length: 10 }, (): Priorities => [1, 2, 3, 3, 3, 3]);
    const doc = buildDoc(jobs);
    const candidates = removalOrder(doc).length;
    const { measure, calls } = fakeMeasure((d) => (totalBullets(d) > 30 ? 2 : 1));

    const result = await fitToPages(doc, 1, measure);

    expect(candidates).toBe(40);
    expect(result.removed).toBe(30);
    expect(totalBullets(result.doc)).toBe(30);
    expect(calls.length).toBeLessThanOrEqual(maxCompiles(candidates));
  });

  it('honours a page budget above one and reports the measured page count', async () => {
    const doc = buildDoc([
      [1, 2, 3, 3],
      [1, 2, 3, 3],
      [1, 2, 3, 3],
    ]);
    const pagesFor = (d: ResumeDoc): number => (totalBullets(d) > 10 ? 3 : totalBullets(d) > 8 ? 2 : 1);
    const { measure } = fakeMeasure(pagesFor);

    const result = await fitToPages(doc, 2, measure);

    expect(result.fits).toBe(true);
    expect(result.removed).toBe(2);
    expect(result.pages).toBe(2);
    expect(totalBullets(result.doc)).toBe(10);
  });

  it('returns the most trimmed doc with fits false when nothing can make it fit', async () => {
    const doc = buildDoc([
      [1, 2, 3, 3],
      [1, 2, 3, 3],
    ]);
    const candidates = removalOrder(doc).length;
    const { measure, calls } = fakeMeasure(() => 2);

    const result = await fitToPages(doc, 1, measure);

    expect(result.fits).toBe(false);
    expect(result.removed).toBe(candidates);
    expect(result.pages).toBe(2);
    expect(result.doc).toEqual(withoutBullets(doc, removalOrder(doc)));
    expect(calls.length).toBeLessThanOrEqual(maxCompiles(candidates));
  });

  it('reports fits false without extra compiles when every bullet is protected', async () => {
    const doc = buildDoc([[1, 2]]);
    const { measure, calls } = fakeMeasure(() => 2);

    const result = await fitToPages(doc, 1, measure);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ doc, pages: 2, fits: false, removed: 0 });
  });

  it('does not mutate the doc it is given', async () => {
    const doc = buildDoc([[1, 2, 3, 3]], [[3, 3]]);
    const snapshot = structuredClone(doc);
    const { measure } = fakeMeasure(() => 2);

    await fitToPages(doc, 1, measure);

    expect(doc).toEqual(snapshot);
  });
});
