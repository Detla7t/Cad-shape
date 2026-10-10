// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { EvaluationState, IEvaluationStateSource } from "@chili3d/core";
import { createElement, div, span } from "@chili3d/element";
import { resolveMachine } from "../machines";
import { postProcessors } from "../model/post";
import type { SetupData } from "../model/setup";
import style from "./camStudio.module.css";
import { parameterRow, row, section, selectField, t, textButton, textField } from "./dom";
import type { StudioHost } from "./studioHost";

const pre = createElement("pre");

/** Lines of a posted program shown under the post options. */
const PREVIEW_LINES = 400;

/**
 * Posting a setup: the post-processor (the machine's by default, any post for its kind),
 * the program name and the post's options — remembered on the setup — then Post: whatever
 * is missing or stale is generated first, and the program downloads as a file.
 */
export function renderPostPanel(host: StudioHost, setup: SetupData): HTMLElement {
    const machine = resolveMachine(host.studio, setup.machineId)?.profile;
    if (machine === undefined)
        return div({ className: style.error, textContent: `Unknown machine "${setup.machineId}"` });
    const posts = postProcessors(machine.kind);
    const wanted = setup.postId ?? machine.post.id;
    const post = posts.find((x) => x.id === wanted);
    const element = div({});
    const choices = posts.map((x) => ({ value: x.id, label: x.name }));
    // A post named by the setup or the machine but not loaded (a module missing from this
    // build): say so, and offer the posts there are, rather than silently using another.
    if (post === undefined) choices.unshift({ value: wanted, label: t("cam.postUnavailable{0}", wanted) });
    element.append(
        row(
            t("cam.postProcessor"),
            selectField("post.id", choices, wanted, (postId) => {
                const { postOptions: _options, ...rest } = setup;
                host.commitSetup("choose post", { ...rest, postId });
            }),
        ),
        row(
            t("cam.programName"),
            textField("post.program", setup.programName ?? setup.name, (value) => {
                const { programName: _old, ...rest } = setup;
                host.commitSetup(
                    "program name",
                    value.trim() === "" ? rest : { ...rest, programName: value.trim() },
                );
            }),
        ),
    );
    if (post === undefined) {
        element.append(
            div({
                className: style.error,
                textContent: posts.length === 0 ? t("cam.noPosts") : t("cam.postMissing{0}", wanted),
            }),
        );
        return element;
    }
    const values: Record<string, unknown> = {
        ...post.defaultOptions,
        ...(machine.post.id === post.id ? machine.post.options : undefined),
        ...setup.postOptions,
    };
    const rows = (post.parameters ?? []).flatMap(
        (spec) =>
            parameterRow(
                spec,
                values,
                (key, value) =>
                    host.commitSetup(`post ${key}`, {
                        ...setup,
                        postId: post.id,
                        postOptions: { ...setup.postOptions, [key]: value },
                    }),
                "post",
            ) ?? [],
    );
    if (rows.length > 0) element.append(section(t("cam.postOptions"), ...rows));
    element.append(
        div(
            { className: style.buttons },
            textButton(t("cam.postAndDownload"), () => void postSetup(host, setup.id, post.id), true, "post"),
        ),
        renderPostReadiness(host, setup.id),
    );
    const posted = host.state.posted;
    if (posted !== undefined && posted.setupId === setup.id) {
        const lines = posted.text.split("\n");
        const shown =
            lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…` : posted.text;
        element.append(section(posted.fileName, pre({ className: style.program, textContent: shown })));
    }
    return element;
}

const STATIC_SOURCE = (state: EvaluationState): IEvaluationStateSource => ({
    state: () => state,
    subscribe: () => () => {},
});

/**
 * Why the setup cannot be posted right now, at the post action: the generator's own
 * `postBlockers` (what `program` refuses with), each with the shared evaluation indicator —
 * the operation's live one, or the blocker's state for a part, machine or empty setup.
 * Re-rendered alone when the generator reports.
 */
export function renderPostReadiness(host: StudioHost, setupId: string): HTMLElement {
    const blockers = host.generator.postBlockers(setupId);
    const element = div({ className: style.postReadiness });
    element.dataset["postReadiness"] = setupId;
    element.dataset["blocked"] = String(blockers.length > 0);
    if (blockers.length === 0) return element;
    element.append(div({ className: style.sectionTitle, textContent: t("cam.postBlocked") }));
    for (const [index, blocker] of blockers.entries()) {
        const source =
            blocker.operationId === undefined
                ? STATIC_SOURCE(blocker.state)
                : host.generator.evaluationSource(blocker.operationId);
        const row = div(
            { className: style.blocker },
            host.detailIndicators.element(
                `post:${blocker.operationId ?? `${blocker.kind}:${index}`}`,
                source,
            ),
            span({ textContent: blocker.message }),
        );
        row.dataset["blocker"] = blocker.kind;
        element.append(row);
    }
    if (blockers.some((blocker) => blocker.kind === "missing" || blocker.kind === "stale"))
        element.append(div({ className: style.note, textContent: t("cam.postRegenerates") }));
    return element;
}

/** Generates what the setup still needs, posts it and downloads the program. */
export async function postSetup(host: StudioHost, setupId: string, postId?: string): Promise<boolean> {
    await host.generator.ensureSetup(setupId);
    const result = host.generator.post(setupId, postId);
    if (!result.isOk) {
        host.toast(result.error);
        host.refresh();
        return false;
    }
    host.download(result.value.text, result.value.fileName);
    host.state.posted = { setupId, fileName: result.value.fileName, text: result.value.text };
    host.toast(t("cam.posted{0}", result.value.fileName));
    host.refresh();
    return true;
}
