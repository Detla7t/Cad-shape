// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditorBuffers, I18n, type IEditorBuffer } from "@chili3d/core";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Button } from "./controls";
import style from "./editorBufferControls.module.css";

/** Whether `buffer` holds unsaved edits, re-rendering whenever `EditorBuffers` reports a change of it. */
export function useEditorBufferDirty(buffer: IEditorBuffer | undefined): boolean {
    const subscribe = useCallback(
        (notify: () => void) => {
            if (buffer === undefined) return () => {};
            const registration = EditorBuffers.onChanged((document) => {
                if (document === buffer.document) notify();
            });
            return () => registration.dispose();
        },
        [buffer],
    );
    const read = () => {
        try {
            return buffer?.isDirty() === true;
        } catch {
            return false;
        }
    };
    return useSyncExternalStore(subscribe, read, read);
}

export interface EditorBufferControlsProps {
    /** The editor's registered buffer. */
    readonly buffer: IEditorBuffer;
    /** The host's save (toasts, …); `buffer.commit()` when absent. */
    readonly onSave?: () => unknown;
}

/**
 * The save bar every editor shares: an "Unsaved edits" mark, Discard (revert) and Save (commit,
 * one undo step), enabled while the draft differs from its node. The buffer is the truth, so
 * this bar and the element tab's dot always agree.
 */
export function EditorBufferControls({ buffer, onSave }: EditorBufferControlsProps) {
    const dirty = useEditorBufferDirty(buffer);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            await (onSave === undefined ? buffer.commit() : onSave());
        } finally {
            setBusy(false);
        }
    };
    return (
        <span className={style.host} data-editor-buffer={buffer.editor}>
            {dirty ? (
                <span className={style.unsaved} role="status">
                    {I18n.translate("editorBuffers.marker")}
                </span>
            ) : null}
            <Button
                className={style.button}
                disabled={!dirty || busy}
                data-action="discard"
                onClick={() => buffer.revert()}
            >
                {I18n.translate("editorBuffers.discard")}
            </Button>
            <Button
                className={style.button}
                variant="primary"
                disabled={!dirty || busy}
                data-action="save"
                onClick={() => void save()}
            >
                {I18n.translate("editorBuffers.save")}
            </Button>
        </span>
    );
}
