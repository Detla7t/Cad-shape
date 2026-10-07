// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "@chili3d/core";
import { div } from "@chili3d/element";
import {
    exportMachineProfiles,
    importMachineProfiles,
    MACHINE_KINDS,
    machineProfileFileName,
    resolveMachine,
    userMachines,
} from "../machines";
import type { LinearAxisName, MachineKind, MachineProfileData, RotaryAxisName } from "../model/machine";
import { postProcessors } from "../model/post";
import type { SetupData } from "../model/setup";
import style from "./camStudio.module.css";
import {
    checkField,
    iconButton,
    numberField,
    parameterRow,
    row,
    section,
    selectField,
    t,
    textButton,
    textField,
    vectorField,
} from "./dom";
import { KIND_LABELS } from "./setupPanel";
import { commitMachines, nextName } from "./studioEdits";
import type { StudioHost } from "./studioHost";

/**
 * The machine profile editor. It edits a working copy (`machineDraft`) and saves it to the
 * document — where it travels with the file and shadows a library profile of the same id —
 * to the browser's library, or as a new profile; profiles import from and export to JSON.
 */

type Draft = Record<string, unknown>;

/** A copy of `value` with `path` set (or removed for `undefined`). */
export function setPath(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
    if (path.length === 0) return next;
    const [head, ...rest] = path;
    const container = Array.isArray(value) ? [...value] : { ...((value ?? {}) as Draft) };
    const child = setPath((container as Record<string | number, unknown>)[head], rest, next);
    if (child === undefined && !Array.isArray(container)) delete (container as Draft)[head as string];
    else (container as Record<string | number, unknown>)[head] = child;
    return container;
}

const LINEAR: readonly LinearAxisName[] = ["X", "Y", "Z", "U", "V", "W"];
const ROTARY: readonly RotaryAxisName[] = ["A", "B", "C"];

