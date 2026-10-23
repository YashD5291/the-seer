import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';

export function createEditor(
  container: HTMLElement,
  initialContent: string,
  onChange: (content: string) => void,
): EditorView {
  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      basicSetup,
      oneDark,
      StreamLanguage.define(stex),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
        '.cm-gutters': {
          borderRight: '1px solid #333',
        },
      }),
    ],
  });

  return new EditorView({ state, parent: container });
}
