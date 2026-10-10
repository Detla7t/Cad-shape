// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IViewGizmo, Plane } from "@chili3d/core";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { CameraController } from "./cameraController";
import type { ThreeView } from "./threeView";
import {
    cornerDisc,
    createCubeRegions,
    discEllipse,
    roundedCubePatch,
    visibleCubeAxis,
} from "./viewCubeGeometry";
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
    private readonly cube = svg("g", { "data-role": "view-cube" });
    private readonly axes = svg("g", { class: style.axes, "data-role": "cube-axes" });
    private readonly regions = createCubeRegions().map((region) => {
        const group = svg("g", { class: style.region, "data-kind": region.kind });
        const polygon = svg("polygon", { class: style.hitTarget });
        // a corner is a flat round facet: a disc that tilts with the cube, never a ball
        const surface = svg(region.kind === "corner" ? "ellipse" : "path", { class: style.surface });
        const label = svg("text", { "text-anchor": "middle", "dominant-baseline": "central" });
        label.textContent = region.kind === "face" ? region.name : "";
        group.append(polygon, surface, label);
        this.button(group, `${region.name} view`, () => this.orient(region.normal));
        return { ...region, group, polygon, surface, label };
    });
    /**
     * The cube is translucent, so the names of the faces on its far side show through it;
     * each is a target of its own, drawn over the cube, so any face can be turned to at any
     * moment without orbiting first (Onshape's cube). Hovering one lights its face.
     */
    private readonly through = svg("g", { "data-role": "through-labels" });
    private readonly throughLabels = this.regions
        .filter((region) => region.kind === "face")
        .map((region) => {
            const group = svg("g", { class: style.through });
            const hit = svg("rect", { x: "-19", y: "-7", width: "38", height: "14", rx: "3" });
            const text = svg("text", { "text-anchor": "middle", "dominant-baseline": "central" });
            text.textContent = region.name;
            group.append(hit, text);
            this.button(group, `${region.name} view`, () => this.orient(region.normal));
            group.addEventListener("pointerenter", () => {
                region.group.dataset["hover"] = "true";
            });
            group.addEventListener("pointerleave", () => {
                delete region.group.dataset["hover"];
            });
            this.through.append(group);
            return { region, group };
        });
    private readonly axisLines = ["#e85b57", "#55ba65", "#608be9"].map((color, i) => {
        const line = svg("path", { stroke: color, fill: "none", "data-axis": "XYZ"[i] });
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
        const orientation = svg("g", { "data-role": "orientation-object" });
        orientation.append(this.cube, this.axes, this.through);
        this.drawing.append(orientation);
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

    showSectionView(plane?: Plane): void {
        this.menu.section(plane);
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

    /** Turns the camera to `rotation` about its target — over a short tween, like Onshape's cube. */
    private setRotation(rotation: Quaternion) {
        const { camera, target } = this.cameraController;
        const distance = camera.position.distanceTo(target);
        const eye = new Vector3(0, 0, distance).applyQuaternion(rotation).add(target);
        const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
        const controller = this.cameraController;
        if (typeof controller.animateLookAt === "function") {
            void controller.animateLookAt(eye, target, up).then(() => {
                this.view.update();
                this.update();
            });
        } else controller.lookAt(eye, target, up);
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
        const screen = (p: Vector3) => ({ x: 75 + p.x * 28, y: 77 - p.y * 28 });
        const project = (point: Vector3) => screen(point.clone().applyQuaternion(inverse));
        const regions = this.regions
            .map((region) => ({ region, normal: region.normal.clone().applyQuaternion(inverse) }))
            .sort((a, b) => a.normal.z - b.normal.z);
        // Every region is drawn, far side first: the cube is translucent, so the back shows
        // through. Only the near side takes the pointer; the far faces are reached by name.
        const labelTransform = (region: (typeof this.regions)[number], mirrored: boolean) => {
            const right = region.up!.clone().cross(region.normal).applyQuaternion(inverse);
            if (mirrored) right.negate();
            const up = region.up!.clone().applyQuaternion(inverse);
            const center = project(region.normal);
            return `matrix(${right.x} ${-right.y} ${-up.x} ${up.y} ${center.x} ${center.y})`;
        };
        for (const { region, normal } of regions) {
            const visible = normal.z > 0.001;
            region.group.dataset["back"] = String(!visible);
            region.group.setAttribute("tabindex", visible ? "0" : "-1");
            region.group.setAttribute("aria-hidden", String(!visible));
            const points = region.vertices.map(project);
            region.polygon.setAttribute("points", points.map((p) => `${p.x},${p.y}`).join(" "));
            if (region.kind === "corner") {
                const disc = cornerDisc(region.normal);
                const center = project(disc.center);
                const { rx, ry, angle } = discEllipse(normal, disc.radius * 28);
                region.surface.setAttribute("cx", String(center.x));
                region.surface.setAttribute("cy", String(center.y));
                region.surface.setAttribute("rx", String(rx));
                region.surface.setAttribute("ry", String(ry));
                region.surface.setAttribute("transform", `rotate(${angle} ${center.x} ${center.y})`);
            } else {
                region.surface.setAttribute("d", roundedCubePatch(points, region.kind === "face" ? 6 : 2));
            }
            if (region.up) {
                region.label.style.display = visible ? "" : "none";
                if (visible) region.label.setAttribute("transform", labelTransform(region, false));
            }
            this.cube.append(region.group);
        }
        for (const { region, group } of this.throughLabels) {
            const back = region.normal.clone().applyQuaternion(inverse).z <= 0.001;
            group.style.display = back ? "" : "none";
            group.setAttribute("tabindex", back ? "0" : "-1");
            group.setAttribute("aria-hidden", String(!back));
            // seen from behind, the name would read mirrored: flip it back
            if (back) group.setAttribute("transform", labelTransform(region, true));
        }
        // The triad starts off the cube's negative XYZ corner, clear of its shell, and runs past
        // the cube so each axis shows as a free line with its name beyond the cube (Onshape's
        // triad). Both endpoints use the cube's projection, so the cube and axes orbit as one.
        const corner = new Vector3(-1.22, -1.22, -1.22);
        const start = corner.clone().applyQuaternion(inverse);
        const faces = regions
            .filter(({ normal }) => normal.z > 0.001)
            .map(({ region }) => region.vertices.map((v) => v.clone().applyQuaternion(inverse)));
        for (let i = 0; i < 3; i++) {
            const axis = new Vector3().setComponent(i, 1).applyQuaternion(inverse);
            const end = corner.clone().setComponent(i, 1.42).applyQuaternion(inverse);
            const { x, y } = screen(end);
            // an axis seen end-on is a dot at the origin, not a line: leave it out
            const endOn = Math.hypot(axis.x, axis.y) < 0.15;
            const segments = endOn ? [] : visibleCubeAxis(start, end, faces);
            const { line, label } = this.axisLines[i];
            // Draw only unoccluded segments above the cube; a foreground axis must never be
            // hidden merely because an SVG face was appended later in DOM order.
            line.setAttribute(
                "d",
                segments
                    .map(([a, b]) => {
                        const p = screen(a),
                            q = screen(b);
                        return `M${p.x},${p.y} L${q.x},${q.y}`;
                    })
                    .join(" "),
            );
            label.setAttribute("x", String(x + axis.x * 7 - 3));
            label.setAttribute("y", String(y - axis.y * 7 + 3));
            const endVisible = segments.some(([, b]) => b.distanceToSquared(end) < 1e-10);
            label.style.display = endOn || !endVisible ? "none" : "";
        }
    }
}

customElements.define("view-gizmo", ViewGizmo);
