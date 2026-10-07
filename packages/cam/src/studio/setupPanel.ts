// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, type IDocument, type IShape, ShapeNode } from "@chili3d/core";
import { div, input, label, span } from "@chili3d/element";
import { findShapeNode } from "../context/setupGeometry";
import { makeWcs, modelToWcsMatrix, type WcsData, wcsPointToModel, wcsYAxis } from "../context/wcs";
import {
    availableMachines,
    exportMachineProfiles,
    importMachineProfiles,
    machineProfileFileName,
    resolveMachine,
} from "../machines";
import type { MachineKind } from "../model/machine";
import type { SetupData, StockData } from "../model/setup";
import type { Vec3 } from "../model/toolpath";
import style from "./camStudio.module.css";
import {
    type Choice,
    iconButton,
    numberField,
    row,
    section,
    selectField,
    t,
    textButton,
    textField,
    vectorField,
} from "./dom";
import { pickBodies, pickPlanarFace, pickVertex } from "./picking";
import { commitMachines, defaultStock, documentBodies } from "./studioEdits";
import type { StudioHost } from "./studioHost";

/** The setup editor: name, machine, parts, work coordinates, stock, program name. */

export const KIND_LABELS: Record<MachineKind, I18nKeys> = {
    mill: "cam.kind.mill",
    waterjet: "cam.kind.waterjet",
    plasma: "cam.kind.plasma",
    laser: "cam.kind.laser",
    wireEdm: "cam.kind.wireEdm",
    printer: "cam.kind.printer",
};

export function machineChoices(host: StudioHost): Choice[] {
    return availableMachines(host.studio).map(({ profile, source }) => ({
        value: profile.id,
        label:
            source === "library"
                ? profile.name
                : `${profile.name} — ${t(source === "document" ? "cam.machine.source.document" : "cam.machine.source.user")}`,
        group: t(KIND_LABELS[profile.kind]),
    }));
}

export function renderSetupPanel(host: StudioHost, setup: SetupData): HTMLElement {
    const update = (name: string, change: Partial<SetupData>) =>
        host.commitSetup(name, { ...setup, ...change });
    const machine = resolveMachine(host.studio, setup.machineId)?.profile;
    const element = div({});

    element.append(
        row(
            t("cam.name"),
            textField(
                "setup.name",
                setup.name,
                (name) => name.trim() && update("rename setup", { name: name.trim() }),
            ),
        ),
        row(
            t("cam.machine"),
            selectField("setup.machine", machineChoices(host), setup.machineId, (machineId) => {
                const next = resolveMachine(host.studio, machineId)?.profile;
                const kindChanged = next !== undefined && machine !== undefined && next.kind !== machine.kind;
                update("change machine", {
                    machineId,
                    ...(kindChanged ? { stock: defaultStock(next) } : {}),
                });
            }),
        ),
    );
    if (machine === undefined)
        element.append(div({ className: style.error, textContent: `Unknown machine "${setup.machineId}"` }));
    element.append(
        div(
            { className: style.buttons },
            textButton(
                t("cam.editMachine"),
                () => {
                    if (machine === undefined) return;
                    host.state.machineDraft = structuredClone(machine);
                    host.select({ detail: "machine" });
                },
                false,
                "edit-machine",
            ),
            textButton(t("cam.importMachine"), () => void importProfiles(host, setup)),
            textButton(t("cam.exportMachine"), () => {
                if (machine !== undefined)
                    host.download(exportMachineProfiles([machine]), machineProfileFileName(machine));
            }),
        ),
    );

    element.append(partsSection(host, setup), wcsSection(host, setup), stockSection(host, setup));
    element.append(
        section(
            t("cam.programName"),
            row(
                t("cam.programName"),
                textField("setup.program", setup.programName ?? "", (value) => {
                    const { programName: _old, ...rest } = setup;
                    host.commitSetup(
                        "program name",
                        value.trim() === "" ? rest : { ...rest, programName: value.trim() },
                    );
                }),
            ),
        ),
    );
    return element;
}

async function importProfiles(host: StudioHost, setup: SetupData): Promise<void> {
    const text = await host.chooseFile(".json,application/json");
    if (text === undefined) return;
    const profiles = importMachineProfiles(text);
    if (!profiles.isOk) {
        host.toast(profiles.error);
        return;
    }
    const ids = new Set(profiles.value.map((profile) => profile.id));
    commitMachines(host.studio, "import machine", [
        ...host.studio.machines.filter((x) => !ids.has(x.id)),
        ...profiles.value,
    ]);
    host.commitSetup("use imported machine", { ...setup, machineId: profiles.value[0].id });
}

