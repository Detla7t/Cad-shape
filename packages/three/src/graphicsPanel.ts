// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, DEFAULT_GRAPHICS, type GraphicsPreferences, VisualConfig } from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./graphicsPanel.module.css";
import type { ThreeView } from "./threeView";

export class GraphicsPanel {
    private static active?: GraphicsPanel;
    private readonly root = document.createElement("section");
    private readonly before: GraphicsPreferences;
    private closed = false;
    private tab: "General" | "Sketch" = "General";
    constructor(view: ThreeView) {
        GraphicsPanel.active?.dispose();
        GraphicsPanel.active = this;
        this.before = Config.instance.graphics;
        this.root.className = style.panel;
        this.root.setAttribute("aria-label", "Graphics preferences");
        for (const type of ["pointerdown", "pointerup", "pointermove", "dblclick", "wheel", "contextmenu"])
            this.root.addEventListener(type, (event) => event.stopPropagation());
        this.root.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Escape") this.dispose();
        };
        view.dom?.append(this.root);
        this.render();
    }
    private render() {
        const header = document.createElement("header"),
            title = document.createElement("strong");
        title.textContent = "Graphics preferences";
        const button = (label: string, action: () => void, icon?: string) => {
            const el = document.createElement("button");
            el.type = "button";
            el.setAttribute("aria-label", label);
            el.title = label;
            if (icon) el.append(createCadIcon(icon));
            else el.textContent = label;
            el.onclick = action;
            return el;
        };
        const accept = button(
            "Apply graphics preferences",
            () => {
                const invalid = this.root.querySelector<HTMLInputElement>("input:invalid");
                if (invalid) {
                    invalid.reportValidity();
                    return;
                }
                Config.instance.saveToStorage();
                this.close();
            },
            "check",
        );
        accept.className = style.accept;
        const cancel = button("Cancel graphics preferences", () => this.dispose(), "close");
        cancel.className = style.cancel;
        header.append(title, accept, cancel);
        const tabs = document.createElement("div");
        tabs.className = style.tabs;
        tabs.setAttribute("role", "tablist");
        for (const name of ["General", "Sketch"] as const) {
            const tab = button(name, () => {
                this.tab = name;
                this.render();
            });
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(name === this.tab));
            tabs.append(tab);
        }
        const content = document.createElement("div");
        content.className = style.content;
        content.setAttribute("role", "tabpanel");
        content.setAttribute("aria-label", this.tab);
        const group = (name: string) => {
            const details = document.createElement("details"),
                summary = document.createElement("summary");
            details.open = true;
            summary.textContent = name;
            details.append(summary);
            content.append(details);
            return details;
        };
        const set = <K extends keyof GraphicsPreferences>(key: K, value: GraphicsPreferences[K]) => {
            Config.instance.graphics = { ...Config.instance.graphics, [key]: value };
            reset.disabled = JSON.stringify(Config.instance.graphics) === JSON.stringify(DEFAULT_GRAPHICS);
        };
        const number = (
            parent: HTMLElement,
            label: string,
            key: keyof GraphicsPreferences,
            unit: string,
            min: number,
            max: number,
            step: number,
            slider = true,
        ) => {
            const row = document.createElement("label"),
                text = document.createElement("span"),
                input = document.createElement("input"),
                suffix = document.createElement("span");
            row.className = style.row;
            text.textContent = label;
            input.type = "number";
            input.required = true;
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(Config.instance.graphics[key]);
            input.setAttribute("aria-label", `${parent.querySelector("summary")?.textContent} ${label}`);
            suffix.textContent = unit;
            row.append(text, input, suffix);
            parent.append(row);
            const range = document.createElement("input");
            range.type = "range";
            range.min = input.min;
            range.max = input.max;
            range.step = input.step;
            range.value = input.value;
            range.setAttribute("aria-label", `${input.getAttribute("aria-label")} slider`);
            input.oninput = () => {
                if (input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
                    set(key, input.valueAsNumber);
                    range.value = input.value;
                }
            };
            range.oninput = () => {
                input.value = range.value;
                set(key, range.valueAsNumber);
            };
            if (slider) parent.append(range);
        };
        const color = (parent: HTMLElement, label: string, key?: keyof GraphicsPreferences) => {
            const row = document.createElement("label"),
                text = document.createElement("span"),
                input = document.createElement("input");
            row.className = style.color;
            text.textContent = label;
            input.type = "color";
            input.setAttribute("aria-label", `${parent.querySelector("summary")?.textContent} ${label}`);
            input.value = key
                ? String(
                      Config.instance.graphics[key] ??
                          `#${VisualConfig.defaultEdgeColor.toString(16).padStart(6, "0")}`,
                  )
                : "#dd0000";
            input.disabled = !key;
            if (!key)
                row.title =
                    "Section interference highlighting requires capped sections, which this renderer does not yet support.";
            input.oninput = () => {
                if (key) set(key, input.value);
            };
            row.append(text, input);
            parent.append(row);
        };
        if (this.tab === "General") {
            const viewport = group("Viewport");
            number(viewport, "Ambient occlusion", "ambientOcclusion", "%", 0, 100, 0.5);
            number(viewport, "Field of view", "fieldOfView", "deg", 10, 120, 1);
            const bodies = group("Shaded bodies");
            number(bodies, "Line width", "bodyLineWidth", "px", 0.1, 5, 0.1);
            number(bodies, "Shininess", "shininess", "%", 0, 100, 1);
            color(bodies, "Specular color", "specularColor");
            color(bodies, "Section interference color");
            const phantom = group("Phantom edges");
            number(phantom, "Phantom tangent edge width", "phantomLineWidth", "px", 0.1, 5, 0.1);
            color(phantom, "Phantom tangent edge color", "phantomColor");
            number(group("Mesh bodies"), "Mesh line width", "meshLineWidth", "px", 0.1, 5, 0.1);
        } else {
            const active = group("Active sketches");
            number(active, "Line width", "activeLineWidth", "px", 0.5, 8, 0.5);
            color(active, "Constrained color", "constrainedColor");
            color(active, "Underconstrained color", "underconstrainedColor");
            color(active, "Underconstrained occluded color", "occludedColor");
            const inactive = group("Inactive sketches");
            number(inactive, "Line width", "inactiveLineWidth", "px", 0.5, 8, 0.5);
            color(inactive, "Color", "inactiveColor");
            number(inactive, "Region opacity", "inactiveRegionOpacity", "%", 0, 100, 1);
            number(inactive, "Point size", "inactivePointSize", "px", 0, 8, 0.5);
            const construction = group("Construction lines");
            number(construction, "First dash", "firstDash", "px", 1, 100, 1, false);
            number(construction, "First gap", "firstGap", "px", 1, 100, 1, false);
            number(construction, "Second dash", "secondDash", "px", 1, 100, 1, false);
            number(construction, "Second gap", "secondGap", "px", 1, 100, 1, false);
        }
        const footer = document.createElement("footer");
        const reset = button("Reset to default", () => {
            Config.instance.graphics = { ...DEFAULT_GRAPHICS };
            this.render();
        });
        reset.disabled = JSON.stringify(Config.instance.graphics) === JSON.stringify(DEFAULT_GRAPHICS);
        footer.append(reset);
        this.root.replaceChildren(header, tabs, content, footer);
    }
    private close() {
        this.closed = true;
        this.root.remove();
        if (GraphicsPanel.active === this) GraphicsPanel.active = undefined;
    }
    dispose() {
        if (this.closed) return;
        Config.instance.graphics = this.before;
        this.close();
    }
}
