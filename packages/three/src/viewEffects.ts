// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "@chili3d/core";
import { Mesh, type Object3D, Vector2 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type { ThreeView } from "./threeView";

/** Occlusion samples per pixel: enough for a smooth, grain-free shade on the settled frame. */
const AO_KERNEL_SIZE = 32;

/**
 * Multiplies only the occlusion contribution over the existing antialiased frame.
 *
 * Quality follows the frame: a settled frame shades at the full drawing-buffer
 * resolution (the grain of a half-size occlusion map upscaled over crisp MSAA edges is
 * what reads as a "noisy" viewport); frames drawn while the camera is still moving use
 * the half-resolution map, a quarter of the pixel work, and the view redraws once more
 * at full quality when the motion settles.
 */
export class ViewEffects {
    private ao?: SSAOPass;
    private readonly bufferSize = new Vector2();
    constructor(private readonly view: ThreeView) {}
    render(quality: "interactive" | "final" = "final") {
        const view = this.view,
            strength = Config.instance.graphics.ambientOcclusion / 100;
        if (strength <= 0 || view.mode === "wireframe" || view.displayOptions.translucent) return;
        const scene = view.content.scene;
        const hidden: Object3D[] = [];
        let hasOccluder = false;
        scene.traverseVisible((object) => {
            if (!(object instanceof Mesh)) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            // Datum labels have opacity 1 but transparent textures; lines, labels, sketch fills
            // and selection overlays must not make an empty drawing run four extra GPU passes.
            if (
                object instanceof LineSegments2 ||
                !materials.every((m) => m.visible && !m.transparent && m.opacity >= 1 && m.depthWrite)
            ) {
                hidden.push(object);
            } else if (
                object.layers.test(view.camera.layers) &&
                object.geometry.getAttribute("position")?.count > 0 &&
                object.geometry.drawRange.count > 0
            ) {
                hasOccluder = true;
            }
        });
        if (!hasOccluder) return;
        if (!this.ao) {
            this.ao = new SSAOPass(scene, view.camera, 1, 1, AO_KERNEL_SIZE);
            this.ao.renderToScreen = true;
            this.ao.copyMaterial.fragmentShader = this.ao.copyMaterial.fragmentShader.replace(
                "gl_FragColor = opacity * texel;",
                "gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, opacity), 1.0);",
            );
        }
        const ao = this.ao;
        ao.camera = view.camera;
        const size = view.renderer.getDrawingBufferSize(this.bufferSize);
        // While the camera moves, half-resolution targets cut the pixel work by 75%; the
        // model's MSAA render and line/text detail keep the full display resolution either way.
        const scale = quality === "interactive" ? 2 : 1;
        const width = Math.max(1, Math.ceil(size.x / scale));
        const height = Math.max(1, Math.ceil(size.y / scale));
        if (ao.width !== width || ao.height !== height) ao.setSize(width, height);
        // Projection changes on zoom or a camera switch even when target sizes stay constant.
        ao.ssaoMaterial.uniforms["cameraProjectionMatrix"].value.copy(view.camera.projectionMatrix);
        ao.ssaoMaterial.uniforms["cameraInverseProjectionMatrix"].value.copy(
            view.camera.projectionMatrixInverse,
        );
        ao.ssaoMaterial.uniforms["cameraNear"].value = view.camera.near;
        ao.ssaoMaterial.uniforms["cameraFar"].value = view.camera.far;
        const perspective = view.camera.type === "PerspectiveCamera" ? 1 : 0;
        if (ao.ssaoMaterial.defines["PERSPECTIVE_CAMERA"] !== perspective) {
            ao.ssaoMaterial.defines["PERSPECTIVE_CAMERA"] = perspective;
            ao.ssaoMaterial.needsUpdate = true;
        }
        ao.copyMaterial.uniforms["opacity"].value = strength;
        hidden.forEach((object) => {
            object.visible = false;
        });
        try {
            ao.render(view.renderer, ao.ssaoRenderTarget, ao.blurRenderTarget, 0, false);
        } finally {
            hidden.forEach((object) => {
                object.visible = true;
            });
        }
    }
    dispose() {
        this.ao?.dispose();
        // SSAOPass currently leaves these two owned resources out of its disposal routine.
        this.ao?.ssaoMaterial.dispose();
        this.ao?.noiseTexture?.dispose();
    }
}
