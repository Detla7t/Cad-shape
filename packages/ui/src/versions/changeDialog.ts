// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ApplyOutcome,
    type ConflictResolution,
    type DocumentVersionControl,
    type ObjectHash,
    PubSub,
} from "@chili3d/core";
import { button, div, input, label, option, select } from "@chili3d/element";
import style from "./versions.module.css";

export function showChangeDialog(
    control: DocumentVersionControl,
    source: ObjectHash,
    selected: readonly string[],
    mode: "apply" | "revert" | "rebase",
    idle: () => boolean,
): void {
    const title =
        mode === "rebase"
            ? "Rebase without selected changes"
            : mode === "revert"
              ? "Revert selected changes"
              : "Apply selected changes";
    const dialog = document.createElement("dialog");
    dialog.className = style.changeDialog;
    dialog.setAttribute("aria-label", title);
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    dialog.addEventListener("cancel", () => dialog.remove());
    const head = control.head;
    const choices = new Map<string, ConflictResolution>();
    const target = select(
        {
            className: style.select,
            ariaLabel: "Rebase onto",
            onchange: () => {
                choices.clear();
                render();
            },
        },
        ...control.log().map((commit) =>
            option({
                value: commit.id,
                textContent: `${commit.message} · ${commit.id.slice(0, 8)}`,
                selected: commit.id === control.commit(source).parents[0],
            }),
        ),
    );
    const branch = input({ value: `${control.currentBranch} rebased`, ariaLabel: "New branch name" });
    const review = div({ className: style.viewBody });
    const error = div({ className: style.hint, role: "alert" });
    const finish = (result: ApplyOutcome) => {
        dialog.remove();
        if (result.errors.length)
            PubSub.default.pub(
                "displayError",
                result.errors.map((e) => `${e.nodeName} › ${e.feature}: ${e.message}`).join("\n"),
            );
    };
    let apply = () => {};
    const confirm = button({
        className: `${style.button} ${style.primary}`,
        textContent: mode === "rebase" ? "Create rebased branch" : "Apply",
        onclick: () => {
            if (idle()) apply();
        },
    });
    const render = () => {
        control.flush();
        if (control.head !== head) {
            error.textContent = "The branch changed. Close this preview and select the changes again.";
            confirm.disabled = true;
            return;
        }
        const rebasing = mode === "rebase";
        const preview = rebasing
            ? control.previewRebase(source, selected, target.value, choices)
            : control.previewChanges(source, selected, mode);
        if (!preview.isOk) {
            error.textContent = preview.error;
            confirm.disabled = true;
            return;
        }
        const conflicts = preview.value.conflicts;
        review.replaceChildren(
            div({
                className: style.hint,
                textContent: rebasing
                    ? "Replay this commit and later commits on a new branch, leaving out the selected changes. Merge commits replay as their net changes against their first parent."
                    : "This creates an undoable change on the current branch. Review any conflicts below.",
            }),
            ...conflicts.map((conflict) => {
                const picker = select(
                    {
                        className: style.select,
                        ariaLabel: conflict.location,
                        onchange: () => {
                            if (picker.value)
                                choices.set(conflict.id, picker.value as "ours" | "theirs" | "both");
                            else choices.delete(conflict.id);
                            render();
                        },
                    },
                    option({ value: "", textContent: "Choose a resolution…" }),
                    option({ value: "ours", textContent: `Keep current: ${conflict.ours ?? "Deleted"}` }),
                    option({ value: "theirs", textContent: `Use incoming: ${conflict.theirs ?? "Deleted"}` }),
                    ...(conflict.kind === "text"
                        ? [option({ value: "both", textContent: "Keep both" })]
                        : []),
                );
                picker.value = String(choices.get(conflict.id) ?? "");
                return label(
                    { className: style.field },
                    `${conflict.location}${conflict.field ? ` › ${conflict.field}` : ""}`,
                    picker,
                );
            }),
            ...(conflicts.length === 0 ? [div({ className: style.hint, textContent: "No conflicts." })] : []),
        );
        confirm.disabled = conflicts.some((c) => !choices.has(c.id));
        apply = () => {
            // Rebuild the preview after choices, but reject any edits made while reviewing it.
            if (control.head !== head) {
                render();
                return;
            }
            const result =
                rebasing && "steps" in preview.value
                    ? control.rebase(preview.value, branch.value, choices)
                    : "direction" in preview.value
                      ? control.applyChanges(preview.value, choices)
                      : undefined;
            if (!result) return;
            if (result.isOk) finish(result.value);
            else {
                error.textContent = result.error;
                render();
            }
        };
    };
    dialog.append(
        div({ className: style.viewHeader, textContent: title }),
        ...(mode === "rebase"
            ? [
                  div(
                      { className: style.form },
                      label({ className: style.field }, "Rebase onto", target),
                      label({ className: style.field }, "New branch", branch),
                  ),
              ]
            : []),
        review,
        error,
        div(
            { className: style.viewFooter },
            button({ className: style.button, textContent: "Cancel", onclick: () => dialog.remove() }),
            confirm,
        ),
    );
    document.body.append(dialog);
    render();
    dialog.showModal();
}
