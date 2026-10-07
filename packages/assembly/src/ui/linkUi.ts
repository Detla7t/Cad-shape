// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, type IDocument, PubSub } from "@chili3d/core";
import { button, div, input, option, select, span } from "@chili3d/element";
import { importSourceProject } from "../link/importSource";
import type { ILinkConsumer } from "../link/linkRegistry";
import {
    describeLinkVersion,
    describeVersion,
    type LinkState,
    type LinkVersionSpec,
    linkStatusKey,
    sameVersionSpec,
} from "../link/linkTypes";
import type { PartLinkService } from "../link/partLinkService";
import type { SourceHistory, SourceNodeInfo } from "../link/sourceHistory";
import style from "./assembly.module.css";

/**
 * The shared pieces of the link UI: a source picker (saved documents → version → part), the
 * version picker of an existing link, and the document's links panel.
 */

export const t = (key: I18nKeys, ...args: unknown[]) => I18n.translate(key, ...args) ?? String(key);

export function toast(key: I18nKeys, ...args: unknown[]) {
    PubSub.default.pub("showToast", key, ...args);
}

export interface SourceSelection {
    readonly documentId: string;
    readonly node: SourceNodeInfo;
    readonly version: LinkVersionSpec;
}

/** One entry of a version list: a branch to follow, a named version or a commit. */
interface VersionChoice {
    readonly spec: LinkVersionSpec;
    readonly label: string;
    readonly commit: string;
}

const COMMITS_LISTED = 25;

export function versionChoices(source: SourceHistory): VersionChoice[] {
    const choices: VersionChoice[] = [];
    for (const branch of source.branches()) {
        choices.push({
            spec: { kind: "branch", name: branch.name },
            label: t("link.followLatest{0}", branch.name),
            commit: branch.head,
        });
    }
    for (const version of [...source.versions()].reverse()) {
        choices.push({
            spec: { kind: "version", name: version.name },
            label: t("link.versionItem{0}", version.name),
            commit: version.commit,
        });
    }
    for (const commit of source.log(COMMITS_LISTED)) {
        choices.push({
            spec: { kind: "commit", id: commit.id },
            label: `${commit.message} · ${commit.id.slice(0, 7)} · ${new Date(commit.time).toLocaleString()}`,
            commit: commit.id,
        });
    }
    return choices;
}

function fillVersions(
    target: HTMLSelectElement,
    choices: readonly VersionChoice[],
    current?: LinkVersionSpec,
) {
    target.replaceChildren(
        ...choices.map((choice, index) =>
            option({
                value: String(index),
                textContent: choice.label,
                selected: current !== undefined && sameVersionSpec(choice.spec, current),
            }),
        ),
    );
}

/**
 * A picker of saved documents (this browser's IndexedDB), their versions and their parts —
 * plus "Import .chili3d…" to make a file a source first. `onPick` fires on double-click.
 */
