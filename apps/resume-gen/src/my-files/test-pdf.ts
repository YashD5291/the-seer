const PAGE_SIZE = '[0 0 612 792]';
const TEXT_POSITION = '72 700 Td';
const FONT_SIZE = 24;

// PDF string literals end at an unescaped ")", so backslashes and parentheses are escaped.
function escapeLiteral(text: string): string {
  return text.replace(/[\\()]/g, (character) => `\\${character}`);
}

// One page, in Helvetica; null leaves the page empty, as a scan without OCR would be to PDFKit.
function pageContent(text: string | null): string {
  return text === null ? '' : `BT /F1 ${FONT_SIZE} Tf ${TEXT_POSITION} (${escapeLiteral(text)}) Tj ET`;
}

function objectBodies(text: string | null): string[] {
  const content = pageContent(text);
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox ${PAGE_SIZE} /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
}

// A valid one-page PDF whose cross-reference table holds the real byte offset of every object.
// The text is Latin-1: each character is written as one byte, so offsets can be counted on the string.
export function minimalPdf(text: string | null): Uint8Array {
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objectBodies(text).forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`);
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${entries.join('')}`;
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
