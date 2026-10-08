// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView } from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { analysisMenu } from "./analysisMenu";
import { GeometryPanel, type GeometryPanelKind } from "./geometryPanel";
import { action, textElement } from "./helpers";
import panelStyle from "./review.module.css";
import { SelectionMeasurementControl } from "./selectionMeasurementControl";
import style from "./viewportUtilities.module.css";

export class ViewportUtilities {
    readonly selection: SelectionMeasurementControl;
    readonly element = document.createElement("div");
    private readonly popup = document.createElement("section");
    private mounted?: GeometryPanel;
    private active?: GeometryPanelKind;
    private readonly buttons = new Map<GeometryPanelKind, HTMLButtonElement>();
    constructor(private readonly view: IView) {
        this.element.className = style.root;
        const toolbar = document.createElement("div");
        toolbar.className = style.toolbar;
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", "Viewport inspection tools");
        this.selection = new SelectionMeasurementControl(view, () => this.close());
        toolbar.append(this.selection.element);
        for (const [kind, label, icon] of [
            ["measure", "Show measure details", "measure-details"],
            ["analysis", "Show analysis tools", "analysis-tools"],
            ["mass", "Display mass and section properties", "mass-properties"],
        ] as const) {
            const button = document.createElement("button");
            button.title = label;
            button.setAttribute("aria-label", label);
            button.setAttribute("aria-expanded", "false");
            button.append(createCadIcon(icon));
            button.onclick = () => this.toggle(kind);
            this.buttons.set(kind, button);
            toolbar.append(button);
        }
        this.popup.className = style.popup;
        this.popup.hidden = true;
        this.element.append(this.popup, this.selection.popup, toolbar);
        for (const event of [
            "pointerdown",
            "pointerup",
            "pointermove",
            "dblclick",
            "wheel",
            "contextmenu",
            "keydown",
        ])
            this.element.addEventListener(event, (e) => e.stopPropagation());
    }
    private toggle(kind: GeometryPanelKind) {
        const was = this.active;
        this.close();
        if (was === kind) return;
        this.view.document.application.activeView = this.view;
        this.active = kind;
        this.buttons.get(kind)?.setAttribute("aria-expanded", "true");
        if (kind === "analysis") {
            this.popup.replaceChildren(
                analysisMenu((tool) =>
                    this.showPanel(
                        kind,
                        tool === "geometry" ? "Curve/surface analysis" : "Interference detection",
                        tool,
                    ),
                ),
            );
            this.popup.hidden = false;
            return;
        }
        this.showPanel(kind, kind === "measure" ? "Measure" : "Mass and section properties");
    }
    private showPanel(
        kind: GeometryPanelKind,
        title: string,
        analysisTool: "geometry" | "interference" = "geometry",
    ) {
        const heading = document.createElement("header");
        heading.className = panelStyle.header;
        heading.append(
            textElement("strong", title),
            action("Close", () => this.close()),
        );
        this.mounted = new GeometryPanel(this.view, kind, analysisTool);
        this.popup.replaceChildren(heading, this.mounted.element);
        this.popup.hidden = false;
        this.popup.querySelector<HTMLElement>("button:not(:disabled), select")?.focus();
    }
    close() {
        this.selection.close();
        this.mounted?.dispose();
        this.mounted = undefined;
        this.active = undefined;
        this.popup.hidden = true;
        this.popup.replaceChildren();
        for (const button of this.buttons.values()) button.setAttribute("aria-expanded", "false");
    }
    dispose() {
        this.close();
        this.selection.dispose();
    }
}
