// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "@chili3d/core";
import { div, span } from "@chili3d/element";
import type { OperationStatus } from "../context/generator";
import { formatDuration, formatLength } from "../context/stats";
import { setupTools } from "../context/tools";
import { resolveMachine } from "../machines";
import type { CamOperationData, GeometrySelection, SetupData } from "../model/setup";
import style from "./camStudio.module.css";
import { parameterRow, row, section, selectField, t, textButton, textField } from "./dom";
import { type PickKind, pickGeometry } from "./picking";
import { handlerOf, setOperationParam, updateOperation } from "./studioEdits";
import type { StudioHost } from "./studioHost";

/** The operation editor: name, tool, picked geometry, the handler's parameters, the result. */

const PICK_LABELS: Record<PickKind, I18nKeys> = {
    face: "cam.pick.face",
    edge: "cam.pick.edge",
    sketch: "cam.pick.sketch",
    flatPattern: "cam.pick.flatPattern",
    body: "cam.pick.body",
};

export function statusDetail(status: OperationStatus): string | undefined {
    if (status.stats === undefined) return undefined;
    const ms =
        status.ms === undefined
            ? ""
            : status.ms < 1000
              ? `${Math.round(status.ms)} ms`
              : `${(status.ms / 1000).toFixed(1)} s`;
    return t(
        "cam.stats{0}{1}{2}{3}",
        ms,
        formatLength(status.stats.cutting),
        formatLength(status.stats.rapid),
        formatDuration(status.stats.seconds),
    );
}

function selectionSummary(selection: readonly GeometrySelection[]): string {
    if (selection.length === 0) return t("cam.nothingPicked");
    const counts = new Map<PickKind, number>();
    for (const pick of selection) counts.set(pick.kind, (counts.get(pick.kind) ?? 0) + 1);
    return [...counts].map(([kind, count]) => `${count} × ${t(PICK_LABELS[kind])}`).join(", ");
}

export function renderOperationPanel(
    host: StudioHost,
    setup: SetupData,
    operation: CamOperationData,
): HTMLElement {
    const write = (name: string, change: (op: CamOperationData) => CamOperationData) =>
        host.commitSetup(name, updateOperation(setup, operation.id, change));
    const handler = handlerOf(operation);
    const machine = resolveMachine(host.studio, setup.machineId)?.profile;
    const element = div({});
    element.append(
        row(
            t("cam.name"),
            textField(
                "op.name",
                operation.name,
                (name) => name.trim() && write("rename operation", (op) => ({ ...op, name: name.trim() })),
            ),
        ),
    );
    if (handler === undefined) {
        element.append(
            div({ className: style.error, textContent: t("cam.unknownOperation{0}", operation.type) }),
        );
        return element;
    }
    element.append(
        div({
            className: style.note,
            textContent: `${handler.label} · ${t(`cam.category.${handler.category}` as I18nKeys)}`,
        }),
    );
    if (machine !== undefined) {
        const tools = setupTools(setup, machine);
        element.append(
            row(
                t("cam.tool"),
                selectField(
                    "op.tool",
                    tools.map((tool) => ({ value: tool.id, label: `T${tool.number} ${tool.name}` })),
                    operation.toolId ?? tools[0]?.id,
                    (toolId) => write("operation tool", (op) => ({ ...op, toolId })),
                ),
            ),
        );
    }
    if (handler.selects !== undefined && handler.selects.length > 0) {
        const selection = operation.selection ?? [];
        element.append(
            section(
                t("cam.geometry"),
                div(
                    { className: style.chips },
                    span({ className: style.chip, textContent: selectionSummary(selection) }),
                ),
                div(
                    { className: style.buttons },
                    ...handler.selects.map((kind) =>
                        textButton(
                            t(PICK_LABELS[kind]),
                            async () => {
                                const picked = await pickGeometry(host.document, kind);
                                if (picked === undefined || picked.length === 0) return;
                                // Re-read the setup: the pick ran while the document was live.
                                const current = host.studio.setups.find((x) => x.id === setup.id) ?? setup;
                                host.commitSetup(
                                    "pick geometry",
                                    updateOperation(current, operation.id, (op) => ({
                                        ...op,
                                        selection: [
                                            ...(op.selection ?? []).filter((pick) => pick.kind !== kind),
                                            ...picked,
                                        ],
                                    })),
                                );
                            },
                            false,
                            `pick-${kind}`,
                        ),
                    ),
                    textButton(t("cam.clear"), () =>
                        write("clear geometry", (op) => ({ ...op, selection: [] })),
                    ),
                ),
            ),
        );
    }
    let specs: ReturnType<typeof handler.parameters> = [];
    try {
        specs = handler.parameters(operation);
    } catch (error) {
        element.append(div({ className: style.error, textContent: String(error) }));
    }
    const rows = specs.flatMap(
        (spec) =>
            parameterRow(spec, operation.params, (key, value) =>
                write(`set ${key}`, (op) => setOperationParam(op, key, value)),
            ) ?? [],
    );
    if (rows.length > 0) element.append(section(t("cam.parameters"), ...rows));

    element.append(renderOperationStatus(host, setup, operation));
    return element;
}

/**
 * The operation's result block — re-rendered alone when the generator reports, so a
 * value being typed in the parameters above is never wiped by a background regeneration.
 */
export function renderOperationStatus(
    host: StudioHost,
    setup: SetupData,
    operation: CamOperationData,
): HTMLElement {
    const status = host.generator.status(operation.id);
    const result = div({ className: style.section });
    result.dataset["opStatus"] = operation.id;
    result.dataset["state"] = status.stale ? "stale" : status.state;
    result.append(
        div(
            { className: style.sectionTitle },
            host.detailIndicators.element(
                `status:${operation.id}`,
                host.generator.evaluationSource(operation.id),
            ),
        ),
    );
    if (status.stale && status.staleReason !== undefined)
        result.append(div({ className: style.note, textContent: status.staleReason }));
    if (status.error !== undefined && !status.stale)
        result.append(div({ className: style.error, textContent: status.error }));
    const detail = statusDetail(status);
    if (detail !== undefined) result.append(div({ className: style.note, textContent: detail }));
    result.append(
        div(
            { className: style.buttons },
            textButton(
                t("cam.generate"),
                () => void host.generator.generateOperation(setup.id, operation.id),
                true,
                "generate-operation",
            ),
        ),
    );
    return result;
}