export function renderMachinePanel(host: StudioHost, setup: SetupData | undefined): HTMLElement {
    const draft = host.state.machineDraft;
    if (draft === undefined) return div({ className: style.note, textContent: t("cam.machine.none") });
    const set = (path: readonly (string | number)[], value: unknown) => {
        host.state.machineDraft = setPath(draft, path, value) as MachineProfileData;
        host.refresh();
    };
    const num = (
        path: readonly (string | number)[],
        labelKey: I18nKeys | string,
        unit?: string,
        optional = true,
    ) => {
        let value: unknown = draft;
        for (const key of path) value = (value as Record<string | number, unknown> | undefined)?.[key];
        return row(
            labelKey.startsWith("cam.") ? t(labelKey as I18nKeys) : labelKey,
            numberField(
                `machine.${path.join(".")}`,
                typeof value === "number" ? value : undefined,
                (v) => set(path, v),
                { optional },
            ),
            unit,
        );
    };
    const source = resolveMachine(host.studio, draft.id)?.source;
    const element = div({});
    element.append(
        div({
            className: style.note,
            textContent:
                source === undefined ? t("cam.machine.new") : t(`cam.machine.source.${source}` as I18nKeys),
        }),
        section(
            t("cam.machineEditor"),
            row(
                t("cam.machine.id"),
                textField("machine.id", draft.id, (id) => id.trim() && set(["id"], id.trim())),
            ),
            row(
                t("cam.name"),
                textField("machine.name", draft.name, (name) => name.trim() && set(["name"], name.trim())),
            ),
            row(
                t("cam.machine.vendor"),
                textField("machine.vendor", draft.vendor ?? "", (vendor) =>
                    set(["vendor"], vendor.trim() || undefined),
                ),
            ),
            row(
                t("cam.machine.kind"),
                selectField(
                    "machine.kind",
                    MACHINE_KINDS.map((kind) => ({ value: kind, label: t(KIND_LABELS[kind]) })),
                    draft.kind,
                    (kind) => set(["kind"], kind as MachineKind),
                ),
            ),
            num(["maxFeed"], "cam.machine.maxFeed", "mm/min", false),
            num(["rapidFeed"], "cam.machine.rapidFeed", "mm/min", false),
        ),
        axesSection(draft, set),
    );
    if (draft.kind === "mill") {
        element.append(rotarySection(draft, set));
        if ((draft.rotaryAxes?.length ?? 0) > 0) element.append(kinematicsSection(draft, set, num));
        element.append(
            section(
                t("cam.machine.spindle"),
                num(["spindle", "minRpm"], "cam.machine.minRpm", "rpm"),
                num(["spindle", "maxRpm"], "cam.machine.maxRpm", "rpm"),
                num(["spindle", "powerKw"], "cam.machine.power", "kW"),
            ),
        );
    }
    if (draft.kind === "waterjet" || draft.kind === "plasma" || draft.kind === "laser") {
        element.append(
            section(
                t("cam.machine.cutting"),
                num(["cutting", "kerf"], "cam.machine.kerf", "mm", false),
                num(["cutting", "pierceDelay"], "cam.machine.pierceDelay", "s"),
                num(["cutting", "pierceHeight"], "cam.machine.pierceHeight", "mm"),
                num(["cutting", "cutHeight"], "cam.machine.cutHeight", "mm"),
                ...(draft.kind === "plasma"
                    ? [
                          row(
                              t("cam.machine.thc"),
                              checkField("machine.thc", draft.cutting?.torchHeightControl === true, (v) =>
                                  set(["cutting", "torchHeightControl"], v),
                              ),
                          ),
                      ]
                    : []),
                ...(draft.kind === "waterjet"
                    ? [num(["cutting", "abrasiveRate"], "cam.machine.abrasive", "kg/min")]
                    : []),
            ),
        );
    }
    if (draft.kind === "wireEdm") {
        element.append(
            section(
                t("cam.machine.wire"),
                num(["wire", "wireDiameter"], "cam.machine.wireDiameter", "mm", false),
                num(["wire", "sparkGap"], "cam.machine.sparkGap", "mm", false),
                num(["wire", "maxTaper"], "cam.machine.maxTaper", "°", false),
                num(["wire", "programPlaneHeight"], "cam.machine.programPlane", "mm", false),
                num(["wire", "uvPlaneHeight"], "cam.machine.uvPlane", "mm", false),
            ),
        );
    }
    if (draft.kind === "printer") {
        element.append(
            section(
                t("cam.machine.printer"),
                num(["printer", "bed", "x"], "cam.machine.bedX", "mm", false),
                num(["printer", "bed", "y"], "cam.machine.bedY", "mm", false),
                num(["printer", "maxHeight"], "cam.machine.maxHeight", "mm", false),
                num(["printer", "nozzleDiameter"], "cam.machine.nozzle", "mm", false),
                num(["printer", "filamentDiameter"], "cam.machine.filament", "mm", false),
                row(
                    t("cam.machine.flavor"),
                    selectField(
                        "machine.flavor",
                        ["marlin", "prusa", "klipper", "reprapfirmware"].map((value) => ({
                            value,
                            label: value,
                        })),
                        draft.printer?.flavor ?? "marlin",
                        (flavor) => set(["printer", "flavor"], flavor),
                    ),
                ),
            ),
        );
    }
    element.append(postSection(draft, set));
    element.append(
        section(
            t("cam.tools"),
            div({
                className: style.note,
                textContent: t("cam.machine.toolCount{0}", draft.tools?.length ?? 0),
            }),
            ...(setup?.tools !== undefined && setup.tools.length > 0
                ? [
                      textButton(t("cam.machine.takeTools"), () => {
                          const ids = new Set(setup.tools!.map((tool) => tool.id));
                          set(
                              ["tools"],
                              [...(draft.tools ?? []).filter((tool) => !ids.has(tool.id)), ...setup.tools!],
                          );
                      }),
                  ]
                : []),
        ),
    );
    element.append(actions(host, setup, draft, source));
    return element;
}

