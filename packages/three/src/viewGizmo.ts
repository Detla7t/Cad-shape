// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IViewGizmo } from "@chili3d/core";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { CameraController } from "./cameraController";
import type { ThreeView } from "./threeView";
import { createCubeRegions } from "./viewCubeGeometry";
import style from "./viewGizmo.module.css";
import { ViewMenu } from "./viewMenu";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
}

export class ViewGizmo extends HTMLElement implements IViewGizmo {
    readonly cameraController: CameraController;
    private readonly drawing = svg("svg", { viewBox: "0 0 150 160", "aria-label": "View cube" });
    private readonly cube = svg("g");
    private readonly axes = svg("g", { class: style.axes });
    private readonly regions = createCubeRegions().map((region) => {
        const group = svg("g", { class: style.region, "data-kind": region.kind });
        const polygon = svg("polygon");
        const label = svg("text", { "text-anchor": "middle", "dominant-baseline": "central" });
        label.textContent = region.kind === "face" ? region.name : "";
        group.append(polygon, label);
        this.button(group, `${region.name} view`, () => this.orient(region.normal));
        return { ...region, group, polygon, label };
    });
    private readonly axisLines = ["#e85b57", "#55ba65", "#608be9"].map((color, i) => {
        const line = svg("line", { stroke: color });
        const label = svg("text", { fill: color });
        label.textContent = "XYZ"[i];
        this.axes.append(line, label);
        return { line, label };
    });
    private drag?: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean };
    private suppressClick = false;
    private lastRotation?: Quaternion;
    private readonly menu: ViewMenu;

    constructor(readonly view: ThreeView) {
        super();
        this.cameraController = view.cameraController;
        this.menu = new ViewMenu(view, (direction) => this.orient(direction));
        this.className = style.root;
        this.drawing.append(this.axes, this.cube);
        this.append(this.drawing);
        this.addControls();
        this.update();
    }

    setDom(dom: HTMLElement): void {
        this.remove();
        dom.appendChild(this);
    }

    dispose(): void {
        this.remove();
    }

    connectedCallback() {
        this.addEventListener("pointerdown", this.pointerDown);
        this.addEventListener("pointermove", this.pointerMove);
        this.addEventListener("pointerup", this.pointerUp);
        this.addEventListener("pointercancel", this.pointerCancel);
        this.addEventListener("lostpointercapture", this.pointerCancel);
        this.addEventListener("pointerout", this.stopPropagation);
        this.addEventListener("contextmenu", this.contextMenu);
        window.addEventListener("pointerup", this.endOutsideDrag);
        window.addEventListener("pointercancel", this.endOutsideDrag);
    }

    disconnectedCallback() {
        this.menu.dispose();
        this.removeEventListener("pointerdown", this.pointerDown);
        this.removeEventListener("pointermove", this.pointerMove);
        this.removeEventListener("pointerup", this.pointerUp);
        this.removeEventListener("pointercancel", this.pointerCancel);
        this.removeEventListener("lostpointercapture", this.pointerCancel);
        this.removeEventListener("pointerout", this.stopPropagation);
        this.removeEventListener("contextmenu", this.contextMenu);
        window.removeEventListener("pointerup", this.endOutsideDrag);
        window.removeEventListener("pointercancel", this.endOutsideDrag);
        this.drag = undefined;
    }

    private button(node: SVGElement, name: string, action: (event: MouseEvent | KeyboardEvent) => void) {
        node.setAttribute("role", "button");
        node.setAttribute("tabindex", "0");
        node.setAttribute("aria-label", name);
        const title = svg("title");
        title.textContent = name;
        node.append(title);
        node.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!this.suppressClick) action(event);
            this.suppressClick = false;
        });
        node.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                action(event);
            }
        });
    }

    private addControls() {
        const controls: [string, string, Vector3, number][] = [
            ["Rotate up", "M75 6 L68 15 L82 15 Z", new Vector3(1, 0, 0), -1],
            ["Rotate down", "M75 142 L68 133 L82 133 Z", new Vector3(1, 0, 0), 1],
            ["Rotate left", "M7 77 L16 70 L16 84 Z", new Vector3(0, 1, 0), -1],
            ["Rotate right", "M143 77 L134 70 L134 84 Z", new Vector3(0, 1, 0), 1],
            [
                "Roll counterclockwise",
                "M62 19 Q37 21 24 43 L19 37 L19 54 L35 49 L29 46 Q40 28 63 26 Z",
                new Vector3(0, 0, 1),
                -1,
            ],
            [
                "Roll clockwise",
                "M88 19 Q113 21 126 43 L131 37 L131 54 L115 49 L121 46 Q110 28 87 26 Z",
                new Vector3(0, 0, 1),
                1,
            ],
        ];
        for (const [name, d, axis, sign] of controls) {
            const group = svg("g", { class: style.control });
            const path = svg("path", { d });
            // Transparent stroke increases the hit area without increasing the visible arrow.
            const hit = svg("path", { d, fill: "transparent", stroke: "transparent", "stroke-width": "12" });
            group.append(path, hit);
            this.button(group, `${name} (15°; Shift 90°; Ctrl 5°)`, (event) => {
                const degrees = event.shiftKey ? 90 : event.ctrlKey || event.metaKey ? 5 : 15;
                const rotation = this.cameraController.camera.quaternion
                    .clone()
                    .multiply(new Quaternion().setFromAxisAngle(axis, (sign * degrees * Math.PI) / 180));
                this.setRotation(rotation);
            });
            this.drawing.append(group);
        }
        const home = svg("g", { class: style.control });
        home.append(
            svg("path", {
                d: "M122 137 L131 133 L140 137 L140 148 L131 153 L122 148 Z",
                stroke: "currentColor",
                "stroke-width": "0.7",
            }),
            svg("path", {
                d: "M122 137 L131 142 L140 137 M131 142 L131 153",
                fill: "none",
                stroke: "currentColor",
                "stroke-width": "0.7",
            }),
        );
        home.append(svg("path", { d: "m143 142 3 4 3-4Z" }));
        this.button(home, "View options", () => this.menu.open(home));
        this.drawing.append(home);
    }

    private orient(direction: Vector3) {
        const up =
            Math.abs(direction.z) === direction.length()
                ? new Vector3(0, Math.sign(direction.z), 0)
                : new Vector3(0, 0, 1);
        this.setRotation(
            new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(direction, new Vector3(), up)),
        );
    }

    private setRotation(rotation: Quaternion) {
        const { camera, target } = this.cameraController;
        const distance = camera.position.distanceTo(target);
        const eye = new Vector3(0, 0, distance).applyQuaternion(rotation).add(target);
        const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
        this.cameraController.lookAt(eye, target, up);
        this.view.update();
        this.update();
    }

    private readonly stopPropagation = (event: Event) => event.stopPropagation();
    private readonly contextMenu = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
    };
    private readonly pointerDown = (event: PointerEvent) => {
        event.stopPropagation();
        if (event.button !== 0 && event.button !== 2) return;
        this.suppressClick = false;
        this.drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        };
        this.cameraController.setRotateCenterToSelected();
    };
    private readonly pointerMove = (event: PointerEvent) => {
        event.stopPropagation();
        const drag = this.drag;
        if (!drag || drag.id !== event.pointerId) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
        if (!drag.moved) {
            try {
                this.setPointerCapture?.(event.pointerId);
            } catch {
                /* Synthetic pointers have no capture. */
            }
        }
        drag.moved = true;
        this.suppressClick = true;
        this.cameraController.rotate(event.clientX - drag.x, event.clientY - drag.y, "trackball");
        drag.x = event.clientX;
        drag.y = event.clientY;
        this.view.update();
    };
    private readonly pointerUp = (event: PointerEvent) => {
        event.stopPropagation();
        this.drag = undefined;
        if (this.hasPointerCapture?.(event.pointerId)) this.releasePointerCapture(event.pointerId);
    };
    private readonly pointerCancel = (event: PointerEvent) => {
        this.suppressClick = true;
        this.pointerUp(event);
    };
    private readonly endOutsideDrag = (event: PointerEvent) => {
        if (this.drag?.id === event.pointerId) this.pointerCancel(event);
    };

    update() {
        const rotation = this.cameraController.camera.quaternion;
        if (this.lastRotation?.equals(rotation)) return;
        this.lastRotation = rotation.clone();
        const inverse = rotation.clone().invert();
        const project = (point: Vector3) => {
            const p = point.clone().applyQuaternion(inverse);
            return { x: 75 + p.x * 28, y: 77 - p.y * 28, z: p.z };
        };
        const regions = this.regions
            .map((region) => ({ region, normal: region.normal.clone().applyQuaternion(inverse) }))
            .sort((a, b) => a.normal.z - b.normal.z);
        for (const { region, normal } of regions) {
            const visible = normal.z > 0.001;
            region.group.style.display = visible ? "" : "none";
            region.group.setAttribute("tabindex", visible ? "0" : "-1");
            region.group.setAttribute("aria-hidden", String(!visible));
            if (visible) {
                region.polygon.setAttribute(
                    "points",
                    region.vertices
                        .map((v) => {
                            const p = project(v);
                            return `${p.x},${p.y}`;
                        })
                        .join(" "),
                );
                if (region.up) {
                    const right = region.up.clone().cross(region.normal).applyQuaternion(inverse);
                    const up = region.up.clone().applyQuaternion(inverse);
                    const center = project(region.normal);
                    region.label.setAttribute(
                        "transform",
                        `matrix(${right.x} ${-right.y} ${-up.x} ${up.y} ${center.x} ${center.y})`,
                    );
                }
            }
            this.cube.append(region.group);
        }
        // A small world-axis triad stays below the cube and follows the same camera rotation.
        for (let i = 0; i < 3; i++) {
            const axis = new Vector3().setComponent(i, 1).applyQuaternion(inverse);
            const x = 36 + axis.x * 24;
            const y = 116 - axis.y * 24;
            const { line, label } = this.axisLines[i];
            for (const [key, value] of Object.entries({ x1: 36, y1: 116, x2: x, y2: y }))
                line.setAttribute(key, String(value));
            label.setAttribute("x", String(x + axis.x * 7 - 3));
            label.setAttribute("y", String(y - axis.y * 7 + 3));
            label.style.display = Math.hypot(axis.x, axis.y) < 0.15 ? "none" : "";
        }
    }
}

customElements.define("view-gizmo", ViewGizmo);
