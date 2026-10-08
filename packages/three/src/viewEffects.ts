// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "@chili3d/core";
import { Mesh, type Object3D, Vector2 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type { ThreeView } from "./threeView";

/** Multiplies only the occlusion contribution over the existing antialiased frame. */
export class ViewEffects {
    private ao?: SSAOPass;
    constructor(private readonly view: ThreeView) {}
    render() {
        const view = this.view,
            strength = Config.instance.graphics.ambientOcclusion / 100;
        if (strength <= 0 || view.mode === "wireframe" || view.displayOptions.translucent) return;
        const scene = view.content.scene;
        if (!this.ao) {
            this.ao = new SSAOPass(scene, view.camera, 1, 1, 16);
            this.ao.renderToScreen = true;
            this.ao.copyMaterial.fragmentShader = this.ao.copyMaterial.fragmentShader.replace(
                "gl_FragColor = opacity * texel;",
                "gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, opacity), 1.0);",
            );
        }
        const ao = this.ao;
        ao.camera = view.camera;
        const size = view.renderer.getDrawingBufferSize(new Vector2());
        ao.setSize(size.x, size.y);
        ao.ssaoMaterial.uniforms["cameraNear"].value = view.camera.near;
        ao.ssaoMaterial.uniforms["cameraFar"].value = view.camera.far;
        const perspective = view.camera.type === "PerspectiveCamera" ? 1 : 0;
        if (ao.ssaoMaterial.defines["PERSPECTIVE_CAMERA"] !== perspective) {
            ao.ssaoMaterial.defines["PERSPECTIVE_CAMERA"] = perspective;
            ao.ssaoMaterial.needsUpdate = true;
        }
        ao.copyMaterial.uniforms["opacity"].value = strength;
        const hidden: Object3D[] = [];
        scene.traverse((object) => {
            // Reference planes, sketch fills, points and fat lines are not occluding bodies.
            if (
                object.visible &&
                (object instanceof LineSegments2 ||
                    (object instanceof Mesh &&
                        !Array.isArray(object.material) &&
                        object.material.opacity < 1))
            ) {
                hidden.push(object);
                object.visible = false;
            }
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