function axesSection(
    draft: MachineProfileData,
    set: (path: readonly (string | number)[], value: unknown) => void,
): HTMLElement {
    const rows = draft.linearAxes.map((axis, index) =>
        row(
            axis.name,
            div(
                { className: style.vector },
                selectField(
                    `machine.axis.${index}.name`,
                    LINEAR.map((x) => ({ value: x, label: x })),
                    axis.name,
                    (name) => set(["linearAxes", index, "name"], name),
                ),
                numberField(`machine.axis.${index}.min`, axis.min, (v) =>
                    set(["linearAxes", index, "min"], v ?? 0),
                ),
                numberField(`machine.axis.${index}.max`, axis.max, (v) =>
                    set(["linearAxes", index, "max"], v ?? 0),
                ),
                iconButton("icon-trash", t("cam.delete"), () =>
                    set(
                        ["linearAxes"],
                        draft.linearAxes.filter((_, i) => i !== index),
                    ),
                ),
            ),
            "mm",
        ),
    );
    const free = LINEAR.find((name) => !draft.linearAxes.some((axis) => axis.name === name));
    return section(
        t("cam.machine.linearAxes"),
        ...rows,
        ...(free === undefined
            ? []
            : [
                  textButton(t("cam.machine.addAxis"), () =>
                      set(["linearAxes"], [...draft.linearAxes, { name: free, min: 0, max: 100 }]),
                  ),
              ]),
    );
}

function rotarySection(
    draft: MachineProfileData,
    set: (path: readonly (string | number)[], value: unknown) => void,
): HTMLElement {
    const axes = draft.rotaryAxes ?? [];
    const rows = axes.flatMap((axis, index) => [
        row(
            axis.name,
            div(
                { className: style.vector },
                selectField(
                    `machine.rot.${index}.name`,
                    ROTARY.map((x) => ({ value: x, label: x })),
                    axis.name,
                    (name) => set(["rotaryAxes", index, "name"], name),
                ),
                selectField(
                    `machine.rot.${index}.carrier`,
                    [
                        { value: "table", label: t("cam.machine.table") },
                        { value: "head", label: t("cam.machine.head") },
                    ],
                    axis.carrier,
                    (carrier) => set(["rotaryAxes", index, "carrier"], carrier),
                ),
                iconButton("icon-trash", t("cam.delete"), () =>
                    set(
                        ["rotaryAxes"],
                        axes.filter((_, i) => i !== index),
                    ),
                ),
            ),
        ),
        row(
            `${axis.name} ${t("cam.machine.direction")}`,
            vectorField(`machine.rot.${index}.dir`, axis.direction, (direction) =>
                set(["rotaryAxes", index, "direction"], direction),
            ),
        ),
        row(
            `${axis.name} ${t("cam.machine.limits")}`,
            div(
                { className: style.vector },
                numberField(
                    `machine.rot.${index}.min`,
                    axis.min,
                    (v) => set(["rotaryAxes", index, "min"], v),
                    { optional: true },
                ),
                numberField(
                    `machine.rot.${index}.max`,
                    axis.max,
                    (v) => set(["rotaryAxes", index, "max"], v),
                    { optional: true },
                ),
            ),
            "°",
        ),
    ]);
    const free = ROTARY.find((name) => !axes.some((axis) => axis.name === name));
    return section(
        t("cam.machine.rotaryAxes"),
        ...rows,
        ...(free === undefined
            ? []
            : [
                  textButton(t("cam.machine.addAxis"), () =>
                      set(
                          ["rotaryAxes"],
                          [
                              ...axes,
                              {
                                  name: free,
                                  direction: free === "A" ? [1, 0, 0] : free === "B" ? [0, 1, 0] : [0, 0, 1],
                                  carrier: "table",
                              },
                          ],
                      ),
                  ),
              ]),
    );
}

function kinematicsSection(
    draft: MachineProfileData,
    set: (path: readonly (string | number)[], value: unknown) => void,
    num: (path: readonly (string | number)[], labelKey: I18nKeys | string, unit?: string) => HTMLElement,
): HTMLElement {
    const k = draft.kinematics;
    return section(
        t("cam.machine.kinematics"),
        row(
            t("cam.machine.kinematicsType"),
            selectField(
                "machine.kin.type",
                ["table-table", "head-head", "head-table"].map((value) => ({ value, label: value })),
                k?.type ?? "table-table",
                (type) =>
                    set(["kinematics"], {
                        chain: draft.rotaryAxes?.map((axis) => axis.name) ?? [],
                        ...k,
                        type,
                    }),
            ),
        ),
        row(
            t("cam.machine.chain"),
            textField("machine.kin.chain", (k?.chain ?? []).join(", "), (text) =>
                set(["kinematics"], {
                    type: "table-table",
                    ...k,
                    chain: text
                        .split(/[\s,]+/)
                        .map((x) => x.trim().toUpperCase())
                        .filter((x): x is RotaryAxisName => (ROTARY as readonly string[]).includes(x)),
                }),
            ),
        ),
        num(["kinematics", "pivotLength"], "cam.machine.pivot", "mm"),
        row(
            t("cam.machine.tableCenter"),
            vectorField(
                "machine.kin.center",
                (k?.tableCenter as [number, number, number] | undefined) ?? [0, 0, 0],
                (center) =>
                    set(["kinematics"], { type: "table-table", chain: [], ...k, tableCenter: center }),
            ),
            "mm",
        ),
        row(
            t("cam.machine.tcp"),
            checkField("machine.kin.tcp", k?.toolCenterPointControl === true, (v) =>
                set(["kinematics"], { type: "table-table", chain: [], ...k, toolCenterPointControl: v }),
            ),
        ),
    );
}

