// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Id } from "../foundation";
import { I18n, type I18nKeys } from "../i18n";
import { BoundingBox, Plane } from "../math";
import { property } from "../property";
import { serializable, serialize } from "../serialize";
import { FolderNode } from "./folderNode";
import { NodeUtils } from "./node";
import { OriginNode } from "./originNode";
import { VisualNode } from "./visualNode";

export interface ReferencePlaneNodeOptions {
    document: IDocument;
    basePlane: Plane;
    offset?: number;
    size?: number;
    name?: string;
    id?: string;
}

/** A reference surface, never a part: its frame is persisted, editable and undoable. */
@serializable()
export class ReferencePlaneNode extends VisualNode {
    constructor(options: ReferencePlaneNodeOptions) {
        super(
            options.document,
            options.name ?? NodeUtils.generateName(options.document, I18n.translate("body.referencePlane")),
            options.id ?? Id.generate(),
        );
        this.setPrivateValue("basePlane", options.basePlane);
        this.setPrivateValue("offset", options.offset ?? 0);
        this.setPrivateValue("size", options.size ?? 200);
    }

    get icon(): string {
        return "icon-setWorkingPlane";
    }
    override display(): I18nKeys {
        return "body.referencePlane";
    }

    @serialize()
    get basePlane(): Plane {
        return this.getPrivateValue("basePlane");
    }
    set basePlane(value: Plane) {
        this.setProperty("basePlane", value);
    }

    @serialize()
    @property("plane.offset")
    get offset(): number {
        return this.getPrivateValue("offset", 0);
    }
    set offset(value: number) {
        if (Number.isFinite(value)) this.setProperty("offset", value);
    }

    @serialize()
    @property("plane.size")
    get size(): number {
        return this.getPrivateValue("size", 200);
    }
    set size(value: number) {
        if (Number.isFinite(value) && value > 0) this.setProperty("size", value);
    }

    get plane(): Plane {
        const base = this.basePlane;
        return base
            .translateTo(base.origin.add(base.normal.multiply(this.offset)))
            .transformed(this.transform);
    }

    /** Local-space corners. The visual and ray picker apply the node transform once. */
    corners() {
        const plane = this.basePlane;
        const origin = plane.origin.add(plane.normal.multiply(this.offset));
        const h = this.size / 2;
        return [
            [-h, -h],
            [h, -h],
            [h, h],
            [-h, h],
        ].map(([x, y]) => origin.add(plane.xvec.multiply(x)).add(plane.yvec.multiply(y)));
    }

    override boundingBox(): BoundingBox {
        return BoundingBox.fromNumbers(
            this.corners().flatMap((p) => {
                const world = this.transform.ofPoint(p);
                return [world.x, world.y, world.z];
            }),
        );
    }
}

/** Adds the datum origin and planes before a new document's initial version snapshot. */
export function addDefaultPlanes(document: IDocument): void {
    const folder = new FolderNode({ document, name: I18n.translate("plane.defaultGeometry") });
    folder.add(
        new OriginNode({ document }),
        ...(
            [
                ["plane.top", Plane.XY],
                ["plane.front", Plane.ZX],
                ["plane.right", Plane.YZ],
            ] as const
        ).map(
            ([key, basePlane]) =>
                new ReferencePlaneNode({
                    document,
                    basePlane,
                    name: I18n.translate(key),
                }),
        ),
    );
    document.modelManager.addNode(folder);
}
