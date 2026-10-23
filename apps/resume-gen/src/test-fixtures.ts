import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResumeDoc } from './resume-doc';
import type { FitResult } from './scorer/request';

export const REAL_TEMPLATE = fileURLToPath(new URL('../GEN/GEN-V3.tex', import.meta.url));

// A fit score that passes every check in validateFitResult; recommended_base matches the test profiles.
export const VALID_FIT: FitResult = {
  job: {
    title: 'ML Engineer',
    company: 'Acme AI',
    location: 'Remote (US)',
    salary_range: '$180,000 - $220,000',
    job_type: 'Full-time',
    requirements: ['5+ years of ML engineering', 'Production RAG systems'],
    nice_to_haves: ['Fine-tuning with DPO'],
  },
  fit_score: 78,
  confidence: 80,
  recommended_base: 'gen-ai',
  base_reasoning: 'The posting centers on retrieval and LLM products.',
  key_matches: ['Shipped a RAG pipeline in production'],
  gaps: ['No DPO experience'],
  gap_mitigation: ['Point to supervised fine-tuning work'],
  tailoring_priorities: ['Lead with retrieval work'],
  ats_keywords: ['RAG', 'LLM', 'PyTorch'],
  red_flags: [],
  estimated_competition: 'high',
  apply_recommendation: 'yes',
};

export const VALID: ResumeDoc = {
  version: 1,
  target: { company: 'Acme AI', role: 'ML Engineer' },
  base: 'gen-ai',
  name: 'Alex Rivera',
  contact: {
    email: 'alex.rivera@example.com',
    phone: '+1 (555) 010-0199',
    github: 'github.com/alex-rivera-example',
  },
  summary: 'ML engineer who ships retrieval-augmented generation systems to production.',
  skills: [
    { category: 'Languages', items: ['Python', 'TypeScript', 'SQL'] },
    { category: 'Frameworks', items: ['LangChain', 'Hugging Face'] },
  ],
  experience: [
    {
      title: 'Machine Learning Engineer',
      company: 'Northwind Labs',
      start: 'Jan 2023',
      end: 'Present',
      bullets: [
        { text: 'Built a RAG pipeline answering 2M queries per month.', priority: 1 },
        { text: 'Cut inference latency 40% by batching PyTorch requests.', priority: 2 },
        { text: 'Mentored four engineers on evaluation and prompt testing.', priority: 3 },
      ],
    },
  ],
  education: [{ school: 'State University', degree: 'B.S. Computer Science', date: 'May 2020' }],
  keywords: ['PyTorch', 'RAG'],
};

const WAIT_MS = 3_000;
// Gives up after this many polls (about 5 s), so a test that fails early cannot leave tectonic waiting forever.
const BLOCKED_POLLS = 250;

// A stand-in for tectonic that reports one page. When `blocked`, it waits for release() before it
// writes its output, so a test can act mid-compile. `dir` is the caller's to clean up.
export function onePageTectonic(
  dir: string,
  blocked = false,
): { path: string; started: () => boolean; release: () => void } {
  const path = join(dir, 'tectonic');
  const startedFile = join(dir, 'started');
  const releaseFile = join(dir, 'release');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `touch "${startedFile}"`,
      'polls=0',
      `while [ ! -e "${releaseFile}" ] && [ $polls -lt ${BLOCKED_POLLS} ]; do sleep 0.02; polls=$((polls+1)); done`,
      'printf "Output written on resume.xdv (1 pages, 10 bytes).\\n" > resume.log',
      'printf "%%PDF-fake" > resume.pdf',
    ].join('\n'),
    'utf-8',
  );
  chmodSync(path, 0o755);
  const release = (): void => writeFileSync(releaseFile, '');
  if (!blocked) release();
  return { path, started: () => existsSync(startedFile), release };
}

export async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
