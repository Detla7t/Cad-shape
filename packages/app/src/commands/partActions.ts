// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentVersionControl,
    download,
    NodeActions,
    type NodeMenuAction,
    PhongMaterial,
    PubSub,
    ShapeNode,
    Transaction,
} from "@chili3d/core";

let copiedPart: ShapeNode | undefined;
NodeActions.register((node) => {
    if (!(node instanceof ShapeNode) || node.display() === "body.sketch") return [];
    const doc = node.document;
    const change = (name: string, action: () => void) => Transaction.execute(doc, name, action);
    const select = () => doc.selection.setSelectedNodes([node], false);
    const field = (name: string, value: string, apply: (value: string) => void, multiline = false) => {
        const label = document.createElement("label");
        label.textContent = name;
        const input = document.createElement(multiline ? "textarea" : "input");
        input.value = value;
        input.setAttribute("aria-label", name);
        label.append(input);
        PubSub.default.pub("showDialog", "properties.header", label, () => apply(input.value));
    };
    const material = () => {
        const id = Array.isArray(node.materialId) ? node.materialId[0] : node.materialId;
        return doc.modelManager.materials.find((m) => m.id === id);
    };
    const appearance = (opacity?: number) => {
        const current = material();
        const apply = (color: string | number) =>
            change("Edit part appearance", () => {
                // A separate material keeps another part sharing the old material unchanged.
                const replacement =
                    current?.clone() ?? new PhongMaterial({ document: doc, name: node.name, color });
                replacement.color = color;
                replacement.opacity = opacity ?? current?.opacity ?? 1;
                doc.modelManager.materials.push(replacement);
                node.materialId = replacement.id;
            });
        if (opacity !== undefined) {
            apply(current?.color ?? 0xdedede);
            return;
        }
        const color = document.createElement("input");
        color.type = "color";
        color.setAttribute("aria-label", "Part color");
        color.value =
            typeof current?.color === "string"
                ? current.color
                : `#${Number(current?.color ?? 0xdedede)
                      .toString(16)
                      .padStart(6, "0")}`;
        PubSub.default.pub("showDialog", "properties.header", color, () => apply(color.value));
    };
    const actions: NodeMenuAction[] = [
        {
            id: "rename",
            label: "Rename",
            run: () =>
                field("Part name", node.name, (name) =>
                    change("Rename part", () => {
                        if (name.trim()) node.name = name.trim();
                    }),
                ),
        },
        {
            id: "properties",
            label: "Properties…",
            run: () => {
                select();
                PubSub.default.pub("showProperties", doc, [node]);
            },
        },
        {
            id: "material",
            label: "Assign material…",
            icon: "material",
            run: () => {
                const picker = document.createElement("select");
                picker.setAttribute("aria-label", "Part material");
                for (const m of doc.modelManager.materials)
                    picker.add(new Option(m.name, m.id, false, m.id === material()?.id));
                PubSub.default.pub("showDialog", "properties.header", picker, () =>
                    change("Assign part material", () => {
                        if (picker.value) node.materialId = picker.value;
                    }),
                );
            },
        },
        { id: "appearance", label: "Edit appearance…", run: () => appearance() },
        {
            id: "copyHere",
            label: "Copy here…",
            separatorBefore: true,
            run: () =>
                change("Copy part here", () => {
                    const copy = node.clone();
                    copy.name = `${node.name} copy`;
                    doc.modelManager.addNode(copy);
                }),
        },
        {
            id: "copy",
            label: `Copy ${node.name}`,
            icon: "partStudio",
            run: () => {
                copiedPart?.dispose();
                copiedPart = node.clone();
            },
        },
        ...(copiedPart?.document === doc
            ? [
                  {
                      id: "paste",
                      label: "Paste copied part",
                      run: () =>
                          change("Paste part", () => {
                              const copy = copiedPart!.clone();
                              copy.name = `${copy.name} copy`;
                              doc.modelManager.addNode(copy);
                          }),
                  },
              ]
            : []),
        {
            id: "export",
            label: "Export…",
            run: () => {
                const picker = document.createElement("select");
                picker.setAttribute("aria-label", "Export format");
                for (const format of doc.application.dataExchange.exportFormats())
                    picker.add(new Option(format, format));
                PubSub.default.pub("showDialog", "file.format", picker, () => {
                    void doc.application.dataExchange
                        .export(picker.value, [node])
                        .then((data) => {
                            if (data) download(data, `${node.name}${picker.value.split(" ")[0]}`);
                        })
                        .catch((error) => PubSub.default.pub("displayError", String(error)));
                });
            },
        },
        {
            id: "release",
            label: "Release…",
            run: () =>
                field("Local release version name", `Release ${node.name}`, (name) => {
                    const result = DocumentVersionControl.of(doc)?.createVersion(
                        name,
                        `Local release checkpoint for ${node.name}`,
                    );
                    if (result && !result.isOk) PubSub.default.pub("displayError", result.error);
                }),
        },
        {
            id: "hide",
            label: node.visible ? "Hide" : "Show",
            separatorBefore: true,
            run: () =>
                change("Toggle part visibility", () => {
                    node.visible = !node.visible;
                }),
        },
        {
            id: "isolate",
            label: "Isolate…",
            run: () => {
                select();
                doc.application.activeView?.isolate([node]);
            },
        },
        { id: "unisolate", label: "Show all parts", run: () => doc.application.activeView?.unisolate() },
        {
            id: "transparent",
            label: (material()?.opacity ?? 1) < 1 ? "Make opaque" : "Make transparent…",
            run: () => appearance((material()?.opacity ?? 1) < 1 ? 1 : 0.3),
        },
        {
            id: "comment",
            label: "Add comment",
            separatorBefore: true,
            run: () =>
                field(
                    "Part comment",
                    node.partComment,
                    (value) =>
                        change("Edit part comment", () => {
                            node.partComment = value;
                        }),
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
            id: "delete",
            label: "Delete…",
            separatorBefore: true,
            run: () => change("Delete part", () => node.parent?.remove(node)),
        },
    ];
    return actions.map((action, order) => ({ ...action, order: order * 10 }));
});
