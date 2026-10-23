import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keywordCoverage } from './keyword-score.ts';

describe('keywordCoverage', () => {
  it('splits the keywords into matched and missing and rounds the percentage', () => {
    const result = keywordCoverage('Built CI/CD for PyTorch models in C++', ['ci/cd', 'pytorch', 'C++', 'Go', 'pytorch']);
    assert.deepEqual(result, { matched: ['ci/cd', 'pytorch', 'C++'], missing: ['Go'], pct: 75 });
  });

  it('collapses duplicates that differ only in case, keeping the first spelling', () => {
    const result = keywordCoverage('python and sql', ['Python', 'python', 'SQL', 'Rust']);
    assert.deepEqual(result, { matched: ['Python', 'SQL'], missing: ['Rust'], pct: 67 });
  });

  it('does not match a keyword inside a longer word', () => {
    const result = keywordCoverage('Used MongoDB and Golang daily', ['Go', 'Mongo']);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.missing, ['Go', 'Mongo']);
  });

  it('matches regardless of case', () => {
    assert.deepEqual(keywordCoverage('Wrote PYTORCH code', ['PyTorch']).matched, ['PyTorch']);
  });

  it('matches multi-word keywords across line breaks and punctuation', () => {
    const result = keywordCoverage('Fine-tuned LLMs;\nbuilt RAG\tpipelines (retrieval)', ['rag pipelines', 'fine tuned llms']);
    assert.deepEqual(result.missing, []);
  });

  it('keeps dots, pluses and hashes inside a keyword', () => {
    const result = keywordCoverage('Shipped Node.js services in C# and C++', ['Node.js', 'C#', 'C++', 'C']);
    assert.deepEqual(result.matched, ['Node.js', 'C#', 'C++']);
    assert.deepEqual(result.missing, ['C']);
  });

  it('ignores a sentence-ending period or comma after a keyword', () => {
    const result = keywordCoverage('Trained models with PyTorch. Deployed with Docker, Kubernetes.', ['pytorch', 'docker', 'kubernetes']);
    assert.deepEqual(result.missing, []);
  });

  it('keeps a leading dot, so .NET is not the plain word "net"', () => {
    assert.deepEqual(keywordCoverage('Grew net revenue', ['.NET']).missing, ['.NET']);
    assert.deepEqual(keywordCoverage('Built services on .NET.', ['.NET']).matched, ['.NET']);
  });

  it('ignores keywords with no letters or digits', () => {
    assert.deepEqual(keywordCoverage('python', ['python', '', '  ', '—']), { matched: ['python'], missing: [], pct: 100 });
  });

  it('ignores keywords that are only symbols, counting them as neither matched nor missing', () => {
    const result = keywordCoverage('Wrote C++ and python', ['+', '++', '#', '.', 'python', 'rust']);
    assert.deepEqual(result, { matched: ['python'], missing: ['rust'], pct: 50 });
  });

  it('has a percentage of 0 without keywords', () => {
    assert.deepEqual(keywordCoverage('anything', []), { matched: [], missing: [], pct: 0 });
  });

  it('matches a keyword at the very start and end of the text', () => {
    assert.deepEqual(keywordCoverage('python is fun, learn rust', ['python', 'rust']).missing, []);
  });
});
