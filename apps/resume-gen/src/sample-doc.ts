import type { ResumeDoc } from './resume-doc';

// An invented resume. Setup compiles it once so the PDF builder has fetched its TeX files before the first real resume.
export const SAMPLE_DOC: ResumeDoc = {
  version: 1,
  target: { company: 'Example Co', role: 'Software Engineer' },
  base: 'sample',
  name: 'Alex Rivera',
  contact: {
    email: 'alex.rivera@example.com',
    phone: '+1 (555) 010-0199',
    linkedin: 'linkedin.com/in/alex-rivera-example',
    github: 'github.com/alex-rivera-example',
  },
  summary: 'Software engineer who builds reliable web services and the tools that keep them running.',
  skills: [
    { category: 'Languages', items: ['TypeScript', 'Python', 'SQL'] },
    { category: 'Tools', items: ['PostgreSQL', 'Docker', 'GitHub Actions'] },
  ],
  experience: [
    {
      title: 'Software Engineer',
      company: 'Northwind Labs',
      start: 'Jan 2022',
      end: 'Present',
      bullets: [
        { text: 'Built the billing service that processes 40,000 invoices a month.', priority: 1 },
        { text: 'Cut deploy time from 25 minutes to 6 by caching builds in CI.', priority: 2 },
        { text: 'Mentored two new engineers through their first production releases.', priority: 3 },
      ],
    },
  ],
  education: [{ school: 'State University', degree: 'B.S. Computer Science', date: 'May 2021' }],
  keywords: [],
};
