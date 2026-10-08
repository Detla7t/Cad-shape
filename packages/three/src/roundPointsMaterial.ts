// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PointsMaterial } from "three";

/** Screen-sized circular handles, including selected/highlighted and cloned materials. */
export class RoundPointsMaterial extends PointsMaterial {
    override onBeforeCompile(shader: Parameters<PointsMaterial["onBeforeCompile"]>[0]): void {
        shader.fragmentShader = shader.fragmentShader.replace(
            "#include <clipping_planes_fragment>",
            "#include <clipping_planes_fragment>\nif (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;",
        );
    }
    override customProgramCacheKey(): string {
        return "round-cad-point";
    }
}
