// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    download,
    type EditorBufferRegistration,
    EditorBuffers,
    exportFileName,
    I18n,
    type IDocument,
    type IEditorBuffer,
    type IElementView,
    Localize,
    Logger,
    PubSub,
    Result,
} from "@chili3d/core";
import { div, option, select, span, svg } from "@chili3d/element";
import { EditorBufferControls, mountIsland, type ReactIsland } from "@chili3d/react";
import { createElement } from "react";
import type { DocumentFileNode } from "../documentFileNode";
import { type DocumentViewKind, formatOf } from "../documentFormats";
import { formatBytes } from "./controls";
import style from "./documents.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext, ViewerFactory } from "./viewer";

/**
 * The frame every document element shares: a header with the element's name, its
 * format and size, the shared save bar (`EditorBufferControls`: unsaved mark, Discard,
 * Save) for editing viewers, and an export menu; the format's
 * viewer (its own lazily loaded chunk) fills the rest. Keystrokes stay inside the view,
 * so the Part Studio's hotkeys (Delete, Ctrl+Z, …) never act behind a document; Ctrl+S
 * saves.
 *
 * The shell is the one adapter from a document viewer to the app's editor-buffer contract
 * (`IEditorBuffer`, editor id `document.<viewKind>`): an editing viewer's draft is registered
 * with `EditorBuffers` while it is mounted, so its tab is marked, closing asks about it and
 * the recovery autosave keeps it.
 */

const VIEWERS: Record<DocumentViewKind, () => Promise<ViewerFactory>> = {
    markdown: async () => (await import("./viewers/markdownViewer")).createMarkdownViewer,
    richText: async () => (await import("./viewers/richTextViewer")).createRichTextViewer,
    spreadsheet: async () => (await import("./viewers/spreadsheetViewer")).createSpreadsheetViewer,
    pdf: async () => (await import("./viewers/pdfViewer")).createPdfViewer,
    image: async () => (await import("./viewers/imageViewer")).createImageViewer,
    text: async () => (await import("./viewers/textViewer")).createTextViewer,
    drawing: async () => (await import("./viewers/drawingViewer")).createDrawingViewer,
    file: async () => (await import("./viewers/fileViewer")).createFileViewer,
};

export function createDocumentView(node: DocumentFileNode, document: IDocument): IElementView {
    const title = span({ className: style.title, textContent: node.name });
    const info = span({ className: style.info });
    const controls = span();
    let controlsIsland: ReactIsland | undefined;
    const exportMenu = select({ className: style.select, title: new Localize("documents.export") });
    const body = div(
        { className: style.body },
        div({ className: style.message, textContent: new Localize("documents.loading") }),
    );
    let viewer: IDocumentViewer | undefined;
    let registration: EditorBufferRegistration | undefined;
    let exports: DocumentExport[] = [];
    let saving = false;
    let disposed = false;

    const refreshInfo = () => {
        title.textContent = node.name;
        title.title = node.fileName;
        const format = formatOf(node.format, node.fileName);
        info.textContent = `${format?.name ?? node.format} · ${formatBytes(node.size)}`;
    };

    /** The draft may have changed: the save bar and the element tab follow the registry. */
    const refreshState = () => {
        registration?.changed();
    };

    const fillExports = () => {
        const original: DocumentExport = {
            label: "documents.export.original",
            extension: node.exportFileName.slice(node.name.length),
            produce: async () => node.bytes,
        };
        exports = [original, ...(viewer?.exports?.() ?? [])];
        exportMenu.replaceChildren(
            option({ value: "", textContent: I18n.translate("documents.export") }),
            ...exports.map((item, index) =>
                option({
                    value: String(index),
                    textContent: `${I18n.translate(item.label)} (${item.extension})`,
                }),
            ),
        );
    };

    /** Writes the viewer's draft into the node (one undo step); an error leaves the draft. */
    const commit = async (): Promise<Result<void>> => {
        if (viewer?.save === undefined || viewer.isDirty?.() !== true) return Result.ok(undefined);
        if (saving) return Result.err("A save is already running");
        saving = true;
        refreshState();
        try {
            await viewer.save();
            return Result.ok(undefined);
        } catch (error) {
            Logger.error(error);
            return Result.err(error instanceof Error ? error.message : String(error));
        } finally {
            saving = false;
            refreshInfo();
            refreshState();
        }
    };

    const save = async () => {
        if (viewer?.save === undefined || viewer.isDirty?.() !== true || saving) return;
        const result = await commit();
        if (result.isOk) PubSub.default.pub("showToast", "documents.saved{0}", node.name);
        else PubSub.default.pub("showToast", "error.default:{0}", result.error);
    };

    const buffer: IEditorBuffer = {
        document,
        node,
        editor: `document.${node.viewKind}`,
        isDirty: () => viewer?.isDirty?.() === true,
        commit,
        revert: () => {
            viewer?.reload?.();
            refreshState();
        },
        snapshot: () => viewer?.snapshot?.(),
        restore: async (draft) => {
            await viewer?.restore?.(draft);
            refreshState();
        },
    };

    exportMenu.onchange = async () => {
        const item = exports[Number(exportMenu.value)];
        exportMenu.value = "";
        if (item === undefined) return;
        try {
            const data = await item.produce();
            download(
                [data as BlobPart],
                exportFileName(node.name, item.extension, Config.instance.preferences.exportRules),
            );
        } catch (error) {
            PubSub.default.pub(
                "showToast",
                "error.default:{0}",
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    const context: ViewerContext = { node, document, changed: refreshState };
    VIEWERS[node.viewKind]()
        .then((factory) => {
            if (disposed) return;
            viewer = factory(context);
            body.replaceChildren(viewer.element);
            if (viewer.save !== undefined) {
                registration = EditorBuffers.register(buffer);
                controlsIsland = mountIsland(
                    controls,
                    createElement(EditorBufferControls, { buffer, onSave: save }),
                );
            }
            fillExports();
            refreshState();
            viewer.activated?.();
        })
        .catch((error) => {
            Logger.error(error);
            body.replaceChildren(div({ className: style.error, textContent: String(error) }));
        });

    const onNodeChanged = (property: keyof DocumentFileNode) => {
        if (property === "name" || property === "fileName") {
            refreshInfo();
            fillExports();
        } else if (property === "content" && !saving) {
            refreshInfo();
            if (viewer?.isDirty?.() !== true) viewer?.reload?.();
        }
    };
    node.onPropertyChanged(onNodeChanged);

    const element = div(
        {
            className: style.shell,
            onkeydown: (e: KeyboardEvent) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    void save();
                }
                // The Part Studio's hotkeys must not act behind the document.
                e.stopPropagation();
            },
        },
        div(
            { className: style.header },
            svg({ className: style.headerIcon, icon: node.icon }),
            title,
            info,
            div({ className: style.spacer }),
            controls,
            exportMenu,
        ),
        body,
    );
    refreshInfo();
    refreshState();
    fillExports();

    return {
        element,
        activated: () => viewer?.activated?.(),
        deactivated: () => viewer?.deactivated?.(),
        dispose: () => {
            disposed = true;
            registration?.dispose();
            controlsIsland?.dispose();
            node.removePropertyChanged(onNodeChanged);
            viewer?.dispose();
        },
    };
}
