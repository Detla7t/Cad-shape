// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EditorSelection, type IEditorBuffer, Result } from "@chili3d/core";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FeatureScriptIde } from "./ide/featureScriptIde";

/**
 * A Feature Studio's IDE as an editor buffer (`featureStudio` in `EditorBuffers`): the draft is
 * the IDE's unapplied source, `commit` is Apply (one undo step; bodies using the studio
 * rebuild), `revert` is Revert. A restored draft goes in as an edit in the IDE, so its own undo
 * can take it back. `changed` is called on every update of the IDE's editor (typing, applying,
 * following undo of the studio's source).
 */
export function featureStudioBuffer(ide: FeatureScriptIde, changed: () => void): IEditorBuffer {
    ide.view.dispatch({
        effects: StateEffect.appendConfig.of(EditorView.updateListener.of(() => changed())),
    });
    return {
        document: ide.document,
        node: ide.studio,
        editor: "featureStudio",
        isDirty: () => ide.dirty,
        commit: async () => {
            ide.apply();
            return Result.ok(undefined);
        },
        revert: () => ide.revert(),
        snapshot: () => {
            if (!ide.dirty) return undefined;
            const main = ide.view.state.selection.main;
            return { data: ide.source, selection: { anchor: main.anchor, head: main.head } };
        },
        restore: (draft) => {
            const length = draft.data.length;
            const clamp = (offset: number) => Math.max(0, Math.min(length, offset));
            const selection: EditorSelection | undefined = draft.selection;
            ide.view.dispatch({
                changes: { from: 0, to: ide.view.state.doc.length, insert: draft.data },
                ...(selection === undefined
                    ? {}
                    : { selection: { anchor: clamp(selection.anchor), head: clamp(selection.head) } }),
                scrollIntoView: true,
            });
        },
    };
}
