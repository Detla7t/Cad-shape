// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FolderNode,
    formatConfiguredValue,
    isSelectorInput,
    NodeActions,
    type NodeMenuAction,
    PartStudioTimeline,
    PubSub,
    parseConfiguredValue,
    selectorOptions,
    Transaction,
} from "@chili3d/core";
import { VariableCommand } from "../commands/variableCommand";
import { ParametricBodyNode } from "../parametricBodyNode";
import { MeasuredVariableNode } from "./measuredVariableNode";

NodeActions.register((node) => {
    if (!(node instanceof MeasuredVariableNode)) return [];
    const model = node.document;
    const change = (name: string, action: () => void) => Transaction.execute(model, name, action);
    const patch = (value: Partial<typeof node.definition>) =>
        change("edit variable", () => {
            node.definition = { ...node.definition, ...value };
        });
    const textDialog = (label: string, value: string, accept: (text: string) => void) => {
        const root = document.createElement("label");
        root.textContent = label;
        const field = document.createElement("input");
        field.value = value;
        field.setAttribute("aria-label", label);
        root.append(field);
        PubSub.default.pub("showDialog", "command.feature.variable", root, () => accept(field.value));
    };
    const configure = () => {
        const selectors = model.variables.configurationInputs.filter(isSelectorInput);
        if (!selectors.length) {
            PubSub.default.pub("editConfiguration", model);
            return;
        }
        const content = document.createElement("div"),
            select = document.createElement("select"),
            rows = document.createElement("div");
        select.setAttribute("aria-label", "Suppression configuration");
        const checks = new Map<string, HTMLInputElement>();
        for (const input of selectors) {
            const option = document.createElement("option");
            option.value = input.id;
            option.textContent = input.name;
            select.append(option);
        }
        const render = () => {
            rows.replaceChildren();
            checks.clear();
            const source = selectors.find((input) => input.id === select.value)!;
            const current =
                typeof node.definition.suppression === "string"
                    ? parseConfiguredValue(node.definition.suppression)
                    : undefined;
            for (const option of selectorOptions(source)) {
                const row = document.createElement("label"),
                    check = document.createElement("input");
                check.type = "checkbox";
                check.checked =
                    current?.isOk && current.value.input === source.name
                        ? current.value.arms.find((arm) => arm.option === option)?.value === "true"
                        : node.isSuppressed;
                row.style.display = "block";
                row.append(check, ` Suppress for ${option}`);
                rows.append(row);
                checks.set(option, check);
            }
        };
        select.onchange = render;
        content.append(select, rows);
        render();
        PubSub.default.pub("showDialog", "command.feature.variable", content, () =>
            patch({
                suppression: formatConfiguredValue({
                    input: selectors.find((input) => input.id === select.value)!.name,
                    arms: [...checks].map(([option, check]) => ({ option, value: String(check.checked) })),
                }),
            }),
        );
    };
    const configured =
        typeof node.definition.suppression === "string" &&
        parseConfiguredValue(node.definition.suppression)?.isOk;
    const actions: NodeMenuAction[] = [
        { id: "edit", label: "Edit…", run: () => VariableCommand.edit(node) },
        {
            id: "folder",
            label: "Add selection to folder…",
            run: () =>
                textDialog("Folder name", "Variables", (name) =>
                    change("move variable to folder", () => {
                        const existing = model.modelManager
                            .findNodes()
                            .find((item) => item instanceof FolderNode && item.name === name);
                        const folder =
                            existing instanceof FolderNode
                                ? existing
                                : new FolderNode({ document: model, name });
                        if (!folder.parent) model.modelManager.rootNode.add(folder);
                        folder.transfer(node);
                    }),
                ),
        },
        {
            id: "suppress",
            label: node.isSuppressed ? "Unsuppress" : "Suppress",
            run: () => patch({ suppression: !node.isSuppressed }),
        },
        {
            id: "dynamic",
            label: "Dynamic suppression",
            children: [
                {
                    id: "expression",
                    label: "Add expression…",
                    run: () =>
                        textDialog(
                            "Suppression expression",
                            typeof node.definition.suppression === "string"
                                ? node.definition.suppression
                                : "false",
                            (value) => patch({ suppression: value }),
                        ),
                },
            ],
        },
        {
            id: "configure",
            label: configured ? "Unconfigure suppression" : "Configure suppression",
            run: configured ? () => patch({ suppression: node.isSuppressed }) : configure,
        },
        {
            id: "comment",
            label: "Add comment",
            icon: "document",
            run: () => textDialog("Comment", node.definition.comment ?? "", (comment) => patch({ comment })),
        },
        {
            id: "zoom",
            label: "Zoom to selection",
            run: () => {
                const sources = model.modelManager
                    .findNodes()
                    .filter((item) => node.definition.entities.some((ref) => ref.nodeId === item.id));
                model.selection.setSelectedNodes(sources, false);
                model.application.activeView?.cameraController.fitContent();
            },
        },
        {
            id: "dependencies",
            label: "Show dependencies…",
            run: () => {
                const content = document.createElement("pre");
                content.style.whiteSpace = "pre-wrap";
                const refs = node.definition.entities.map(
                    (ref) =>
                        model.modelManager.findNode((item) => item.id === ref.nodeId)?.name ??
                        `Missing: ${ref.label}`,
                );
                const used = model.modelManager
                    .findNodes()
                    .filter(
                        (item) =>
                            item !== node &&
                            JSON.stringify(
                                item instanceof ParametricBodyNode
                                    ? item.features
                                    : "dataJson" in item
                                      ? item.dataJson
                                      : "",
                            ).includes(node.definition.name),
                    );
                content.textContent = `References\n${refs.join("\n") || "None"}\n\nUsed by\n${used.map((item) => item.name).join("\n") || "None"}${node.result.isOk ? "" : `\n\n${node.result.error}`}`;
                PubSub.default.pub("showFloatPanel", {
                    title: "command.feature.variable",
                    content,
                    document: model,
                    width: 380,
                    height: 260,
                });
            },
        },
        {
            id: "roll",
            label: "Roll to end",
            run: () => {
                // The Part Studio timeline owns the rollback: its end releases every body and node.
                PartStudioTimeline.of(model).end();
                for (const body of model.modelManager.findNodes())
                    if (body instanceof ParametricBodyNode) body.setRollbackIndex(undefined);
                model.visual.update();
            },
        },
        {
            id: "delete",
            label: "Delete",
            run: () => change("delete measured variable", () => node.parent?.remove(node)),
        },
    ];
    return actions.map((action, order) => ({ ...action, order: order * 10 }));
});
PubSub.default.sub("nodeDoubleClicked", (node) => {
    if (node instanceof MeasuredVariableNode) void VariableCommand.edit(node);
});