function postSection(
    draft: MachineProfileData,
    set: (path: readonly (string | number)[], value: unknown) => void,
): HTMLElement {
    const posts = postProcessors(draft.kind);
    const post = posts.find((x) => x.id === draft.post.id);
    const values = { ...post?.defaultOptions, ...draft.post.options };
    const rows = (post?.parameters ?? []).flatMap(
        (spec) =>
            parameterRow(
                spec,
                values,
                (key, value) => set(["post", "options", key], value),
                "machine.post",
            ) ?? [],
    );
    return section(
        t("cam.machine.post"),
        row(
            t("cam.postProcessor"),
            selectField(
                "machine.post.id",
                [
                    ...posts.map((x) => ({ value: x.id, label: x.name })),
                    ...(post === undefined ? [{ value: draft.post.id, label: draft.post.id }] : []),
                ],
                draft.post.id,
                (id) => set(["post"], { id }),
            ),
        ),
        ...rows,
    );
}

function actions(
    host: StudioHost,
    setup: SetupData | undefined,
    draft: MachineProfileData,
    source: "document" | "user" | "library" | undefined,
): HTMLElement {
    const saveToDocument = (profile: MachineProfileData, name: string) =>
        commitMachines(host.studio, name, [
            ...host.studio.machines.filter((x) => x.id !== profile.id),
            profile,
        ]);
    return div(
        { className: style.buttons },
        textButton(
            t("cam.machine.saveDocument"),
            () => {
                saveToDocument(draft, "save machine");
                host.toast(t("cam.machine.saved"));
            },
            true,
            "save-machine",
        ),
        textButton(t("cam.machine.saveLibrary"), () => {
            host.toast(userMachines.save(draft) ? t("cam.machine.saved") : t("cam.machine.notSaved"));
            host.refresh();
        }),
        textButton(t("cam.machine.duplicate"), () => {
            const ids = new Set([...host.studio.machines.map((x) => x.id), draft.id]);
            let n = 2;
            while (ids.has(`${draft.id}-${n}`)) n++;
            const copy: MachineProfileData = {
                ...draft,
                id: `${draft.id}-${n}`,
                name: nextName(
                    host.studio.machines.map((x) => x.name),
                    `${draft.name} copy`,
                ),
            };
            saveToDocument(copy, "new machine");
            host.state.machineDraft = copy;
            if (setup !== undefined) host.commitSetup("use new machine", { ...setup, machineId: copy.id });
            else host.refresh();
        }),
        textButton(t("cam.exportMachine"), () =>
            host.download(exportMachineProfiles([draft]), machineProfileFileName(draft)),
        ),
        textButton(t("cam.importMachine"), async () => {
            const text = await host.chooseFile(".json,application/json");
            if (text === undefined) return;
            const profiles = importMachineProfiles(text);
            if (!profiles.isOk) {
                host.toast(profiles.error);
                return;
            }
            host.state.machineDraft = profiles.value[0];
            host.refresh();
        }),
        ...(source === "document"
            ? [
                  textButton(t("cam.machine.removeDocument"), () => {
                      commitMachines(
                          host.studio,
                          "remove machine",
                          host.studio.machines.filter((x) => x.id !== draft.id),
                      );
                  }),
              ]
            : []),
        ...(source === "user"
            ? [
                  textButton(t("cam.machine.removeLibrary"), () => {
                      userMachines.remove(draft.id);
                      host.refresh();
                  }),
              ]
            : []),
        textButton(t("cam.close"), () => {
            host.state.machineDraft = undefined;
            host.select({ detail: "setup" });
        }),
    );
}
