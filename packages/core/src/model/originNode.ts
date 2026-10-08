// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "../i18n";
import { type BoundingBox, Matrix4, XYZ } from "../math";
import { serializable } from "../serialize";
import { ParameterShapeNode, type ParameterShapeNodeOptions } from "./shapeNode";

/** The document's fixed datum vertex, usable by picking and parametric references. */
@serializable()
export class OriginNode extends ParameterShapeNode {
    constructor(options: ParameterShapeNodeOptions) {
        super({ ...options, name: options.name ?? I18n.translate("body.origin") });
    }

    override display(): I18nKeys {
        return "body.origin";
    }

    override get icon(): string {
        return "icon-point";
    }

    get position(): XYZ {
        return XYZ.zero;
    }

    override get transform(): Matrix4 {
        return Matrix4.identity();
    }

    override set transform(_value: Matrix4) {
        // A datum origin stays at world zero, including after loading or a bulk transform.
    }

    override boundingBox(): BoundingBox {
        return { min: XYZ.zero, max: XYZ.zero };
    }

    protected override generateShape() {
        return this.document.application.shapeProvider.factory.point(this.position);
    }
}
