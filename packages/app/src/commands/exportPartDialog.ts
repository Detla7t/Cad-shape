// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    type DialogButton,
    documentExportNameResolver,
    download,
    exportFileName,
    I18n,
    type IApplication,
    inspectionCsv,
    PubSub,
    type VisualNode,
} from "@chili3d/core";
import { button, div, input, label, option, select, span } from "@chili3d/element";
import style from "./exportPartDialog.module.css";

/** One entry of Onshape's Export format list. */
export interface PartExportFormat {
    /** The data exchange's key (`.step`, `.stl`, …), or `inspection` for the inspection list. */
    readonly id: string;
    /** Onshape's label. */
    readonly name: string;
    readonly extension: string;
    /** What the writer produces; shown, not chosen, when there is one. */
    readonly versions?: readonly string[];
    /** The format has an ASCII and a binary form. */
    readonly binary?: boolean;
    /** Why this build cannot write it: a closed format with no open-source writer. */
    readonly unavailable?: string;
}

const CLOSED = (name: string, owner: string) =>
    `${name} is ${owner}'s closed format; there is no open-source writer. Export STEP instead.`;

/** Onshape's list, in Onshape's order, plus the formats this kernel writes on top of it. */
export const PART_EXPORT_FORMATS: readonly PartExportFormat[] = [
    { id: ".x_t", name: "PARASOLID", extension: ".x_t", unavailable: CLOSED("Parasolid", "Siemens") },
    { id: ".sat", name: "ACIS", extension: ".sat", unavailable: CLOSED("ACIS", "Spatial") },
    { id: ".step", name: "STEP", extension: ".step", versions: ["AP214"] },
    { id: ".iges", name: "IGES", extension: ".iges", versions: ["5.3"] },
    { id: ".pvz", name: "PVZ", extension: ".pvz", unavailable: CLOSED("PVZ (Creo View)", "PTC") },
    { id: ".jt", name: "JT", extension: ".jt", unavailable: CLOSED("JT", "Siemens") },
    {
        id: ".3dm",
        name: "RHINO",
        extension: ".3dm",
        unavailable: "Rhino 3DM needs the openNURBS library, which this build does not bundle yet.",
    },
    { id: ".gltf", name: "GLTF", extension: ".gltf", versions: ["glTF 2.0"] },
    { id: ".glb", name: "GLB", extension: ".glb", versions: ["glTF 2.0"] },
    { id: ".obj", name: "OBJ", extension: ".obj" },
    { id: ".3mf", name: "3MF", extension: ".3mf", versions: ["3MF core 1.3"] },
    { id: ".stl", name: "STL", extension: ".stl", binary: true },
    { id: ".ply", name: "PLY", extension: ".ply", binary: true },
    { id: ".brep", name: "BREP", extension: ".brep", versions: ["OCCT"] },
    { id: "inspection", name: "Inspection list", extension: ".csv" },
];

/** The formats with what this application can actually write marked. */
export function partExportFormats(application: IApplication): PartExportFormat[] {
    const offered = new Set(application.dataExchange.exportFormats());
    return PART_EXPORT_FORMATS.map((format) =>
        format.id === "inspection" || format.unavailable || offered.has(format.id)
            ? format
            : { ...format, unavailable: `${format.name} is not available in this build.` },
    );
}

export interface PartExportSettings {
    readonly fileName: string;
    readonly format: PartExportFormat;
    readonly binary: boolean;
    /** Every part in its own file, packed into one zip. */
    readonly individual: boolean;
}

/** The data exchange's key for the format in the chosen form. */
export function exportTypeOf(format: PartExportFormat, binary: boolean): string {
    return format.binary && binary ? `${format.id} binary` : format.id;
}

/** Writes the nodes in the chosen format and hands the file out. */
export async function exportParts(
    application: IApplication,
    nodes: readonly VisualNode[],
    settings: PartExportSettings,
): Promise<void> {
    const { format } = settings;
    if (format.unavailable) throw new Error(format.unavailable);
    if (format.id === "inspection") {
        download([inspectionCsv(nodes[0].document)], settings.fileName);
        return;
    }
    const type = exportTypeOf(format, settings.binary);
    if (settings.individual && nodes.length > 1) {
        // Browsers block several automatic downloads: one zip holds one file per part.
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        const used = new Set<string>();
        for (const node of nodes) {
            const data = await application.dataExchange.export(type, [node]);
            if (!data) continue;
            let name = exportFileName(node.name, format.extension, Config.instance.preferences.exportRules);
            for (let n = 1; used.has(name); n++)
                name = `${name.slice(0, -format.extension.length)}-${n}${format.extension}`;
            used.add(name);
            zip.file(name, new Blob(data));
        }
        download([await zip.generateAsync({ type: "blob" })], settings.fileName.replace(/\.[^.]+$/, ".zip"));
        return;
    }
    const data = await application.dataExchange.export(type, [...nodes]);
    if (data) download(data, settings.fileName);
}