function partsSection(host: StudioHost, setup: SetupData): HTMLElement {
    const bodies = documentBodies(host.document.modelManager.findNodes());
    const list = div({ className: style.checkList });
    if (bodies.length === 0) list.append(div({ className: style.note, textContent: t("cam.noBodies") }));
    for (const body of bodies) {
        const box = input({ type: "checkbox", className: style.check });
        box.checked = setup.partIds.includes(body.id);
        box.dataset["field"] = `part.${body.id}`;
        box.addEventListener("change", () => {
            const partIds = box.checked
                ? [...setup.partIds, body.id]
                : setup.partIds.filter((id) => id !== body.id);
            host.commitSetup(box.checked ? "add part" : "remove part", { ...setup, partIds });
        });
        list.append(label({ className: style.checkItem }, box, span({ textContent: body.name })));
    }
    return section(
        t("cam.parts"),
        list,
        div(
            { className: style.buttons },
            textButton(t("cam.pickParts"), async () => {
                const picked = await pickBodies(host.document);
                if (picked === undefined || picked.length === 0) return;
                host.commitSetup("pick parts", {
                    ...setup,
                    partIds: [...new Set([...setup.partIds, ...picked])],
                });
            }),
        ),
    );
}

/** The setup's parts' bounds in a frame with the WCS's axes at the model origin. */
export function partsBoundsInFrame(document: IDocument, partIds: readonly string[], wcs: WcsData) {
    const rotation = modelToWcsMatrix({ origin: [0, 0, 0], xAxis: wcs.xAxis, zAxis: wcs.zAxis });
    let min: Vec3 | undefined;
    let max: Vec3 | undefined;
    for (const id of partIds) {
        const node = findShapeNode(document, id);
        if (!(node instanceof ShapeNode) || !node.shape.isOk) continue;
        let moved: IShape | undefined;
        try {
            moved = node.shape.value.transformedMul(node.worldTransform().multiply(rotation));
            const box = moved.boundingBox();
            min =
                min === undefined
                    ? [box.min.x, box.min.y, box.min.z]
                    : [Math.min(min[0], box.min.x), Math.min(min[1], box.min.y), Math.min(min[2], box.min.z)];
            max =
                max === undefined
                    ? [box.max.x, box.max.y, box.max.z]
                    : [Math.max(max[0], box.max.x), Math.max(max[1], box.max.y), Math.max(max[2], box.max.z)];
        } finally {
            moved?.dispose();
        }
    }
    return min === undefined || max === undefined ? undefined : { min, max };
}

export type WcsPreset = "model" | "topCenter" | "topCorner" | "bottomCorner";

/** The WCS a preset gives: the model origin, or a point of the parts' box in the current axes. */
export function presetWcs(document: IDocument, setup: SetupData, preset: WcsPreset): WcsData | undefined {
    if (preset === "model") return { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] };
    const bounds = partsBoundsInFrame(document, setup.partIds, setup.wcs);
    if (bounds === undefined) return undefined;
    const { min, max } = bounds;
    const local: Vec3 =
        preset === "topCenter"
            ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2]]
            : preset === "topCorner"
              ? [min[0], min[1], max[2]]
              : [min[0], min[1], min[2]];
    const origin = wcsPointToModel(
        { origin: [0, 0, 0], xAxis: setup.wcs.xAxis, zAxis: setup.wcs.zAxis },
        local,
    );
    return { ...setup.wcs, origin };
}

