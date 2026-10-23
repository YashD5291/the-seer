import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextEditorPayload } from './payload.ts';
import type { CompiledPdf } from './payload.ts';
import type { EditorPayload } from '../shared/types.ts';

const prev: EditorPayload = {
  pdfPath: '/out/Acme/resume.pdf',
  uploadPdfPath: '/out/Acme/Alex_Rivera_Resume.pdf',
  texPath: '/out/Acme/resume.tex',
  folderPath: '/out/Acme',
  folderName: 'Acme',
  latexSource: 'old source',
  pdfBase64: 'T0xEUERG',
  pdfSizeBytes: 1000,
};

describe('nextEditorPayload', () => {
  it('stores the new source and the freshly compiled PDF', () => {
    const compiled: CompiledPdf = { pdfBase64: 'TkVXUERG', pdfSizeBytes: 2048 };
    assert.deepEqual(nextEditorPayload(prev, 'new source', compiled), {
      ...prev,
      latexSource: 'new source',
      pdfBase64: 'TkVXUERG',
      pdfSizeBytes: 2048,
    });
  });

  it('keeps the previous size when the response has a PDF but no size', () => {
    const next = nextEditorPayload(prev, 'x', { pdfBase64: 'TkVXUERG' });
    assert.equal(next.pdfBase64, 'TkVXUERG');
    assert.equal(next.pdfSizeBytes, 1000);
  });

  it('keeps every other field, including the upload copy path', () => {
    const next = nextEditorPayload(prev, 'x', { pdfBase64: 'TkVXUERG', pdfSizeBytes: 5 });
    assert.equal(next.uploadPdfPath, prev.uploadPdfPath);
    assert.equal(next.folderName, 'Acme');
    assert.equal(next.texPath, prev.texPath);
  });

  it('does not change the previous payload', () => {
    nextEditorPayload(prev, 'new source', { pdfBase64: 'TkVXUERG', pdfSizeBytes: 5 });
    assert.equal(prev.latexSource, 'old source');
    assert.equal(prev.pdfBase64, 'T0xEUERG');
  });
});
