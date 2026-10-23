import { describe, expect, it } from 'bun:test';
import type { ResumeDoc } from './resume-doc';
import { sortExperienceNewestFirst } from './resume-order';
import { VALID } from './test-fixtures';

type Role = ResumeDoc['experience'][number];

function role(company: string, start: string, end: string): Role {
  return {
    title: 'Machine Learning Engineer',
    company,
    start,
    end,
    bullets: [
      { text: `Built the ${company} ranking service.`, priority: 1 },
      { text: `Cut ${company} costs 20%.`, priority: 3 },
    ],
  };
}

function docWith(experience: Role[]): ResumeDoc {
  return { ...VALID, experience };
}

function companies(experience: Role[]): string[] {
  return sortExperienceNewestFirst(docWith(experience)).experience.map((entry) => entry.company);
}

describe('sortExperienceNewestFirst', () => {
  it('puts a later end date first', () => {
    expect(companies([role('Older', 'Jan 2018', 'Dec 2019'), role('Newer', 'Jan 2020', 'Mar 2022')])).toEqual([
      'Newer',
      'Older',
    ]);
  });

  it('reads "Mon YYYY", "Month YYYY", "MM/YYYY" and "YYYY" on one scale', () => {
    const experience = [
      role('Short month', 'Jan 2015', 'Feb 2016'),
      role('Slash', '01/2015', '04/2016'),
      role('Long month', 'January 2015', 'March 2016'),
      role('Year', '2015', '2017'),
    ];
    expect(companies(experience)).toEqual(['Year', 'Slash', 'Long month', 'Short month']);
  });

  it('reads month names in any case, and "Sept"', () => {
    expect(companies([role('Aug', 'jan 2019', 'AUGUST 2020'), role('Sept', 'Jan 2019', 'Sept 2020')])).toEqual([
      'Sept',
      'Aug',
    ]);
  });

  it('sorts a year-only end as the end of that year', () => {
    expect(companies([role('November', 'Jan 2020', 'Nov 2023'), role('Year', 'Jan 2020', '2023')])).toEqual([
      'Year',
      'November',
    ]);
    expect(companies([role('Year', 'Jan 2020', '2023'), role('Next January', 'Jan 2020', 'Jan 2024')])).toEqual([
      'Next January',
      'Year',
    ]);
  });

  it('sorts a year-only start as the start of that year', () => {
    expect(companies([role('Year', '2021', 'Dec 2023'), role('February', 'Feb 2021', 'Dec 2023')])).toEqual([
      'February',
      'Year',
    ]);
  });

  it('breaks a tie on the end date by the later start date', () => {
    expect(companies([role('Longer', 'Mar 2018', 'Jun 2022'), role('Shorter', 'Jan 2021', '06/2022')])).toEqual([
      'Shorter',
      'Longer',
    ]);
  });

  it('keeps the given order for roles with the same dates', () => {
    expect(companies([role('First', 'Jan 2021', 'Jun 2022'), role('Second', 'Jan 2021', 'Jun 2022')])).toEqual([
      'First',
      'Second',
    ]);
  });

  it('puts a current role first, whatever word marks it', () => {
    for (const current of ['Present', 'present', 'PRESENT', 'Current', 'now', ' Present ']) {
      expect(companies([role('Ended', 'Jan 2019', 'Dec 2099'), role('Current', 'Jan 2023', current)])).toEqual([
        'Current',
        'Ended',
      ]);
    }
  });

  it('orders two current roles by start date', () => {
    expect(companies([role('Since 2019', 'Jan 2019', 'Present'), role('Since 2023', 'Jan 2023', 'Current')])).toEqual([
      'Since 2023',
      'Since 2019',
    ]);
  });

  it('reads a month name with a trailing period, in end and start dates', () => {
    const ends = [
      role('Jan.', 'Jan 2019', 'Jan. 2020'),
      role('Aug', 'Jan 2019', 'Aug 2020'),
      role('Sept.', 'Jan 2019', 'Sept. 2020'),
    ];
    expect(companies(ends)).toEqual(['Sept.', 'Aug', 'Jan.']);
    expect(companies([role('January', 'Jan 2019', 'Dec 2020'), role('Feb.', 'Feb. 2019', 'Dec 2020')])).toEqual([
      'Feb.',
      'January',
    ]);
  });

  it('leaves a role whose end date cannot be read in its place and sorts the others around it', () => {
    const experience = [
      role('Oldest', 'Jan 2015', 'Dec 2016'),
      role('Unreadable end', 'Jan 2017', 'Summer 2018'),
      role('Middle', 'Jan 2019', 'Dec 2020'),
      role('Unreadable start', 'Fall 2019', 'Present'),
      role('Newest', 'Jan 2021', 'Present'),
    ];
    expect(companies(experience)).toEqual(['Newest', 'Unreadable end', 'Unreadable start', 'Middle', 'Oldest']);
  });

  it('sorts a current role with an unreadable start first', () => {
    expect(companies([role('Ended', 'Jan 2019', 'Dec 2020'), role('Current', 'Fall 2021', 'Present')])).toEqual([
      'Current',
      'Ended',
    ]);
  });

  it('sorts a role with an unreadable start by its end date', () => {
    expect(companies([role('Older', 'Jan 2010', 'Dec 2011'), role('Newer', 'Fall 2012', 'Dec 2013')])).toEqual([
      'Newer',
      'Older',
    ]);
  });

  it('puts an unreadable start, "Present" included, after a readable one on the same end date', () => {
    const experience = [
      role('Present start', 'Present', 'Dec 2014'),
      role('Unreadable start', 'Spring 2013', 'Dec 2014'),
      role('Readable start', 'Jan 2010', 'Dec 2014'),
    ];
    expect(companies(experience)).toEqual(['Readable start', 'Present start', 'Unreadable start']);
  });

  it('does not read a month outside 1 to 12 or a two-digit year', () => {
    const experience = [
      role('Old', 'Jan 2010', 'Dec 2011'),
      role('Month 13', 'Jan 2012', '13/2013'),
      role('Two-digit year', 'Jan 2012', 'Jan 13'),
      role('New', 'Jan 2015', 'Dec 2015'),
    ];
    expect(companies(experience)).toEqual(['New', 'Month 13', 'Two-digit year', 'Old']);
  });

  it('moves whole roles: bullets, priorities and every other field stay as they were', () => {
    const older: Role = { ...role('Older', 'Jan 2018', 'Dec 2019'), location: 'Remote' };
    const newer = role('Newer', 'Jan 2020', 'Present');
    const doc = docWith([older, newer]);

    const sorted = sortExperienceNewestFirst(doc);

    expect(sorted.experience).toEqual([newer, older]);
    expect({ ...sorted, experience: doc.experience }).toEqual(doc);
  });

  it('does not change the doc it was given', () => {
    const doc = docWith([role('Older', 'Jan 2018', 'Dec 2019'), role('Newer', 'Jan 2020', 'Present')]);
    const copy = structuredClone(doc);

    sortExperienceNewestFirst(doc);

    expect(doc).toEqual(copy);
  });

  it('returns a doc already newest first unchanged', () => {
    const doc = docWith([role('Newer', 'Jan 2020', 'Present'), role('Older', 'Jan 2018', 'Dec 2019')]);

    expect(sortExperienceNewestFirst(doc)).toEqual(doc);
  });
});