function wcsSection(host: StudioHost, setup: SetupData): HTMLElement {
    const setWcs = (name: string, wcs: WcsData) =>
        host.commitSetup(name, { ...setup, wcs: makeWcs(wcs.origin, wcs.zAxis, wcs.xAxis) });
    const presets: Choice[] = [
        { value: "model", label: t("cam.wcs.model") },
        { value: "topCenter", label: t("cam.wcs.topCenter") },
        { value: "topCorner", label: t("cam.wcs.topCorner") },
        { value: "bottomCorner", label: t("cam.wcs.bottomCorner") },
    ];
    const preset = selectField(
        "wcs.preset",
        presets,
        "",
        (value) => {
            const wcs = presetWcs(host.document, setup, value as WcsPreset);
            if (wcs === undefined) {
                host.toast(t("cam.noParts"));
                return;
            }
            setWcs("WCS preset", wcs);
        },
        t("cam.wcs.preset"),
    );
    return section(
        t("cam.wcs"),
        row(t("cam.wcs.presetRow"), preset),
        row(
            t("cam.wcs.origin"),
            vectorField("wcs.origin", setup.wcs.origin, (origin) =>
                setWcs("WCS origin", { ...setup.wcs, origin }),
            ),
            "mm",
        ),
        row(
            t("cam.wcs.zAxis"),
            vectorField("wcs.z", setup.wcs.zAxis, (zAxis) => setWcs("WCS Z axis", { ...setup.wcs, zAxis })),
        ),
        row(
            t("cam.wcs.xAxis"),
            vectorField("wcs.x", setup.wcs.xAxis, (xAxis) => setWcs("WCS X axis", { ...setup.wcs, xAxis })),
        ),
        div(
            { className: style.buttons },
            textButton(t("cam.wcs.pickFace"), async () => {
                const face = await pickPlanarFace(host.document);
                if (face !== undefined)
                    setWcs("WCS from face", {
                        origin: face.origin,
                        zAxis: face.normal,
                        xAxis: setup.wcs.xAxis,
                    });
            }),
            textButton(t("cam.wcs.pickOrigin"), async () => {
                const point = await pickVertex(host.document);
                if (point !== undefined) setWcs("WCS origin", { ...setup.wcs, origin: point });
            }),
            iconButton("icon-mirror", t("cam.wcs.flip"), () => {
                // Turn over about X: z → −z keeps x, so y turns over too (still right-handed).
                const z = setup.wcs.zAxis;
                setWcs("flip WCS", { ...setup.wcs, zAxis: [-z[0], -z[1], -z[2]] });
            }),
            iconButton("icon-rotate", t("cam.wcs.rotate"), () => {
                setWcs("rotate WCS", { ...setup.wcs, xAxis: wcsYAxis(setup.wcs) });
            }),
        ),
    );
}

const STOCK_DEFAULTS: Record<StockData["kind"], (setup: SetupData) => StockData> = {
    box: () => ({ kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } }),
    cylinder: () => ({ kind: "cylinder", diameter: 50, length: 60, zTop: 1 }),
    body: (setup) => ({ kind: "body", nodeId: setup.partIds[0] ?? "" }),
    sheet: () => ({ kind: "sheet", width: 1000, height: 500, thickness: 6 }),
};

function stockSection(host: StudioHost, setup: SetupData): HTMLElement {
    const stock = setup.stock;
    const setStock = (name: string, next: StockData) => host.commitSetup(name, { ...setup, stock: next });
    const kinds: Choice[] = (["box", "cylinder", "body", "sheet"] as const).map((kind) => ({
        value: kind,
        label: t(`cam.stock.${kind}` as I18nKeys),
    }));
    const rows: HTMLElement[] = [
        row(
            t("cam.machine.kind"),
            selectField("stock.kind", kinds, stock.kind, (kind) =>
                setStock("stock kind", STOCK_DEFAULTS[kind as StockData["kind"]](setup)),
            ),
        ),
    ];
    const num = (key: string, labelKey: I18nKeys, value: number, apply: (v: number) => StockData) =>
        row(
            t(labelKey),
            numberField(`stock.${key}`, value, (v) => v !== undefined && setStock("stock", apply(v)), {
                min: 0,
            }),
            "mm",
        );
    switch (stock.kind) {
        case "box": {
            const m = stock.margin;
            rows.push(
                num("x", "cam.stock.marginX", m.x, (x) => ({ ...stock, margin: { ...m, x } })),
                num("y", "cam.stock.marginY", m.y, (y) => ({ ...stock, margin: { ...m, y } })),
                num("zTop", "cam.stock.zTop", m.zTop, (zTop) => ({ ...stock, margin: { ...m, zTop } })),
                num("zBottom", "cam.stock.zBottom", m.zBottom, (zBottom) => ({
                    ...stock,
                    margin: { ...m, zBottom },
                })),
            );
            break;
        }
        case "cylinder":
            rows.push(
                num("diameter", "cam.stock.diameter", stock.diameter, (diameter) => ({ ...stock, diameter })),
                num("length", "cam.stock.length", stock.length, (length) => ({ ...stock, length })),
                num("zTop", "cam.stock.zTop", stock.zTop, (zTop) => ({ ...stock, zTop })),
            );
            break;
        case "sheet":
            rows.push(
                num("width", "cam.stock.width", stock.width, (width) => ({ ...stock, width })),
                num("height", "cam.stock.height", stock.height, (height) => ({ ...stock, height })),
                num("thickness", "cam.stock.thickness", stock.thickness, (thickness) => ({
                    ...stock,
                    thickness,
                })),
            );
            break;
        case "body": {
            const bodies = documentBodies(host.document.modelManager.findNodes()).map((node) => ({
                value: node.id,
                label: node.name,
            }));
            rows.push(
                row(
                    t("cam.stock.body"),
                    selectField("stock.node", bodies, stock.nodeId, (nodeId) =>
                        setStock("stock body", { kind: "body", nodeId }),
                    ),
                ),
            );
            break;
        }
    }
    return section(t("cam.stock"), ...rows);
}
