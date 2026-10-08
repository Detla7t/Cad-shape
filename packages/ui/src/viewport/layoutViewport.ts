// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CollectionChangedArgs,
    type CursorType,
    type IApplication,
    type IDocument,
    type IView,
    PubSub,
} from "@chili3d/core";
import { Cursor } from "../cursor";
import style from "./layoutViewport.module.css";
import { Viewport } from "./viewport";

export class LayoutViewport extends HTMLElement {
    private readonly _viewports: Map<IView, Viewport> = new Map();
    private readonly layouts = new WeakMap<IDocument, string>();
    private readonly layoutSelect = document.createElement("select");

    constructor(
        readonly app: IApplication,
        readonly showViewControls: boolean = true,
    ) {
        super();
        this.className = style.root;
        this.layoutSelect.setAttribute("aria-label", "Viewport layout");
        this.layoutSelect.title = "Viewport layout";
        this.layoutSelect.className = style.layoutSelect;
        for (const [value, label] of [
            ["single", "Single view"],
            ["columns", "Two views · side by side"],
            ["rows", "Two views · stacked"],
            ["four", "Four views"],
        ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            this.layoutSelect.append(option);
        }
        this.layoutSelect.onchange = () => this.setLayout(this.layoutSelect.value);
        this.append(this.layoutSelect);
    }

    private readonly _handleViewCollectionChanged = (args: CollectionChangedArgs) => {
        if (args.action === "add") {
            args.items.forEach((view) => {
                this.createViewport(view);
            });
        } else if (args.action === "remove") {
            args.items.forEach((view) => {
                const viewport = this._viewports.get(view);
                viewport?.remove();
                viewport?.dispose();
                this._viewports.delete(view);
            });
        }
        this._handleActiveViewChanged(this.app.activeView);
    };

    connectedCallback(): void {
        this.app.views.onCollectionChanged(this._handleViewCollectionChanged);
        this.app.views.forEach((view) => this.createViewport(view));
        PubSub.default.sub("activeViewChanged", this._handleActiveViewChanged);
        PubSub.default.sub("viewCursor", this._handleCursor);
        this._handleActiveViewChanged(this.app.activeView);
    }

    disconnectedCallback(): void {
        this.app.views.removeCollectionChanged(this._handleViewCollectionChanged);
        PubSub.default.remove("activeViewChanged", this._handleActiveViewChanged);
        PubSub.default.remove("viewCursor", this._handleCursor);
    }

    private readonly _handleCursor = (type: CursorType) => {
        this.style.cursor = Cursor.get(type);
    };

    private createViewport(view: IView) {
        if (this._viewports.has(view)) return this._viewports.get(view)!;
        const viewport = new Viewport(view, this.showViewControls);
        viewport.classList.add(style.viewport, style.hidden);
        this.appendChild(viewport);
        this._viewports.set(view, viewport);
        return viewport;
    }

    /** Cameras belong to panes; all panes share the same model and selection. */
    setLayout(layout: string): void {
        const active = this.app.activeView;
        if (!active || !["single", "columns", "rows", "four"].includes(layout)) return;
        const count = layout === "four" ? 4 : layout === "single" ? 1 : 2;
        this.layouts.set(active.document, layout);
        const views = this.app.views.filter((view) => view.document === active.document);
        while (views.length < count) {
            const view = active.document.visual.createView(`View ${views.length + 1}`, active.workplane);
            view.mode = active.mode;
            const camera = active.cameraController;
            view.cameraController.cameraType = camera.cameraType;
            view.cameraController.lookAt(camera.cameraPosition, camera.cameraTarget, camera.cameraUp);
            view.update();
            views.push(view);
        }
        // Keep the currently used camera when returning to fewer views.
        const retained = [active, ...views.filter((view) => view !== active)].slice(0, count);
        for (const view of views) if (!retained.includes(view)) view.close();
        this._handleActiveViewChanged(active);
    }

    private readonly _handleActiveViewChanged = (view: IView | undefined) => {
        const layout = view ? (this.layouts.get(view.document) ?? "single") : "single";
        this.dataset["layout"] = layout;
        this.layoutSelect.value = layout;
        this.layoutSelect.hidden = !view || !this.showViewControls;
        this._viewports.forEach((v) => {
            if (v.view === view || (layout !== "single" && v.view.document === view?.document)) {
                v.classList.remove(style.hidden);
                v.view.update();
            } else {
                v.classList.add(style.hidden);
            }
            v.dataset["active"] = String(v.view === view);
            v.setAttribute("aria-label", v.view.name);
        });
    };
}

customElements.define("chili-viewport", LayoutViewport);
