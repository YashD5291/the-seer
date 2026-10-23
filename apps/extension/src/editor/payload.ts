import type { EditorPayload } from '../shared/types.js';

/** A successful recompile's PDF; the host may leave out its size. */
export interface CompiledPdf {
  pdfBase64: string;
  pdfSizeBytes?: number;
}

/** The payload to store after a successful save: the new source and its freshly compiled PDF. */
export function nextEditorPayload(prev: EditorPayload, latexSource: string, compiled: CompiledPdf): EditorPayload {
  return {
    ...prev,
    latexSource,
    pdfBase64: compiled.pdfBase64,
    pdfSizeBytes: compiled.pdfSizeBytes ?? prev.pdfSizeBytes,
  };
}