/**
 * Onshape's Export dialog for parts: the file name from the export rules (editable), the
 * format — Onshape's list, the closed ones explained rather than offered —, its version, the
 * options the writers honour (binary STL/PLY, one file per part in a zip) and Download as
 * the delivery. The dialog is the one place both the ribbon's Export and a part's Export… go.
 */
export function showExportPartDialog(application: IApplication, nodes: readonly VisualNode[]): void {
    if (!nodes.length) return;
    const document = nodes[0].document;
    const formats = partExportFormats(application);
    const resolver = documentExportNameResolver(document);
    const suggested = (format: PartExportFormat) =>
        exportFileName(
            nodes.length === 1 ? nodes[0].name : document.name,
            format.extension,
            Config.instance.preferences.exportRules,
            new Date(),
            resolver,
        );
    let format = formats.find((entry) => entry.id === ".step") ?? formats[0];
    let nameEdited = false;
    const name = input({ type: "text", value: suggested(format) });
    name.setAttribute("aria-label", I18n.translate("documents.exportDialog.fileName"));
    name.oninput = () => {
        nameEdited = true;
    };
    const rulesLink = button({
        className: style.link,
        textContent: I18n.translate("documents.exportDialog.viewRules"),
        onclick: () => PubSub.default.pub("openPreferences", document, "export"),
    });
    const formatSelect = select(
        {},
        ...formats.map((entry) => {
            const choice = option({ value: entry.id, textContent: entry.name, selected: entry === format });
            if (entry.unavailable) {
                choice.disabled = true;
                choice.title = entry.unavailable;
            }
            return choice;
        }),
    );
    formatSelect.setAttribute("aria-label", I18n.translate("documents.exportDialog.format"));
    const version = select({ disabled: true });
    version.setAttribute("aria-label", I18n.translate("documents.exportDialog.version"));
    const binary = input({ type: "checkbox", checked: true });
    binary.setAttribute("aria-label", I18n.translate("export.dialog.binary"));
    const binaryRow = label(
        { className: style.check },
        binary,
        span({ textContent: I18n.translate("export.dialog.binary") }),
    );
    const individual = input({ type: "checkbox", checked: nodes.length > 1, disabled: nodes.length < 2 });
    individual.setAttribute("aria-label", I18n.translate("export.dialog.individual"));
    const delivery = select(
        { disabled: true },
        option({ textContent: I18n.translate("documents.exportDialog.download") }),
    );
    const refresh = () => {
        version.replaceChildren(
            ...(format.versions ?? ["—"]).map((text) => option({ value: text, textContent: text })),
        );
        binaryRow.hidden = !format.binary;
        individual.disabled = nodes.length < 2 || format.id === "inspection";
        if (!nameEdited) name.value = suggested(format);
        else name.value = name.value.replace(/\.[^.]+$/, "") + format.extension;
    };
    formatSelect.onchange = () => {
        format = formats.find((entry) => entry.id === formatSelect.value) ?? format;
        refresh();
    };
    refresh();
    const field = (title: string, ...controls: Node[]) =>
        div({ className: style.field }, span({ textContent: title }), ...controls);
    const content = div(
        { className: style.dialog },
        field(
            I18n.translate("documents.exportDialog.fileName"),
            div({ className: style.row }, name, rulesLink),
            span({ className: style.muted, textContent: I18n.translate("documents.exportDialog.nameHint") }),
        ),
        field(
            I18n.translate("documents.exportDialog.format"),
            formatSelect,
            span({ className: style.muted, textContent: I18n.translate("export.dialog.unavailable") }),
        ),
        field(I18n.translate("documents.exportDialog.version"), version),
        field(
            I18n.translate("documents.exportDialog.options"),
            delivery,
            binaryRow,
            label(
                { className: style.check },
                individual,
                span({ textContent: I18n.translate("export.dialog.individual") }),
            ),
        ),
    );
    const settings = (): PartExportSettings => ({
        fileName: name.value.trim() || suggested(format),
        format,
        binary: binary.checked,
        individual: individual.checked && !individual.disabled,
    });
    const buttons: DialogButton[] = [
        {
            content: "documents.exportDialog.export",
            onclick: async () => {
                const chosen = settings();
                try {
                    await exportParts(application, nodes, chosen);
                    PubSub.default.pub("showToast", "documents.exportDialog.exported{0}", chosen.fileName);
                } catch (error) {
                    PubSub.default.pub(
                        "showToast",
                        "error.default:{0}",
                        error instanceof Error ? error.message : String(error),
                    );
                }
            },
        },
        { content: "common.cancel" },
    ];
    PubSub.default.pub("showDialog", "export.dialog.title", content, buttons);
}
