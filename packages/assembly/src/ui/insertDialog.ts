// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, PubSub } from "@chili3d/core";
import { button, div, span } from "@chili3d/element";
import { linkService } from "../link/linkRegistry";
import type { PartLinkService } from "../link/partLinkService";
import type { AssemblyNode } from "../model/assemblyNode";
import { localAssemblies, localParts } from "../model/evaluate";
import { insertInstance } from "../model/insert";
import style from "./assembly.module.css";
import { createSourcePicker, type SourceSelection, t, toast } from "./linkUi";

/**
 * Onshape's Insert dialog: parts and assemblies of this document, or — from another saved
 * document — a part or assembly at a chosen version (following a branch keeps it current).
 */
export function showInsertDialog(assembly: AssemblyNode, document: IDocument): void {
    const service = linkService() as PartLinkService | undefined;
    const local = div({ className: style.list });
    let picked: INode | undefined;
    const renderLocal = () => {
        const parts: INode[] = localParts(document);
        const assemblies: INode[] = localAssemblies(document).filter((x) => x !== assembly);
        const rows = [...parts, ...assemblies].map((node) =>
            div(
                {
                    className: `${style.row} ${node === picked ? style.selected : ""}`,
                    onclick: () => {
                        picked = node;
                        renderLocal();
                    },
                    ondblclick: () => {
                        picked = node;
                        insertLocal();
                    },
                },
                span({ className: style.rowName, textContent: node.name }),
                span({
                    className: style.badge,
                    textContent: assemblies.includes(node) ? t("assembly.element") : t("link.part"),
                }),
            ),
        );
        local.replaceChildren(
            ...(rows.length === 0 ? [div({ className: style.empty, textContent: t("link.noParts") })] : rows),
        );
    };
    const insertLocal = () => {
        if (picked === undefined) return;
        const isAssembly = localAssemblies(document).includes(picked as AssemblyNode);
        insertInstance(assembly, { kind: isAssembly ? "assembly" : "part", nodeId: picked.id }, picked.name);
    };

    const content = div({ className: style.panel });
    const localPane = div(
        { className: style.panel, style: { padding: "0" } },
        div({ className: `${style.column} ${style.scroll}` }, local),
        div(
            { className: style.actions },
            button({ className: style.button, textContent: t("link.insert"), onclick: insertLocal }),
        ),
    );
    let remotePane: HTMLElement | undefined;
    const insertRemote = async (selection: SourceSelection | undefined) => {
        if (selection === undefined || service === undefined) return;
        const resolved = await service.resolveNew(selection.documentId, selection.node.id, selection.version);
        if (!resolved.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
            return;
        }
        insertInstance(
            assembly,
            { kind: "link", link: resolved.value.link },
            resolved.value.link.nodeName ?? selection.node.name,
        );
        toast("link.inserted{0}", resolved.value.link.nodeName ?? selection.node.name);
    };
    const showPane = (which: "local" | "remote") => {
        localTab.classList.toggle(style.active, which === "local");
        remoteTab.classList.toggle(style.active, which === "remote");
        if (which === "local") {
            renderLocal();
            body.replaceChildren(localPane);
            return;
        }
        if (remotePane === undefined) {
            if (service === undefined) {
                remotePane = div({ className: style.empty, textContent: t("link.noDocuments") });
            } else {
                const picker = createSourcePicker(service, {
                    excludeDocument: document.id,
                    onPick: (x) => void insertRemote(x),
                });
                picker.element.append(
                    div(
                        { className: style.actions },
                        button({
                            className: style.button,
                            textContent: t("link.insert"),
                            onclick: () => void insertRemote(picker.selection()),
                        }),
                    ),
                );
                remotePane = picker.element;
            }
        }
        body.replaceChildren(remotePane);
    };
    const localTab = button({
        className: style.button,
        textContent: t("assembly.thisDocument"),
        onclick: () => showPane("local"),
    });
    const remoteTab = button({
        className: style.button,
        textContent: t("assembly.otherDocuments"),
        onclick: () => showPane("remote"),
    });
    const body = div({ className: style.panel, style: { padding: "0" } });
    content.append(div({ className: style.toolbar }, localTab, remoteTab), body);
    showPane("local");
    PubSub.default.pub("showFloatPanel", {
        title: "assembly.insert.title",
        content,
        width: 660,
        height: 460,
        minWidth: 420,
        minHeight: 280,
        document,
    });
}
