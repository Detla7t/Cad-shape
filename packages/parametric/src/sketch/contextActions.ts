// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentPanels,
    FolderNode,
    formatConfiguredValue,
    isSelectorInput,
    NodeActions,
    type NodeMenuAction,
    PubSub,
    parseConfiguredValue,
    selectorOptions,
    Transaction,
} from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchEditor } from "./editor/sketchEditor";
import { SketchNode } from "./sketchNode";

function editText(label: string, value: string, apply: (text: string) => void, multiline = false) {
    const root = document.createElement("label");
    root.textContent = label;
    const field = document.createElement(multiline ? "textarea" : "input");
    field.value = value;
    field.setAttribute("aria-label", label);
    root.append(field);
    PubSub.default.pub("showDialog", "body.sketch", root, () => apply(field.value));
}
function showText(node: SketchNode, text: string) {
    const content = document.createElement("pre");
    content.textContent = text;
    content.style.whiteSpace = "pre-wrap";
    PubSub.default.pub("showFloatPanel", {
        title: "body.sketch",
        content,
        document: node.document,
        width: 420,
        height: 320,
    });
}
NodeActions.register((node) => {
    if (!(node instanceof SketchNode)) return [];
    const doc = node.document;
    const change = (name: string, action: () => void) => Transaction.execute(doc, name, action);
    const select = () => doc.selection.setSelectedNodes([node], false);
    const enter = () => {
        select();
        SketchEditor.enter(node);
    };
    const configure = () => {
        const selectors = doc.variables.configurationInputs.filter(isSelectorInput);
        if (!selectors.length) {
            DocumentPanels.open("configuration", doc);
            return;
        }
        const root = document.createElement("div");
        const input = document.createElement("select");
        input.setAttribute("aria-label", "Suppression configuration");
        for (const s of selectors) input.add(new Option(s.name, s.id));
        const rows = document.createElement("div");
        const checks = new Map<string, HTMLInputElement>();
        const render = () => {
            checks.clear();
            rows.replaceChildren();
            const s = selectors.find((s) => s.id === input.value)!;
            for (const option of selectorOptions(s)) {
                const row = document.createElement("label");
                row.style.display = "block";
                const check = document.createElement("input");
                check.type = "checkbox";
                const configured =
                    typeof node.suppression === "string" ? parseConfiguredValue(node.suppression) : undefined;
                check.checked =
                    configured?.isOk && configured.value.input === s.name
                        ? configured.value.arms.find((arm) => arm.option === option)?.value === "true"
                        : node.suppressed;
                check.setAttribute("aria-label", `Suppress ${option}`);
                checks.set(option, check);
                row.append(check, document.createTextNode(option));
                rows.append(row);
            }
        };
        input.onchange = render;
        root.append(input, rows);
        render();
        PubSub.default.pub("showDialog", "body.sketch", root, () => {
            const s = selectors.find((s) => s.id === input.value)!;
            change(
                "Configure sketch suppression",
                () =>
                    (node.suppression = formatConfiguredValue({
                        input: s.name,
                        arms: [...checks].map(([option, check]) => ({
                            option,
                            value: String(check.checked),
                        })),
                    })),
            );
        });
    };
    const actions: NodeMenuAction[] = [
        {
            id: "rename",
            label: "Rename",
            run: () =>
                editText("Sketch name", node.name, (text) =>
                    change("Rename sketch", () => (node.name = text.trim() || node.name)),
                ),
        },
        { id: "edit", label: "Edit…", run: enter },
        {
            id: "copy",
            label: "Copy sketch",
            run: () => change("Copy sketch", () => doc.modelManager.addNode(node.clone())),
        },
        { id: "dimensions", label: "Show dimensions", run: enter },
        {
            id: "folder",
            label: "Add selection to folder…",
            run: () =>
                editText("Folder name", "Sketches", (name) =>
                    change("Move sketch to folder", () => {
                        const existing = doc.modelManager
                            .findNodes()
                            .find((n) => n instanceof FolderNode && n.name === name);
                        const folder =
                            existing instanceof FolderNode
                                ? existing
                                : new FolderNode({ document: doc, name });
                        if (!folder.parent) doc.modelManager.rootNode.add(folder);
                        folder.transfer(node);
                    }),
                ),
        },
        {
            id: "hide",
            label: node.visible ? "Hide" : "Show",
            run: () => change("Toggle sketch visibility", () => (node.visible = !node.visible)),
        },
        {
            id: "export",
            label: "Export as DXF/SVG…",
            run: () => {
                select();
                PubSub.default.pub("executeCommand", "sketch.export");
            },
        },
        {
            id: "suppress",
            label: node.suppressed ? "Unsuppress" : "Suppress",
            run: () => change("Suppress sketch", () => (node.suppression = !node.suppressed)),
        },
        {
            id: "dynamic",
            label: "Dynamic suppression",
            children: [
                {
                    id: "always",
                    label: "Always suppressed",
                    run: () => change("Suppress sketch", () => (node.suppression = true)),
                },
                {
                    id: "never",
                    label: "Never suppressed",
                    run: () => change("Unsuppress sketch", () => (node.suppression = false)),
                },
                { id: "configured", label: "By configuration…", run: configure },
            ],
        },
        { id: "configure", label: "Configure suppression", run: configure },
        {
            id: "comment",
            label: "Add comment",
            run: () =>
                editText(
                    "Sketch comment",
                    node.comment,
                    (text) => change("Edit sketch comment", () => (node.comment = text)),
                    true,
                ),
        },
        {
            id: "zoom",
            label: "Zoom to selection",
            run: () => {
                select();
                doc.application.activeView?.cameraController.fitContent();
            },
        },
        {
            id: "normal",
            label: "View normal to",
            run: () => {
                const v = doc.application.activeView;
                if (!v) return;
                const p = node.plane;
                const distance = v.cameraController.cameraPosition.distanceTo(
                    v.cameraController.cameraTarget,
                );
                v.cameraController.lookAt(p.origin.add(p.normal.multiply(distance)), p.origin, p.yvec);
                v.update();
            },
        },
        {
            id: "dependencies",
            label: "Show dependencies…",
            run: () => {
                const data = node.data;
                const sources = new Set(
                    [node.planeRef?.nodeId, ...(data.externalRefs ?? []).map((r) => r.nodeId)].filter(
                        Boolean,
                    ),
                );
                const dependents = doc.modelManager
                    .findNodes()
                    .filter(
                        (n) =>
                            n instanceof ParametricBodyNode &&
                            n.features.some((f) => JSON.stringify(f).includes(node.id)),
                    );
                showText(
                    node,
                    `References\n${[...sources].map((id) => doc.modelManager.findNode((n) => n.id === id)?.name ?? id).join("\n") || "None"}\n\nUsed by\n${dependents.map((n) => n.name).join("\n") || "None"}`,
                );
            },
        },
        {
            id: "appearance",
            label: "Edit sketch appearance…",
            run: () => {
                const color = document.createElement("input");
                color.type = "color";
                color.value = "#4a9eff";
                color.setAttribute("aria-label", "Sketch color");
                PubSub.default.pub("showDialog", "body.sketch", color, () =>
                    change("Edit sketch appearance", () => {
                        const editor = SketchEditor.getActive();
                        if (editor?.node === node) {
                            for (const entity of editor.solver.entities())
                                editor.solver.setEntityStyle(entity.id, { color: color.value });
                            editor.commit();
                            return;
                        }
                        const data = node.data;
                        data.entities = data.entities.map((e) => ({ ...e, color: color.value }));
                        node.setDataEmitShapeChanged(data);
                    }),
                );
            },
        },
        {
            id: "delete",
            label: "Delete",
            run: () => {
                if (SketchEditor.getActive()?.node === node) SketchEditor.exit();
                change("Delete sketch", () => node.parent?.remove(node));
            },
        },
    ];
    return actions.map((action, order) => ({ ...action, order: order * 10 }));
});
