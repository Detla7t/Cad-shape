// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type XYZLike } from "@chili3d/core";
import { Plane, Vector3 } from "three";
import type { ThreeView } from "./threeView";
import style from "./viewGizmo.module.css";

type MenuItem =
    | { name: string; action?: () => void; checked?: boolean; disabled?: boolean; children?: MenuItem[] }
    | "separator";
type NamedView = { name: string; eye: XYZLike; target: XYZLike; up: XYZLike; perspective: boolean };

export class ViewMenu {
    private close?: () => void;
    private cancelWindow?: () => void;
    constructor(
        private readonly view: ThreeView,
        private readonly orient: (direction: Vector3) => void,
    ) {}
    dispose() {
        this.close?.();
        this.cancelWindow?.();
    }

    open(anchor: Element) {
        this.close?.();
        const cc = this.view.cameraController;
        const display = this.view.displayOptions;
        const change = (action: () => void) => () => {
            cc.rememberView();
            action();
            this.view.update();
        };
        const menu = document.createElement("div");
        menu.className = style.menu;
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", "View options");
        const events = new AbortController();
        const close = () => {
            menu.remove();
            events.abort();
            this.close = undefined;
        };
        this.close = close;
        const mode = (name: string, value: ThreeView["mode"]): MenuItem => ({
            name,
            checked: this.view.mode === value,
            action: change(() => {
                this.view.mode = value;
            }),
        });
        const items: MenuItem[] = [
            { name: "Isometric", action: change(() => this.orient(new Vector3(1, -1, 1))) },
            { name: "Dimetric", action: change(() => this.orient(new Vector3(1, -1, 0.55))) },
            { name: "Trimetric", action: change(() => this.orient(new Vector3(1, -1.6, 1.1))) },
            "separator",
            { name: "Graphics preferences…", action: () => this.graphics() },
            { name: "Named views…", action: () => this.namedViews() },
            {
                name: "Previous view",
                disabled: !cc.hasPreviousView,
                action: () => {
                    cc.restorePreviousView();
                    this.view.update();
                },
            },
            "separator",
            { name: "Zoom to fit", action: change(() => cc.fitContent()) },
            { name: "Zoom to window", action: () => this.zoomWindow() },
            "separator",
            {
                name: "Perspective view",
                checked: cc.cameraType === "perspective",
                action: change(() => {
                    cc.cameraType = cc.cameraType === "perspective" ? "orthographic" : "perspective";
                }),
            },
            {
                name: "Orient normal to sketch on edit",
                checked: Config.instance.orientNormalOnSketchEdit,
                action: () => {
                    Config.instance.orientNormalOnSketchEdit = !Config.instance.orientNormalOnSketchEdit;
                },
            },
            "separator",
            {
                name:
                    this.view.mode === "solidAndWireframe"
                        ? "Shaded with edges"
                        : this.view.mode === "solid"
                          ? "Shaded"
                          : "Wireframe",
                children: [
                    mode("Shaded with edges", "solidAndWireframe"),
                    mode("Shaded", "solid"),
                    mode("Wireframe", "wireframe"),
                ],
            },
            {
                name: display.hiddenEdges ? "Hidden edges visible" : "Hidden edges removed",
                children: [false, true].map((value) => ({
                    name: value ? "Hidden edges visible" : "Hidden edges removed",
                    checked: display.hiddenEdges === value,
                    action: change(() => {
                        display.hiddenEdges = value;
                    }),
                })),
            },
            {
                name: `Tangent edges ${display.tangentEdges}`,
                children: (["visible", "hidden", "phantom"] as const).map((value) => ({
                    name: `Tangent edges ${value}`,
                    checked: display.tangentEdges === value,
                    action: change(() => {
                        display.tangentEdges = value;
                    }),
                })),
            },
            "separator",
            {
                name: "View in high quality",
                checked: this.view.renderer.getPixelRatio() > 1,
                action: () => {
                    this.view.renderer.setPixelRatio(this.view.renderer.getPixelRatio() > 1 ? 1 : 2);
                    this.view.update();
                },
            },
            {
                name: "Highlight boundary edges",
                checked: display.boundaryEdges,
                action: change(() => {
                    display.boundaryEdges = !display.boundaryEdges;
                }),
            },
            "separator",
            { name: "Section view…", action: () => this.section() },
        ];
        const render = (entries: MenuItem[], back = false) => {
            menu.replaceChildren();
            if (back) {
                const button = document.createElement("button");
                button.textContent = "‹ View options";
                button.onclick = () => render(items);
                menu.append(button);
            }
            for (const item of entries) {
                if (item === "separator") {
                    menu.append(document.createElement("hr"));
                    continue;
                }
                const button = document.createElement("button");
                button.type = "button";
                button.disabled = !!item.disabled;
                button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
                button.setAttribute("aria-label", item.name);
                if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
                button.textContent = `${item.checked ? "✓" : ""}  ${item.name}${item.children ? "  ›" : ""}`;
                button.onclick = () => {
                    if (item.children) render(item.children, true);
                    else {
                        close();
                        item.action?.();
                    }
                };
                menu.append(button);
            }
        };
        render(items);
        document.body.append(menu);
        const rect = anchor.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(rect.bottom, window.innerHeight - menu.offsetHeight - 4))}px`;
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (!menu.contains(event.target as Node)) close();
            },
            { capture: true, signal: events.signal },
        );
        menu.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Escape") close();
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[
                    (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
                ]?.focus();
            }
        };
        menu.querySelector("button")?.focus();
    }

    private dialog(title: string) {
        const dialog = document.createElement("dialog");
        dialog.className = style.dialog;
        dialog.setAttribute("aria-label", title);
        const heading = document.createElement("strong");
        heading.textContent = title;
        dialog.append(heading);
        dialog.onkeydown = (event) => event.stopPropagation();
        dialog.oncancel = () => dialog.remove();
        document.body.append(dialog);
        dialog.showModal();
        return dialog;
    }
    private done(dialog: HTMLDialogElement) {
        const done = document.createElement("button");
        done.textContent = "Done";
        done.onclick = () => dialog.remove();
        dialog.append(done);
    }
    private graphics() {
        const dialog = this.dialog("Graphics preferences");
        const row = document.createElement("label");
        row.textContent = "Rendering quality ";
        const select = document.createElement("select");
        select.add(new Option("Standard", "1"));
        select.add(new Option("High", "2"));
        select.value = this.view.renderer.getPixelRatio() > 1 ? "2" : "1";
        select.onchange = () => {
            this.view.renderer.setPixelRatio(Number(select.value));
            this.view.update();
        };
        row.append(select);
        dialog.append(row);
        const note = document.createElement("p");
        note.textContent =
            "Antialiasing is enabled. High quality uses more pixels for smoother curves and edges.";
        dialog.append(note);
        this.done(dialog);
    }
    private namedViews() {
        const dialog = this.dialog("Named views");
        const key = `chili.namedViews.${this.view.document.id}`;
        let views: NamedView[] = [];
        try {
            views = JSON.parse(localStorage.getItem(key) ?? "[]");
        } catch {
            /* Start an empty local view list. */
        }
        const list = document.createElement("div");
        const render = () => {
            list.replaceChildren();
            for (const saved of views) {
                const row = document.createElement("div");
                const load = document.createElement("button");
                load.textContent = saved.name;
                load.onclick = () => {
                    const cc = this.view.cameraController;
                    cc.rememberView();
                    cc.cameraType = saved.perspective ? "perspective" : "orthographic";
                    cc.lookAt(saved.eye, saved.target, saved.up);
                    this.view.update();
                };
                const remove = document.createElement("button");
                remove.textContent = "×";
                remove.setAttribute("aria-label", `Delete ${saved.name}`);
                remove.onclick = () => {
                    views = views.filter((v) => v !== saved);
                    localStorage.setItem(key, JSON.stringify(views));
                    render();
                };
                row.append(load, remove);
                list.append(row);
            }
        };
        const name = document.createElement("input");
        name.placeholder = "View name";
        name.setAttribute("aria-label", "View name");
        const save = document.createElement("button");
        save.textContent = "Save current view";
        save.onclick = () => {
            if (!name.value.trim()) return;
            const cc = this.view.cameraController;
            views = views.filter((v) => v.name !== name.value.trim());
            views.push({
                name: name.value.trim(),
                eye: cc.cameraPosition,
                target: cc.cameraTarget,
                up: cc.cameraUp,
                perspective: cc.cameraType === "perspective",
            });
            localStorage.setItem(key, JSON.stringify(views));
            render();
        };
        dialog.append(list, name, save);
        render();
        this.done(dialog);
    }
    private zoomWindow() {
        const host = this.view.dom;
        if (!host) return;
        this.cancelWindow?.();
        const overlay = document.createElement("div");
        overlay.className = style.zoomOverlay;
        overlay.tabIndex = 0;
        overlay.setAttribute("aria-label", "Drag a zoom window; Escape to cancel");
        const box = document.createElement("div");
        overlay.append(box);
        host.append(overlay);
        let start: { x: number; y: number } | undefined;
        const point = (event: PointerEvent) => {
            const rect = host.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };
        const close = () => {
            overlay.remove();
            this.cancelWindow = undefined;
        };
        this.cancelWindow = close;
        overlay.onpointerdown = (event) => {
            event.stopPropagation();
            start = point(event);
            overlay.setPointerCapture(event.pointerId);
        };
        overlay.onpointermove = (event) => {
            event.stopPropagation();
            if (!start) return;
            const end = point(event);
            box.style.cssText = `left:${Math.min(start.x, end.x)}px;top:${Math.min(start.y, end.y)}px;width:${Math.abs(end.x - start.x)}px;height:${Math.abs(end.y - start.y)}px`;
        };
        overlay.onpointerup = (event) => {
            event.stopPropagation();
            if (start) {
                const end = point(event);
                this.view.cameraController.zoomWindow(start.x, start.y, end.x, end.y);
                this.view.update();
            }
            close();
        };
        overlay.onpointercancel = close;
        overlay.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Escape") close();
        };
        overlay.focus();
    }
    private section() {
        const dialog = this.dialog("Section view");
        const axis = document.createElement("select");
        axis.setAttribute("aria-label", "Section plane");
        for (const [name, value] of [
            ["Top (XY)", "z"],
            ["Front (XZ)", "y"],
            ["Right (YZ)", "x"],
        ])
            axis.add(new Option(name, value));
        const offset = document.createElement("input");
        offset.type = "number";
        offset.value = "0";
        offset.setAttribute("aria-label", "Section offset (mm)");
        const flip = document.createElement("input");
        flip.type = "checkbox";
        flip.setAttribute("aria-label", "Reverse section");
        const label = document.createElement("label");
        label.append(flip, " Reverse direction");
        const apply = () => {
            if (!Number.isFinite(offset.valueAsNumber)) return;
            const normal = new Vector3(
                axis.value === "x" ? 1 : 0,
                axis.value === "y" ? 1 : 0,
                axis.value === "z" ? 1 : 0,
            ).multiplyScalar(flip.checked ? -1 : 1);
            this.view.renderer.clippingPlanes = [
                new Plane(normal, -offset.valueAsNumber * (flip.checked ? -1 : 1)),
            ];
            this.view.update();
        };
        axis.onchange = offset.oninput = flip.onchange = apply;
        const reset = document.createElement("button");
        reset.textContent = "Turn off section";
        reset.onclick = () => {
            this.view.renderer.clippingPlanes = [];
            this.view.update();
            dialog.remove();
        };
        dialog.append(axis, offset, label, reset);
        this.done(dialog);
        apply();
    }
}
