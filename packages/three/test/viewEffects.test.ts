// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "@chili3d/core";
import { rs } from "@rstest/core";
import { BoxGeometry, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Scene } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type { ThreeView } from "../src/threeView";
import { ViewEffects } from "../src/viewEffects";

describe("viewport ambient occlusion", () => {
    const originalGraphics = Config.instance.graphics;
    let scene: Scene;
    let effects: ViewEffects;
    let view: {
        camera: OrthographicCamera | PerspectiveCamera;
        mode: ThreeView["mode"];
        displayOptions: ThreeView["displayOptions"];
    };
    let width: number;
    let height: number;

    function mesh(material = new MeshBasicMaterial()) {
        const object = new Mesh(new BoxGeometry(), material);
        scene.add(object);
        return object;
    }

    function pass(): SSAOPass {
        const ao = (effects as unknown as { ao?: SSAOPass }).ao;
        expect(ao).not.toBeUndefined();
        return ao!;
    }

    beforeEach(() => {
        Config.instance.graphics = { ...originalGraphics, ambientOcclusion: 37.5 };
        scene = new Scene();
        width = 1001;
        height = 721;
        view = {
            camera: new OrthographicCamera(-10, 10, 10, -10, 0.1, 1000),
            mode: "solidAndWireframe",
            displayOptions: {
                translucent: false,
                hiddenEdges: false,
                tangentEdges: "visible",
                boundaryEdges: false,
            },
        };
        effects = new ViewEffects({
            ...view,
            get camera() {
                return view.camera;
            },
            get mode() {
                return view.mode;
            },
            content: { scene },
            renderer: { getDrawingBufferSize: (target) => target.set(width, height) },
        } as ThreeView);
        rs.spyOn(SSAOPass.prototype, "render").mockImplementation(() => {});
    });

    afterEach(() => {
        effects.dispose();
        scene.traverse((object) => {
            if (object instanceof Mesh) {
                object.geometry.dispose();
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach((material) => material.dispose());
            }
        });
        rs.restoreAllMocks();
        Config.instance.graphics = originalGraphics;
    });

    test("an empty drawing with datum labels and thick lines allocates no AO targets", () => {
        mesh(new MeshBasicMaterial({ transparent: true, opacity: 1 }));
        mesh(new MeshBasicMaterial({ transparent: true, opacity: 0.12 }));
        const lines = new LineSegments2(
            new LineSegmentsGeometry().setPositions([0, 0, 0, 1, 1, 1]),
            new LineMaterial(),
        );
        scene.add(lines);
        effects.render();
        expect(SSAOPass.prototype.render).not.toHaveBeenCalled();
        expect((effects as unknown as { ao?: SSAOPass }).ao).toBeUndefined();
        expect(scene.children.every((object) => object.visible)).toBe(true);
    });

    test.each([
        "hidden",
        "other layer",
        "no depth",
        "empty range",
        "hidden material",
    ])("%s geometry cannot activate AO", (kind) => {
        const object = mesh();
        if (kind === "hidden") object.visible = false;
        if (kind === "other layer") object.layers.set(5);
        if (kind === "no depth") object.material.depthWrite = false;
        if (kind === "empty range") object.geometry.setDrawRange(0, 0);
        if (kind === "hidden material") object.material.visible = false;
        effects.render();
        expect(SSAOPass.prototype.render).not.toHaveBeenCalled();
    });

    test("solid models shade at half resolution without resizing unchanged targets", () => {
        mesh();
        effects.render();
        const ao = pass();
        expect([ao.normalRenderTarget.width, ao.normalRenderTarget.height]).toEqual([501, 361]);
        expect([ao.ssaoRenderTarget.width, ao.blurRenderTarget.height]).toEqual([501, 361]);
        expect(ao.renderToScreen).toBe(true);
        expect(ao.copyMaterial.uniforms["opacity"].value).toBe(0.375);
        const resize = rs.spyOn(ao, "setSize");
        effects.render();
        expect(resize).not.toHaveBeenCalled();
        width = 1280;
        height = 720;
        effects.render();
        expect(resize).toHaveBeenCalledExactlyOnceWith(640, 360);
        expect(SSAOPass.prototype.render).toHaveBeenCalledTimes(3);
    });

    test("zoom and camera switches refresh projection uniforms at a constant size", () => {
        mesh();
        effects.render();
        const ao = pass();
        const before = ao.ssaoMaterial.uniforms["cameraProjectionMatrix"].value.clone();
        view.camera.zoom = 2;
        view.camera.updateProjectionMatrix();
        effects.render();
        expect(ao.ssaoMaterial.uniforms["cameraProjectionMatrix"].value.equals(before)).toBe(false);
        expect(ao.ssaoMaterial.uniforms["cameraProjectionMatrix"].value).toEqual(
            view.camera.projectionMatrix,
        );
        view.camera = new PerspectiveCamera(50, 1.5, 0.5, 2000);
        effects.render();
        expect(ao.camera).toBe(view.camera);
        expect(ao.ssaoMaterial.defines["PERSPECTIVE_CAMERA"]).toBe(1);
        expect(ao.ssaoMaterial.uniforms["cameraNear"].value).toBe(0.5);
        expect(ao.ssaoMaterial.uniforms["cameraFar"].value).toBe(2000);
        expect(ao.ssaoMaterial.uniforms["cameraInverseProjectionMatrix"].value).toEqual(
            view.camera.projectionMatrixInverse,
        );
    });

    test("transparent overlays are excluded then restored even if a pass fails", () => {
        mesh();
        const overlay = mesh(new MeshBasicMaterial({ transparent: true }));
        const hidden = mesh();
        hidden.visible = false;
        let overlayVisibleDuringRender: boolean | undefined;
        rs.mocked(SSAOPass.prototype.render).mockImplementation(() => {
            overlayVisibleDuringRender = overlay.visible;
            throw new Error("GPU test failure");
        });
        expect(() => effects.render()).toThrow("GPU test failure");
        expect(overlayVisibleDuringRender).toBe(false);
        expect(overlay.visible).toBe(true);
        expect(hidden.visible).toBe(false);
    });

    test.each(["disabled", "wireframe", "translucent"])("%s skips all AO passes", (kind) => {
        mesh();
        if (kind === "disabled") Config.instance.graphics = { ...originalGraphics, ambientOcclusion: 0 };
        if (kind === "wireframe") view.mode = "wireframe";
        if (kind === "translucent") view.displayOptions.translucent = true;
        effects.render();
        expect(SSAOPass.prototype.render).not.toHaveBeenCalled();
    });
});
