// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication, IView, NodeMenuAction } from "@chili3d/core";
import { PubSub } from "@chili3d/core";
import { showActionMenu } from "../project/nodeContextMenu";

/**
 * The menu behind a right-click on a document's tab: save, save to a file, print the view,
 * export, the document's settings (units, precision) and close. The tab's document becomes
 * the active one first, so every command acts on it.
 */
export function showDocumentTabMenu(app: IApplication, view: IView, x: number, y: number): void {
    if (app.activeView !== view) app.activeView = view;
    const command = (key: Parameters<typeof PubSub.default.pub<"executeCommand">>[1]) => () =>
        PubSub.default.pub("executeCommand", key);
    const actions: NodeMenuAction[] = [
        { id: "save", label: "Save", icon: "save", run: command("doc.save") },
        { id: "saveTo", label: "Save to…", icon: "saveAs", run: command("doc.saveToFile") },
        { id: "print", label: "Print…", icon: "print", run: () => printView(view) },
        { id: "export", label: "Export…", icon: "export", run: command("file.export") },
        {
            id: "settings",
            label: "Document settings…",
            icon: "settings",
            separatorBefore: true,
            run: () => PubSub.default.pub("openPreferences", view.document, "document"),
        },
        {
            id: "close",
            label: "Close",
            icon: "close",
            separatorBefore: true,
            run: () => void view.document.close(),
        },
    ];
    showActionMenu(actions, x, y, { label: `${view.document.name} tab` });
}

/** Prints the view as it is drawn: its image on a page of its own, through the browser's print dialog. */
export function printView(view: IView): void {
    const image = view.toImage();
    const page = window.open("", "_blank", "noopener");
    if (page === null) {
        PubSub.default.pub("displayError", "The browser blocked the print window.");
        return;
    }
    const title = view.document.name.replace(/[<>&"]/g, "");
    page.document.write(
        `<!doctype html><title>${title}</title>` +
            `<style>body{margin:0;display:grid;place-items:center;min-height:100vh}img{max-width:100%;max-height:100vh}</style>` +
            `<img src="${image}" alt="${title}" onload="window.print()">`,
    );
    page.document.close();
}
