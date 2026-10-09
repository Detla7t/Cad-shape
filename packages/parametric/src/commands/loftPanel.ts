// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Continuities, type Continuity, type I18nKeys, type IDocument } from "@chili3d/core";
import { createEditableTitle } from "@chili3d/element";
import style from "./extrudePanel.module.css";
import own from "./loftPanel.module.css";

export interface LoftPanelModel {
    document: IDocument;
    featureName?: string;
    solid: boolean;
    operation: I18nKeys;
    ruled: boolean;
    continuity: Continuity;
    /** Display labels of the sections in loft order ("Face of Sketch 1"). */
    readonly sectionLabels: string[];
    /** Kernel/validation message for the current preview; empty when the loft builds. */
    readonly previewError: string;
    removeSection(index: number): void;
    moveSection(index: number, delta: number): void;
    reverseSections(): void;
    onPropertyChanged(callback: (name: string) => void): void;
    removePropertyChanged(callback: (name: string) => void): void;
}

/**
 * The loft feature panel, laid out like Onshape's: Solid/Surface, the New/Add/Remove/
 * Intersect operation, an ordered Profiles list with remove and reorder controls,
 * and the guides-and-continuity options the kernel supports (ruled, continuity).
 * Profiles are picked in the viewport (sketch regions) or by clicking sketches in
 * the feature tree while the panel is open.
 */
export class LoftPanel {
    readonly element = document.createElement("section");
    private readonly accept = document.createElement("button");
    private readonly list = document.createElement("div");
    private readonly error = document.createElement("div");
    private readonly ruled = document.createElement("input");
    private readonly continuity = document.createElement("select");
    private readonly kinds = new Map<boolean, HTMLButtonElement>();
    private readonly operations = new Map<string, HTMLButtonElement>();

    constructor(
        private readonly model: LoftPanelModel,
        confirm: () => void,
        cancel: () => void,
    ) {
        const root = this.element;
        root.className = `${style.panel} ${own.panel}`;
        root.setAttribute("aria-label", "Loft feature");
        root.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") cancel();
            if (event.key === "Enter" && !this.accept.disabled) confirm();
        });
        for (const type of ["pointerdown", "pointermove"])
            root.addEventListener(type, (event) => event.stopPropagation());
        const header = document.createElement("header");
        const title = createEditableTitle(
            () => model.featureName || "Loft",
            (name) => {
                model.featureName = name;
            },
        );
        this.accept.textContent = "✓";
        this.accept.setAttribute("aria-label", "Accept loft");
        this.accept.onclick = confirm;
        const close = document.createElement("button");
        close.textContent = "×";
        close.setAttribute("aria-label", "Cancel loft");
        close.onclick = cancel;
        header.append(title.element, this.accept, close);
        root.append(header);

        const kinds = document.createElement("nav");
        kinds.setAttribute("aria-label", "Loft result");
        for (const [name, solid] of [
            ["Solid", true],
            ["Surface", false],
        ] as const) {
            const button = document.createElement("button");
            button.textContent = name;
            button.onclick = () => {
                model.solid = solid;
                this.refresh();
            };
            this.kinds.set(solid, button);
            kinds.append(button);
        }
        root.append(kinds);

        const tabs = document.createElement("nav");
        tabs.setAttribute("aria-label", "Loft operation");
        for (const [name, value] of [
            ["New", "new"],
            ["Add", "join"],
            ["Remove", "cut"],
            ["Intersect", "intersect"],
        ]) {
            const button = document.createElement("button");
            button.textContent = name;
            const key = `option.command.operation.${value}` as I18nKeys;
            button.onclick = () => {
                model.operation = key;
                this.refresh();
            };
            this.operations.set(key, button);
            tabs.append(button);
        }
        root.append(tabs);

        const heading = document.createElement("div");
        heading.className = own.heading;
        heading.textContent = "Profiles";
        const reverse = document.createElement("button");
        reverse.textContent = "⇅";
        reverse.title = "Reverse profile order";
        reverse.setAttribute("aria-label", "Reverse profile order");
        reverse.onclick = () => model.reverseSections();
        heading.append(reverse);
        this.list.className = own.list;
        this.list.setAttribute("role", "list");
        this.list.setAttribute("aria-label", "Loft profiles");
        this.list.title =
            "Click sketch regions in the viewport, or sketches in the feature tree, in loft order";
        root.append(heading, this.list);

        const options = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Guides and continuity";
        options.append(summary);
        this.ruled.type = "checkbox";
        this.ruled.setAttribute("aria-label", "Ruled");
        this.ruled.onchange = () => {
            model.ruled = this.ruled.checked;
            this.refresh();
        };
        const ruledLabel = document.createElement("label");
        ruledLabel.append(this.ruled, " Ruled");
        this.continuity.setAttribute("aria-label", "Continuity");
        for (const value of Continuities) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value.toUpperCase();
            this.continuity.append(option);
        }
        this.continuity.onchange = () => {
            model.continuity = this.continuity.value as Continuity;
            this.refresh();
        };
        const continuityLabel = document.createElement("label");
        continuityLabel.append("Continuity", this.continuity);
        options.append(ruledLabel, continuityLabel);
        root.append(options);

        this.error.className = style.error;
        this.error.setAttribute("role", "status");
        root.append(this.error);
        document.body.append(root);
        model.onPropertyChanged(this.refresh);
        this.refresh();
    }

    readonly refresh = () => {
        for (const [solid, button] of this.kinds)
            button.setAttribute("aria-pressed", String(solid === this.model.solid));
        for (const [key, button] of this.operations)
            button.setAttribute("aria-pressed", String(key === this.model.operation));
        this.ruled.checked = this.model.ruled;
        this.continuity.value = this.model.continuity;
        this.continuity.disabled = this.model.ruled;
        this.renderSections();
        const labels = this.model.sectionLabels;
        const message =
            labels.length < 2
                ? "Select at least two sketch profiles, in loft order."
                : this.model.previewError;
        this.error.textContent = message;
        this.accept.disabled = labels.length < 2 || this.model.previewError !== "";
    };

    private renderSections() {
        this.list.replaceChildren();
        const labels = this.model.sectionLabels;
        if (labels.length === 0) {
            const hint = document.createElement("span");
            hint.textContent = "Select sketch regions in loft order…";
            this.list.append(hint);
            return;
        }
        labels.forEach((label, index) => {
            const row = document.createElement("div");
            row.className = own.section;
            row.setAttribute("role", "listitem");
            const name = document.createElement("span");
            name.textContent = label;
            const up = document.createElement("button");
            up.textContent = "▲";
            up.title = "Move up";
            up.setAttribute("aria-label", `Move ${label} up`);
            up.disabled = index === 0;
            up.onclick = () => this.model.moveSection(index, -1);
            const down = document.createElement("button");
            down.textContent = "▼";
            down.title = "Move down";
            down.setAttribute("aria-label", `Move ${label} down`);
            down.disabled = index === labels.length - 1;
            down.onclick = () => this.model.moveSection(index, 1);
            const remove = document.createElement("button");
            remove.textContent = "×";
            remove.title = "Remove";
            remove.setAttribute("aria-label", `Remove ${label}`);
            remove.onclick = () => this.model.removeSection(index);
            row.append(name, up, down, remove);
            this.list.append(row);
        });
    }

    get canConfirm(): boolean {
        return !this.accept.disabled;
    }

    dispose() {
        this.model.removePropertyChanged(this.refresh);
        this.element.remove();
    }
}