export function createSourcePicker(
    service: PartLinkService,
    options: { excludeDocument?: string; onPick?: (selection: SourceSelection) => void } = {},
) {
    let documentId: string | undefined;
    let source: SourceHistory | undefined;
    let choices: VersionChoice[] = [];
    let nodes: SourceNodeInfo[] = [];
    let selectedNode: SourceNodeInfo | undefined;

    const documentsList = div({ className: style.list });
    const nodesList = div({ className: style.list });
    const versionSelect = select({ className: style.select });
    const fileInput = input({ type: "file", accept: ".chili3d", style: { display: "none" } });

    const selection = (): SourceSelection | undefined => {
        const choice = choices[Number(versionSelect.value)];
        if (documentId === undefined || selectedNode === undefined || choice === undefined) return undefined;
        return { documentId, node: selectedNode, version: choice.spec };
    };

    const renderNodes = () => {
        const choice = choices[Number(versionSelect.value)];
        nodes = source !== undefined && choice !== undefined ? source.nodesAt(choice.commit) : [];
        if (selectedNode !== undefined && !nodes.some((x) => x.id === selectedNode!.id))
            selectedNode = undefined;
        nodesList.replaceChildren(
            ...(nodes.length === 0
                ? [div({ className: style.empty, textContent: t("link.noParts") })]
                : nodes.map((node) => {
                      const row = div(
                          {
                              className: `${style.row} ${node.id === selectedNode?.id ? style.selected : ""}`,
                              onclick: () => {
                                  selectedNode = node;
                                  renderNodes();
                              },
                              ondblclick: () => {
                                  selectedNode = node;
                                  const picked = selection();
                                  if (picked !== undefined) options.onPick?.(picked);
                              },
                          },
                          span({ className: style.rowName, textContent: node.name }),
                          span({
                              className: style.badge,
                              textContent: node.kind === "assembly" ? t("assembly.element") : t("link.part"),
                          }),
                      );
                      return row;
                  })),
        );
    };

    const openDocument = async (id: string) => {
        documentId = id;
        selectedNode = undefined;
        source = await service.openSource(id);
        choices = source === undefined ? [] : versionChoices(source);
        fillVersions(versionSelect, choices);
        renderDocuments();
        renderNodes();
    };

    let documents: { id: string; name: string; date?: number }[] = [];
    const renderDocuments = () => {
        const listed = documents.filter((x) => x.id !== options.excludeDocument);
        documentsList.replaceChildren(
            ...(listed.length === 0
                ? [div({ className: style.empty, textContent: t("link.noDocuments") })]
                : listed.map((doc) =>
                      div(
                          {
                              className: `${style.row} ${doc.id === documentId ? style.selected : ""}`,
                              onclick: () => void openDocument(doc.id),
                          },
                          span(
                              { className: style.rowName },
                              doc.name,
                              span({
                                  className: style.rowSub,
                                  textContent:
                                      doc.date === undefined ? doc.id : new Date(doc.date).toLocaleString(),
                              }),
                          ),
                      ),
                  )),
        );
    };

    const reload = async () => {
        documents = await service.listSourceDocuments();
        renderDocuments();
    };

    versionSelect.onchange = () => renderNodes();
    fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";
        if (file === undefined) return;
        const imported = await importSourceProject(
            service.application,
            service.storage,
            new Uint8Array(await file.arrayBuffer()),
        );
        if (!imported.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", imported.error);
            return;
        }
        service.invalidateSource(imported.value.id);
        toast("link.imported{0}", imported.value.name);
        await reload();
        await openDocument(imported.value.id);
    };

    const element = div(
        { className: style.panel },
        div(
            { className: style.columns },
            div(
                { className: style.column },
                div({ className: style.section, textContent: t("link.documents") }),
                documentsList,
            ),
            div(
                { className: style.column },
                div({ className: style.section, textContent: t("link.parts") }),
                div(
                    { className: style.field, style: { padding: "0 8px 4px" } },
                    span({ textContent: t("link.version") }),
                    versionSelect,
                ),
                nodesList,
            ),
        ),
        div(
            { className: style.actions, style: { justifyContent: "flex-start" } },
            button({
                className: style.button,
                textContent: t("link.importFile"),
                onclick: () => fileInput.click(),
            }),
            fileInput,
        ),
    );
    void reload();
    return { element, selection, reload };
}

/** Shows a picker; `onInsert` gets the selection when the user confirms. */
export function showSourcePickerDialog(
    service: PartLinkService,
    document: IDocument,
    title: I18nKeys,
    onInsert: (selection: SourceSelection) => Promise<void>,
) {
    let close: (() => void) | undefined;
    const run = async (selection: SourceSelection | undefined) => {
        if (selection === undefined) return;
        await onInsert(selection);
        close?.();
    };
    const picker = createSourcePicker(service, { onPick: (selection) => void run(selection) });
    const insert = button({
        className: style.button,
        textContent: t("link.insert"),
        onclick: () => void run(picker.selection()),
    });
    picker.element.append(div({ className: style.actions }, insert));
    const frame = div({ style: { width: "100%", height: "100%" } }, picker.element);
    PubSub.default.pub("showFloatPanel", {
        title,
        content: frame,
        width: 640,
        height: 440,
        minWidth: 420,
        minHeight: 260,
        document,
        onClose: () => {
            close = undefined;
        },
    });
    close = () => closeFloatPanelOf(frame);
}

