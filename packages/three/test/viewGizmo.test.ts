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
        cameraType: "perspective",
        hasPreviousView: false,
        rememberView: rs.fn(),
        fitContent: rs.fn(),
        setRotateCenterToSelected: rs.fn(),
        lookAt: rs.fn((eye: XYZLike, center: XYZLike, up: XYZLike) => {
            camera.position.set(eye.x, eye.y, eye.z);
            camera.up.set(up.x, up.y, up.z);
            camera.lookAt(center.x, center.y, center.z);
        }),
    };
    const view = {
        cameraController: cc,
        update: rs.fn(),
        mode: "solidAndWireframe",
        displayOptions: { hiddenEdges: false, tangentEdges: "visible", boundaryEdges: false },
        renderer: { getPixelRatio: () => 2 },
    } as unknown as ThreeView;
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
        button(gizmo, "View options").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        const menuItem = document.querySelector<HTMLButtonElement>('[role="menu"] [aria-label="Isometric"]');
        expect(menuItem).not.toBeNull();
        menuItem!.click();
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

    test("only the near faces carry their names; the far side shows through unlabelled; corners are flat discs", () => {
        const { gizmo } = createGizmo();
        // the camera looks down -Z: Top faces it, Bottom is on the far side
        expect(gizmo.querySelector('[data-role="through-labels"]')).toBeNull();
        expect(button(gizmo, "Bottom view").dataset["back"]).toBe("true");
        expect(button(gizmo, "Top view").dataset["back"]).toBe("false");
        const label = (name: string) => button(gizmo, `${name} view`).querySelector("text") as SVGTextElement;
        expect(label("Top").style.display).toBe("");
        expect(label("Top").textContent).toBe("Top");
        for (const name of ["Bottom", "Left", "Back", "Front", "Right"])
            expect(label(name).style.display).toBe("none");
        // every region stays drawn (the cube is translucent); the far ones — the bottom and the
        // four side faces seen edge-on, their edges and corners — take no pointer
        expect(gizmo.querySelectorAll('[data-kind][data-back="true"]').length).toBe(17);
        // a corner is a disc tilted with the cube: looking down Z it is foreshortened, not round
        const corners = gizmo.querySelectorAll<SVGEllipseElement>('[data-kind="corner"] ellipse');
        expect(corners.length).toBe(8);
        const rx = Number(corners[0].getAttribute("rx"));
        const ry = Number(corners[0].getAttribute("ry"));
        expect(rx).toBeGreaterThan(0);
        expect(rx / ry).toBeCloseTo(1 / Math.sqrt(3), 6);
        // Z points at the viewer: no stub of a line and no label at the origin
        const z = gizmo.querySelector<SVGPathElement>('[data-axis="Z"]')!;
        expect(z).not.toBeNull();
        expect(z.getAttribute("d")).toBe("");
        expect(gizmo.querySelector<SVGPathElement>('[data-axis="X"]')!.getAttribute("d")).not.toBe("");
        // turned to the front, the names follow the visible faces
        click(gizmo, "Front view");
        expect(label("Front").style.display).toBe("");
        expect(label("Back").style.display).toBe("none");
        expect(label("Top").style.display).toBe("none");
    });

    test("a near corner takes the pointer through a wider circle over the cube; it lights the corner and turns to it", () => {
        const { gizmo, cc } = createGizmo();
        const circles = gizmo.querySelectorAll<SVGCircleElement>("[data-corner-hit]");
        expect(circles.length).toBe(8);
        // looking down -Z: the four top corners are near, the four bottom ones are not
        const shown = [...circles]
            .filter((c) => c.style.display !== "none")
            .map((c) => c.dataset["cornerHit"]);
        expect(shown).toHaveLength(4);
        expect(shown.every((name) => name!.startsWith("Top"))).toBe(true);
        expect([...circles].every((c) => c.getAttribute("r") === "8")).toBe(true);
        const hit = gizmo.querySelector<SVGCircleElement>('[data-corner-hit="Top Front Right view"]')!;
        const corner = button(gizmo, "Top Front Right view");
        expect(Number(hit.getAttribute("cx"))).toBeCloseTo(
            Number(corner.querySelector("ellipse")!.getAttribute("cx")),
            6,
        );
        hit.dispatchEvent(new PointerEvent("pointerenter"));
        expect(corner.dataset["hover"]).toBe("true");
        hit.dispatchEvent(new PointerEvent("pointerleave"));
        expect(corner.dataset["hover"]).toBeUndefined();
        hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const direction = cc.camera.position.clone().sub(cc.target).normalize();
        const expected = new Vector3(1, -1, 1).normalize();
        expect(direction.distanceTo(expected)).toBeLessThan(1e-6);
    });

    test("the face the camera looks at squarely is marked as facing; an oblique view marks the squarest", () => {
        const { gizmo } = createGizmo();
        // looking down -Z: Top faces the camera, no other region does
        expect(button(gizmo, "Top view").dataset["facing"]).toBe("true");
        expect(gizmo.querySelectorAll('[data-facing="true"]').length).toBe(1);
        expect(button(gizmo, "Front view").dataset["facing"]).toBeUndefined();
        click(gizmo, "Front view");
        expect(button(gizmo, "Front view").dataset["facing"]).toBe("true");
        expect(button(gizmo, "Top view").dataset["facing"]).toBeUndefined();
        // from the Top Front Right corner the three faces tie; exactly one is white, and it is a face
        click(gizmo, "Top Front Right view");
        const facing = gizmo.querySelectorAll('[data-facing="true"]');
        expect(facing.length).toBe(1);
        expect(facing[0].getAttribute("data-kind")).toBe("face");
        expect(facing[0].getAttribute("data-back")).toBe("false");
    });

    test("camera changes reproject the face polygons and dispose removes the control", () => {
        const { gizmo } = createGizmo();
        const top = button(gizmo, "Top view").querySelector("polygon")!;
        expect(top).not.toBeNull();
        const before = top.getAttribute("points");
        click(gizmo, "Top Front Right view");
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
