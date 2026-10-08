// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { XYZLike } from "@chili3d/core";
import { PerspectiveCamera, Vector3 } from "three";
import type { ThreeView } from "../src/threeView";
import type { ViewGizmo } from "../src/viewGizmo";

let ViewGizmoCtor: typeof ViewGizmo;

beforeAll(async () => {
    // Importing the real module registers the "view-gizmo" custom element tag, but the test
    // stub (test/viewGizmo.ts, wired via the "./viewGizmo" alias used by threeView) may have
    // claimed that tag already, depending on test-file evaluation order. Skip duplicate
    // registrations so the import cannot throw in either order.
    const originalDefine = customElements.define.bind(customElements);
    customElements.define = (name, ctor, options) => {
        if (!customElements.get(name)) {
            originalDefine(name, ctor, options);
        }
    };
    try {
        ViewGizmoCtor = (await import("../src/viewGizmo")).ViewGizmo;
    } finally {
        customElements.define = originalDefine;
    }
    // Happy-DOM rejects `new` on unregistered custom element classes, so make sure the real
    // class is registered under some tag even when the stub owns "view-gizmo".
    if (customElements.get("view-gizmo") !== ViewGizmoCtor) {
        customElements.define("view-gizmo-real", ViewGizmoCtor);
    }
});

function createGizmo() {
    const camera = new PerspectiveCamera();
    const target = new Vector3(10, 20, 30);
    camera.position.copy(target).add(new Vector3(0, 0, 100));
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    const cc = {
        camera,
        target,
        rotate: rs.fn(),
        setRotateCenterToSelected: rs.fn(),
        lookAt: rs.fn((eye: XYZLike, center: XYZLike, up: XYZLike) => {
            camera.position.set(eye.x, eye.y, eye.z);
            camera.up.set(up.x, up.y, up.z);
            camera.lookAt(center.x, center.y, center.z);
        }),
    };
    const view = { cameraController: cc, update: rs.fn() } as unknown as ThreeView;
    const gizmo = new ViewGizmoCtor(view);
    document.body.append(gizmo);
    return { gizmo, cc };
}

function button(gizmo: ViewGizmo, label: string) {
    const node = gizmo.querySelector<SVGElement>(`[aria-label="${label}"]`);
    expect(node).not.toBeNull();
    return node!;
}

function click(gizmo: ViewGizmo, label: string, props: MouseEventInit = {}) {
    button(gizmo, label).dispatchEvent(new MouseEvent("click", { bubbles: true, ...props }));
}

afterEach(() => {
    document.body.replaceChildren();
});

describe("View cube", () => {
    test.each([
        ["Top", [0, 0, 1], [0, 1, 0]],
        ["Bottom", [0, 0, -1], [0, -1, 0]],
        ["Front", [0, -1, 0], [0, 0, 1]],
        ["Back", [0, 1, 0], [0, 0, 1]],
        ["Right", [1, 0, 0], [0, 0, 1]],
        ["Left", [-1, 0, 0], [0, 0, 1]],
    ])("%s face aligns the view without changing its center or zoom", (name, direction, up) => {
        const { gizmo, cc } = createGizmo();
        click(gizmo, `${name} view`);
        const expected = cc.target.clone().addScaledVector(new Vector3(...direction), 100);
        expect(cc.camera.position.distanceTo(expected)).toBeLessThan(1e-10);
        expect(cc.camera.up.distanceTo(new Vector3(...up))).toBeLessThan(1e-10);
        expect(cc.target.toArray()).toEqual([10, 20, 30]);
        expect(button(gizmo, `${name} view`).getAttribute("aria-hidden")).toBe("false");
    });

    test("has 26 named targets and corner/edge clicks choose the corresponding diagonals", () => {
        const { gizmo, cc } = createGizmo();
        expect(gizmo.querySelectorAll("[data-kind]").length).toBe(26);
        click(gizmo, "Top Front Right view");
        const direction = cc.camera.position.clone().sub(cc.target).normalize();
        expect(direction.distanceTo(new Vector3(1, -1, 1).normalize())).toBeLessThan(1e-10);
        click(gizmo, "Front Top view");
        expect(
            cc.camera.position
                .clone()
                .sub(cc.target)
                .normalize()
                .distanceTo(new Vector3(0, -1, 1).normalize()),
        ).toBeLessThan(1e-10);
        expect(cc.camera.position.distanceTo(cc.target)).toBeCloseTo(100);
    });

    test.each([
        [{}, 15],
        [{ shiftKey: true }, 90],
        [{ ctrlKey: true }, 5],
    ] as const)("step arrows honor modifier keys %j", (props, degrees) => {
        const { gizmo, cc } = createGizmo();
        const rotation = cc.camera.quaternion.clone();
        click(gizmo, "Rotate right (15°; Shift 90°; Ctrl 5°)", props);
        expect((rotation.angleTo(cc.camera.quaternion) * 180) / Math.PI).toBeCloseTo(degrees);
        expect(cc.camera.position.distanceTo(cc.target)).toBeCloseTo(100);
    });

    test("keyboard activation works and back faces are removed from tab order", () => {
        const { gizmo, cc } = createGizmo();
        expect(button(gizmo, "Bottom view").getAttribute("tabindex")).toBe("-1");
        button(gizmo, "Isometric view").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        expect(
            cc.camera.position
                .clone()
                .sub(cc.target)
                .normalize()
                .distanceTo(new Vector3(1, -1, 1).normalize()),
        ).toBeLessThan(1e-10);
        expect(button(gizmo, "Front view").getAttribute("tabindex")).toBe("0");
    });

    test.each([
        0, 2,
    ])("dragging button %s orbits without activating a face or reaching the sketch", (buttonIndex) => {
        const { gizmo, cc } = createGizmo();
        const parentDown = rs.fn();
        document.body.addEventListener("pointerdown", parentDown);
        try {
            const top = button(gizmo, "Top view");
            top.dispatchEvent(
                new PointerEvent("pointerdown", {
                    bubbles: true,
                    pointerId: 1,
                    button: buttonIndex,
                    clientX: 75,
                    clientY: 77,
                }),
            );
            top.dispatchEvent(
                new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 95, clientY: 82 }),
            );
            top.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
            top.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(cc.rotate).toHaveBeenCalledWith(20, 5, "trackball");
            expect(cc.lookAt).not.toHaveBeenCalled();
            expect(parentDown).not.toHaveBeenCalled();
        } finally {
            document.body.removeEventListener("pointerdown", parentDown);
        }
    });

    test("camera changes reproject the face polygons and dispose removes the control", () => {
        const { gizmo } = createGizmo();
        const top = button(gizmo, "Top view").querySelector("polygon")!;
        expect(top).not.toBeNull();
        const before = top.getAttribute("points");
        click(gizmo, "Isometric view");
        expect(top.getAttribute("points")).not.toBe(before);
        gizmo.dispose();
        expect(document.body.contains(gizmo)).toBe(false);
    });

    test("releasing outside before capture does not leave a pending cube drag", () => {
        const { gizmo, cc } = createGizmo();
        const top = button(gizmo, "Top view");
        top.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, button: 0 }));
        window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 300 }));
        top.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 20 }));
        expect(cc.rotate).not.toHaveBeenCalled();
    });
});
