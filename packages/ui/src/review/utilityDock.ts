// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, type IView, PubSub, type ReviewTarget } from "@chili3d/core";
import { leave } from "../motion";
import { CommentsPanel } from "./commentsPanel";
import { action, textElement } from "./helpers";
import { PerformancePanel } from "./performancePanel";
import style from "./review.module.css";
import { WhereUsedPanel } from "./whereUsedPanel";

export class UtilityDock {
    private dock?: HTMLElement;
    private panel?: { element: HTMLElement; dispose(): void };
    private documentId?: string;
    private kind?: string;
    constructor(
        private readonly app: IApplication,
        private readonly host: () => HTMLElement | null,
        private readonly beforeShow: () => void,
    ) {}
    connect() {
        PubSub.default.sub("openReviewComments", this.comments);
        PubSub.default.sub("openWhereUsed", this.whereUsed);
        PubSub.default.sub("activeViewChanged", this.viewChanged);
    }
    disconnect() {
        this.hide();
        PubSub.default.remove("openReviewComments", this.comments);
        PubSub.default.remove("openWhereUsed", this.whereUsed);
        PubSub.default.remove("activeViewChanged", this.viewChanged);
    }
    private readonly viewChanged = (view: IView | undefined) => {
        if (view?.document.id !== this.documentId) this.hide();
    };
    readonly comments = (target?: ReviewTarget) => this.show("Comments", target);
    readonly whereUsed = (target?: ReviewTarget) => this.show("Where used", target);
    readonly performance = () => this.show("Performance");
    private show(kind: string, target?: ReviewTarget) {
        if (this.kind === kind && !target) {
            this.hide();
            return;
        }
        this.hide();
        const doc = this.app.activeView?.document,
            host = this.host();
        if (!doc || !host) return;
        this.beforeShow();
        this.kind = kind;
        this.documentId = doc.id;
        this.panel =
            kind === "Comments"
                ? new CommentsPanel(doc, target)
                : kind === "Where used"
                  ? new WhereUsedPanel(doc, target)
                  : new PerformancePanel(doc);
        const dock = document.createElement("aside");
        dock.className = style.dock;
        const root = document.createElement("section");
        root.className = style.panel;
        const header = document.createElement("header");
        header.className = style.header;
        header.append(
            textElement("strong", kind),
            action(`Close ${kind}`, () => this.hide()),
        );
        root.append(header, this.panel.element);
        dock.append(root);
        host.insertBefore(dock, host.children[1] ?? null);
        this.dock = dock;
    }
    hide() {
        this.panel?.dispose();
        this.panel = undefined;
        const dock = this.dock;
        this.dock = undefined;
        if (dock !== undefined) leave(dock, () => dock.remove());
        this.kind = undefined;
        this.documentId = undefined;
    }
}
