import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CLAUDE_MODELS,
  MAX_WRITER_NOTES,
  normalizeClaudeModel,
  normalizeMaxPages,
  normalizeMinScore,
  normalizeWriterNotes,
  WRITER_EFFORT,
} from './settings-normalize.ts';

describe('CLAUDE_MODELS', () => {
  it('offers only the writers: Opus first, then Sonnet', () => {
    assert.deepEqual(
      CLAUDE_MODELS.map((m) => m.id),
      ['opus', 'sonnet'],
    );
  });

  it('labels each writer for the setup page', () => {
    assert.deepEqual(CLAUDE_MODELS, [
      { id: 'opus', label: 'Opus — best' },
      { id: 'sonnet', label: 'Sonnet — faster, lighter on usage' },
    ]);
  });
});

describe('WRITER_EFFORT', () => {
  it('is medium: the writer effort is not a setting', () => {
    assert.equal(WRITER_EFFORT, 'medium');
  });
});

describe('normalizeClaudeModel', () => {
  it('keeps every current model id', () => {
    for (const { id } of CLAUDE_MODELS) {
      assert.equal(normalizeClaudeModel(id), id);
    }
  });

  it('keeps sonnet', () => {
    assert.equal(normalizeClaudeModel('sonnet'), 'sonnet');
  });

  it('maps models that are no longer offered to opus', () => {
    assert.equal(normalizeClaudeModel('fable'), 'opus');
    assert.equal(normalizeClaudeModel('haiku'), 'opus');
  });

  it('maps the old browser-era display name to opus', () => {
    assert.equal(normalizeClaudeModel('Sonnet 4.5'), 'opus');
  });

  it('falls back to opus when nothing is stored', () => {
    assert.equal(normalizeClaudeModel(undefined), 'opus');
    assert.equal(normalizeClaudeModel(null), 'opus');
  });

  it('falls back to opus for values that are not strings', () => {
    assert.equal(normalizeClaudeModel(42), 'opus');
    assert.equal(normalizeClaudeModel({ id: 'sonnet' }), 'opus');
  });
});

describe('normalizeMaxPages', () => {
  it('keeps 1 and 2', () => {
    assert.equal(normalizeMaxPages(1), 1);
    assert.equal(normalizeMaxPages(2), 2);
  });

  it('falls back to 1 for any other number', () => {
    assert.equal(normalizeMaxPages(3), 1);
    assert.equal(normalizeMaxPages(0), 1);
  });

  it('falls back to 1 for strings, including numeric ones', () => {
    assert.equal(normalizeMaxPages('3'), 1);
    assert.equal(normalizeMaxPages('2'), 1);
  });

  it('falls back to 1 when nothing is stored', () => {
    assert.equal(normalizeMaxPages(undefined), 1);
  });
});

describe('normalizeMinScore', () => {
  it('keeps whole numbers from 0 to 100', () => {
    assert.equal(normalizeMinScore(55), 55);
    assert.equal(normalizeMinScore(0), 0);
    assert.equal(normalizeMinScore(100), 100);
  });

  it('falls back to 40 for a number out of range', () => {
    assert.equal(normalizeMinScore(101), 40);
    assert.equal(normalizeMinScore(-1), 40);
  });

  it('falls back to 40 for a number that is not whole', () => {
    assert.equal(normalizeMinScore(40.5), 40);
    assert.equal(normalizeMinScore(Number.NaN), 40);
    assert.equal(normalizeMinScore(Number.POSITIVE_INFINITY), 40);
  });

  it('falls back to 40 for strings, including numeric ones', () => {
    assert.equal(normalizeMinScore('50'), 40);
  });

  it('falls back to 40 when nothing is stored', () => {
    assert.equal(normalizeMinScore(undefined), 40);
    assert.equal(normalizeMinScore(null), 40);
  });
});

describe('MAX_WRITER_NOTES', () => {
  it('is 2000, the most characters the helper takes', () => {
    assert.equal(MAX_WRITER_NOTES, 2000);
  });

  it("is the limit of the setup page's extra instructions box", () => {
    const html = readFileSync(new URL('../../setup.html', import.meta.url), 'utf8');
    const textarea = html.match(/<textarea[^>]*\bid="writer-notes"[^>]*>/)?.[0] ?? '';
    assert.match(textarea, new RegExp(`\\bmaxlength="${MAX_WRITER_NOTES}"`));
  });
});

describe('normalizeWriterNotes', () => {
  it('trims the notes', () => {
    assert.equal(normalizeWriterNotes('  Use British spelling  '), 'Use British spelling');
    assert.equal(normalizeWriterNotes('\n Keep my publications section.\n'), 'Keep my publications section.');
  });

  it('keeps notes of exactly 2,000 characters', () => {
    const notes = 'a'.repeat(2000);
    assert.equal(normalizeWriterNotes(notes), notes);
  });

  it('keeps only the first 2,000 characters of longer notes', () => {
    const notes = 'a'.repeat(1500) + 'b'.repeat(1000);
    assert.equal(normalizeWriterNotes(notes), notes.slice(0, 2000));
    assert.equal(normalizeWriterNotes('a'.repeat(2500)).length, 2000);
  });

  it('keeps line breaks inside the notes', () => {
    const notes = 'Use British spelling.\nLead with backend work.';
    assert.equal(normalizeWriterNotes(notes), notes);
  });

  it('is empty for blank notes', () => {
    assert.equal(normalizeWriterNotes(''), '');
    assert.equal(normalizeWriterNotes('   \n  '), '');
  });

  it('is empty when nothing is stored', () => {
    assert.equal(normalizeWriterNotes(undefined), '');
    assert.equal(normalizeWriterNotes(null), '');
  });

  it('is empty for values that are not strings', () => {
    assert.equal(normalizeWriterNotes(42), '');
    assert.equal(normalizeWriterNotes(['Use British spelling']), '');
    assert.equal(normalizeWriterNotes({ notes: 'x' }), '');
  });
});
