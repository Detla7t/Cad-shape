// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { download, I18n, type IDocument, type IElementView, Localize, Logger, PubSub } from "@chili3d/core";
import { button, div, option, select, span, svg } from "@chili3d/element";
import type { DocumentFileNode } from "../documentFileNode";
import { type DocumentViewKind, formatOf } from "../documentFormats";
import { formatBytes } from "./controls";
import style from "./documents.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext, ViewerFactory } from "./viewer";

/**
 * The frame every document element shares: a header with the element's name, its
 * format and size, an unsaved-changes marker, Save and an export menu; the format's
 * viewer (its own lazily loaded chunk) fills the rest. Keystrokes stay inside the view,
 * so the Part Studio's hotkeys (Delete, Ctrl+Z, …) never act behind a document; Ctrl+S
 * saves.
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
    const dirtyMark = span({ className: style.dirty, textContent: new Localize("documents.unsaved") });
    const saveButton = button({ className: style.primary, textContent: new Localize("documents.save") });
    const exportMenu = select({ className: style.select, title: new Localize("documents.export") });
    const body = div(
        { className: style.body },
        div({ className: style.message, textContent: new Localize("documents.loading") }),
    );
    let viewer: IDocumentViewer | undefined;
    let exports: DocumentExport[] = [];
    let saving = false;
    let disposed = false;

    const refreshInfo = () => {
        title.textContent = node.name;
        title.title = node.fileName;
        const format = formatOf(node.format, node.fileName);
        info.textContent = `${format?.name ?? node.format} · ${formatBytes(node.size)}`;
    };

    const refreshState = () => {
        const dirty = viewer?.isDirty?.() === true;
        dirtyMark.style.display = dirty ? "" : "none";
        saveButton.style.display = viewer?.save === undefined ? "none" : "";
        saveButton.disabled = !dirty || saving;
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

    const save = async () => {
        if (viewer?.save === undefined || viewer.isDirty?.() !== true || saving) return;
        saving = true;
        refreshState();
        try {
            await viewer.save();
            PubSub.default.pub("showToast", "documents.saved{0}", node.name);
        } catch (error) {
            Logger.error(error);
            PubSub.default.pub(
                "showToast",
                "error.default:{0}",
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            saving = false;
            refreshInfo();
            refreshState();
        }
    };

    saveButton.onclick = () => void save();
    exportMenu.onchange = async () => {
        const item = exports[Number(exportMenu.value)];
        exportMenu.value = "";
        if (item === undefined) return;
        try {
            const data = await item.produce();
            download([data as BlobPart], `${node.name}${item.extension}`);
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
            dirtyMark,
            div({ className: style.spacer }),
            saveButton,
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
        dispose: () => {
            disposed = true;
            node.removePropertyChanged(onNodeChanged);
            viewer?.dispose();
        },
    };
}
