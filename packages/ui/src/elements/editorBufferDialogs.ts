// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    draftNames,
    I18n,
    type I18nKeys,
    type IEditorBufferPrompt,
    PubSub,
    type RecoveryDecision,
    type UnsavedDecision,
} from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "./elements.module.css";

function ask<T>(title: I18nKeys, message: string, buttons: [I18nKeys, T][]): Promise<T> {
    return new Promise<T>((resolve) => {
        const content = div({ className: style.confirm, textContent: message });
        PubSub.default.pub(
            "showDialog",
            title,
            content,
            buttons.map(([content, decision]) => ({ content, onclick: () => resolve(decision) })),
        );
    });
}

/**
 * The app's questions about editor drafts (installed into `EditorBuffers` by the element
 * workspace): Save / Discard / Cancel before closing over unsaved edits — Escape cancels — and
 * Restore / Discard for the drafts recovered with a reopened document.
 */
export const editorBufferDialogs: IEditorBufferPrompt = {
    unsaved: (buffers) =>
        ask<UnsavedDecision>(
            "editorBuffers.unsaved.title",
            I18n.translate("editorBuffers.unsaved{0}", draftNames(buffers)),
            [
                ["editorBuffers.save", "save"],
                ["editorBuffers.discard", "discard"],
                ["common.cancel", "cancel"],
            ],
        ),
    recovered: (_document, drafts) =>
        ask<RecoveryDecision>(
            "editorBuffers.recovered.title",
            I18n.translate("editorBuffers.recovered{0}", draftNames(drafts)),
            [
                ["editorBuffers.restore", "restore"],
                ["editorBuffers.discard", "discard"],
            ],
        ),
};
