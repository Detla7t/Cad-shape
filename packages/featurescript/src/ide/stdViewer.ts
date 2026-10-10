// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, PubSub } from "@chili3d/core";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { FsAnalyzer, type FsEditorHost, languageService, revealRange } from "./extensions";
import style from "./ide.module.css";
import type { DefinitionLocation } from "./navigation";
import { editorBasics } from "./setup";
import { STD_PREFIX, type StdIndex } from "./stdIndex";
import { THEME_CLASS } from "./theme";

/**
 * A read-only viewer of Onshape's std source, opened by go-to-definition on a std symbol:
 * one floating panel, reused for every jump, with the module scrolled to the declaration.
 * Hover docs and go-to-definition work inside it too, so std can be browsed.
 */

interface Viewer {
    readonly view: EditorView;
    readonly title: HTMLElement;
    readonly position: HTMLElement;
    module: string;
}

let current: Viewer | undefined;

function translate(key: Parameters<typeof I18n.translate>[0]): string {
    return I18n.translate(key) ?? String(key);
}

function createState(source: string, host: FsEditorHost): EditorState {
    return EditorState.create({
        doc: source,
        extensions: [
            editorBasics({ readOnly: true }),
            languageService(host, { readOnly: true }),
            EditorView.updateListener.of((update) => {
                if (update.selectionSet && current !== undefined) updatePosition(current);
            }),
        ],
    });
}

function updatePosition(viewer: Viewer): void {
    const head = viewer.view.state.selection.main.head;
    const line = viewer.view.state.doc.lineAt(head);
    viewer.position.textContent = `${translate("featurescript.ide.readOnly")} · ${line.number}:${head - line.from + 1}`;
}

/** Opens (or retargets) the std viewer on `module`, selecting `from`..`to`. */
export function showStdSource(
    index: StdIndex,
    module: string,
    from: number,
    to: number,
    document?: IDocument,
): void {
    const std = index.module(module);
    if (std === undefined) return;
    const host: FsEditorHost = {
        analyzer: new FsAnalyzer(() => ({ std: index, studio: () => undefined })),
        ready: () => Promise.resolve(),
        studioNames: () => [],
        stdModules: () => [],
        openDefinition: (location: DefinitionLocation) => {
            if (location.kind === "std")
                showStdSource(index, location.module, location.from, location.to, document);
            else if (location.kind === "local" && current !== undefined)
                revealRange(current.view, location.from, location.to);
        },
    };
    // A panel closed with its document is gone without its onClose having run.
    if (current !== undefined && !current.view.dom.isConnected) {
        current.view.destroy();
        current = undefined;
    }
    if (current !== undefined) {
        if (current.module !== module) {
            current.view.setState(createState(std.source, host));
            current.module = module;
            current.title.textContent = `${STD_PREFIX}${module}`;
        }
        revealRange(current.view, from, to);
        return;
    }
    const root = window.document.createElement("div");
    root.className = `${style.viewer} ${THEME_CLASS}`;
    const header = window.document.createElement("div");
    header.className = style.viewerHeader;
    const title = window.document.createElement("span");
    title.textContent = `${STD_PREFIX}${module}`;
    const position = window.document.createElement("div");
    position.className = style.docMuted;
    header.append(title, position);
    const editor = window.document.createElement("div");
    editor.className = style.editor;
    root.append(header, editor);
    root.addEventListener("keydown", (event) => event.stopPropagation());
    const view = new EditorView({ parent: editor, state: createState(std.source, host) });
    const viewer: Viewer = { view, title, position, module };
    current = viewer;
    const width = Math.min(820, window.innerWidth - 40);
    const height = Math.min(620, window.innerHeight - 40);
    PubSub.default.pub("showFloatPanel", {
        title: "featurescript.ide.stdSource",
        content: root,
        x: Math.max(20, window.innerWidth - width - 40),
        y: Math.max(20, Math.min(110, window.innerHeight - height - 20)),
        width,
        height,
        minWidth: 360,
        minHeight: 240,
        document,
        onClose: () => {
            if (current === viewer) current = undefined;
            view.destroy();
        },
    });
    // Measure once the panel is in the page, then scroll to the declaration.
    requestAnimationFrame(() => revealRange(view, from, to));
    updatePosition(viewer);
}