/** Closes the float panel hosting `content` (the UI's panel element exposes `close()`). */
export function closeFloatPanelOf(content: HTMLElement): void {
    const panel = content.closest("chili-float-panel") as (HTMLElement & { close?: () => void }) | null;
    panel?.close?.();
}

/** "Change version…" of one link slot. */
export async function showVersionPicker(
    service: PartLinkService,
    consumer: ILinkConsumer,
    slotId: string,
): Promise<void> {
    const slot = consumer.linkSlots().find((x) => x.slotId === slotId);
    if (slot === undefined) return;
    const source = await service.openSource(slot.link.documentId);
    if (source === undefined) {
        PubSub.default.pub("showToast", "link.broken");
        return;
    }
    const choices = versionChoices(source);
    const chooser = select({ className: style.select, size: 12, style: { width: "100%" } });
    fillVersions(chooser, choices, slot.link.version);
    const content = div(
        { className: style.panel, style: { minWidth: "420px" } },
        div({
            className: style.hint,
            textContent: `${slot.link.documentName ?? ""} › ${slot.link.nodeName ?? ""}`,
        }),
        chooser,
    );
    PubSub.default.pub("showDialog", "link.changeVersion.title", content, [
        {
            content: "common.confirm",
            onclick: async () => {
                const choice = choices[Number(chooser.value)];
                if (choice === undefined) return;
                const changed = await service.changeVersion(consumer, slotId, choice.spec);
                if (changed) toast("link.updated{0}", describeVersion(choice.spec));
            },
        },
        { content: "common.cancel" },
    ]);
}

/** The i18n key of a link state (see `linkStatusKey`). */
export const statusKey = linkStatusKey;

export function statusClass(state: LinkState | undefined): string {
    switch (state?.status) {
        case "ok":
            return style.ok;
        case "updateAvailable":
            return style.warn;
        case "broken":
        case "error":
            return style.error;
        default:
            return "";
    }
}

/** The document's links: every linked part and linked assembly instance, with their state and actions. */
export function showLinksPanel(service: PartLinkService, document: IDocument): void {
    const list = div({ className: style.list });
    const render = () => {
        const rows: HTMLElement[] = [];
        for (const consumer of service.consumersOf(document)) {
            if (!consumer.attached) continue;
            for (const slot of consumer.linkSlots()) {
                const state = service.stateOf(consumer, slot.slotId);
                const owner = (consumer as unknown as { name?: string }).name ?? "";
                rows.push(
                    div(
                        { className: style.row },
                        span(
                            { className: style.rowName },
                            `${slot.link.nodeName ?? slot.link.nodeId}`,
                            span({
                                className: style.rowSub,
                                textContent: `${owner} · ${slot.link.documentName ?? slot.link.documentId} · ${describeLinkVersion(slot.link)}`,
                            }),
                        ),
                        span({
                            className: `${style.badge} ${statusClass(state)}`,
                            textContent: t(statusKey(state)),
                            title: state?.message ?? state?.update?.label ?? "",
                        }),
                        state?.status === "updateAvailable"
                            ? button({
                                  className: style.mini,
                                  textContent: t("link.updateToLatest"),
                                  onclick: async () => {
                                      await service.updateToLatest(consumer, slot.slotId);
                                      render();
                                  },
                              })
                            : "",
                        button({
                            className: style.mini,
                            textContent: t("link.changeVersion"),
                            onclick: () => void showVersionPicker(service, consumer, slot.slotId),
                        }),
                    ),
                );
            }
        }
        list.replaceChildren(
            ...(rows.length === 0 ? [div({ className: style.empty, textContent: t("link.noLinks") })] : rows),
        );
    };
    const unsubscribe = service.onChanged(render);
    render();
    PubSub.default.pub("showFloatPanel", {
        title: "link.manage.title",
        content: div({ className: style.panel }, div({ className: style.scroll }, list)),
        width: 560,
        height: 360,
        minWidth: 360,
        minHeight: 200,
        document,
        onClose: unsubscribe,
    });
    for (const consumer of service.consumersOf(document)) void service.refresh(consumer);
}
