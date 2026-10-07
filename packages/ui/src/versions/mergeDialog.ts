// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ConflictResolution,
    type DocumentVersionControl,
    I18n,
    type I18nKeys,
    type MergeConflict,
    type ObjectHash,
    PubSub,
    summarizeDiff,
} from "@chili3d/core";
import { button, div, input, label, li, span, ul } from "@chili3d/element";
import { type FloatPanel, showFloatPanel } from "../floatPanel";
import style from "./versions.module.css";

let groupSeed = 0;

/**
 * The merge dialog: what `source` brings in, every conflict with a choice of side (and "both"
 * for a text hunk), then one merge commit. The document is patched as a single undoable step;
 * features that fail to rebuild afterwards are reported, not hidden.
 */
export function showMergeDialog(control: DocumentVersionControl, source: ObjectHash): void {
    const preview = control.previewMerge(source);
    const resolutions = new Map<string, ConflictResolution>();
    const title = I18n.translate("versions.mergeInto{0}{1}", control.label(source), control.currentBranch);
    const body = div({ className: style.viewBody });
    let panel: FloatPanel | undefined;

    if (preview.upToDate) {
        body.append(div({ className: style.empty, textContent: I18n.translate("versions.upToDate") }));
    } else {
        const incoming = summarizeDiff(preview.incoming, 200);
        body.append(
            div(
                { className: style.section },
                div({ className: style.sectionTitle, textContent: I18n.translate("versions.incoming") }),
                incoming.length === 0
                    ? div({ className: style.hint, textContent: I18n.translate("versions.noChanges") })
                    : ul(
                          { className: style.changeList },
                          ...incoming.map((line) => li({ textContent: line })),
                      ),
            ),
            div(
                { className: style.section },
                div({
                    className: style.sectionTitle,
                    textContent: `${I18n.translate("versions.conflicts")} (${preview.conflicts.length})`,
                }),
                ...(preview.conflicts.length === 0
                    ? [div({ className: style.hint, textContent: I18n.translate("versions.noConflicts") })]
                    : preview.conflicts.map((conflict) => conflictCard(conflict, resolutions))),
            ),
        );
    }

    const commit = button({
        className: `${style.button} ${style.primary}`,
        textContent: I18n.translate("versions.mergeButton"),
        disabled: preview.upToDate,
        onclick: () => {
            const result = control.merge(preview, resolutions);
            panel?.close();
            if (!result.isOk) {
                PubSub.default.pub("showToast", "versions.error{0}", result.error);
                return;
            }
            PubSub.default.pub("showToast", "versions.merged{0}", control.label(source));
            const errors = result.value.errors;
            if (errors.length > 0) {
                PubSub.default.pub(
                    "displayError",
                    I18n.translate(
                        "versions.featureErrors{0}",
                        errors.map((e) => `${e.nodeName} › ${e.feature}: ${e.message}`).join("; "),
                    ),
                );
            }
        },
    });
    const cancel = button({
        className: style.button,
        textContent: I18n.translate("common.cancel"),
        onclick: () => panel?.close(),
    });
    const content = div(
        { className: style.view },
        div({ className: style.viewHeader }, div({ className: style.viewTitle, textContent: title })),
        body,
        div({ className: style.viewFooter }, cancel, commit),
    );
    panel = showFloatPanel({
        title: "versions.mergeButton",
        content,
        width: 560,
        height: 520,
        minWidth: 360,
        minHeight: 260,
        x: Math.max(20, window.innerWidth / 2 - 280),
        y: 80,
        document: control.document,
    });
}

function conflictCard(conflict: MergeConflict, resolutions: Map<string, ConflictResolution>): HTMLElement {
    const name = `versions-conflict-${groupSeed++}`;
    const heading =
        conflict.field === undefined ? conflict.location : `${conflict.location} › ${conflict.field}`;
    const isText = conflict.kind === "text";
    const choice = (
        key: I18nKeys,
        value: "ours" | "theirs" | "both",
        text: string | undefined,
        checked: boolean,
    ) =>
        label(
            { className: style.choice },
            input({
                type: "radio",
                name,
                checked,
                onchange: () => resolutions.set(conflict.id, value),
            }),
            span({ className: style.choiceLabel, textContent: I18n.translate(key) }),
            isText && text !== undefined
                ? div({ className: `${style.choiceValue} ${style.code}`, textContent: text })
                : span({ className: style.choiceValue, textContent: text ?? "" }),
        );
    return div(
        { className: style.conflict },
        div({ className: style.conflictTitle, textContent: heading }),
        ...(conflict.base !== undefined && !isText
            ? [
                  div({
                      className: style.base,
                      textContent: `${I18n.translate("versions.base")}: ${conflict.base}`,
                  }),
              ]
            : []),
        choice("versions.ours", "ours", conflict.ours, true),
        choice("versions.theirs", "theirs", conflict.theirs, false),
        ...(isText ? [choice("versions.both", "both", undefined, false)] : []),
    );
}
