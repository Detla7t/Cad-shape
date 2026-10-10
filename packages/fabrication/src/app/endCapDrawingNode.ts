// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, serializable, serialize } from "@chili3d/core";
import { DocumentFileNode, type DocumentFileNodeOptions } from "@chili3d/documents";
import { writeDxf } from "@chili3d/drawing";
import { ensureVariableSync, type SketchData, SketchNode } from "@chili3d/parametric";
import { endCapName } from "../endcap/endCap";
import { toDrawing } from "../geometry/toDrawing";
import { arc, type FlatPattern, line, type Segment } from "../geometry/types";
import { configuredEndCapValues, resolveEndCapValues } from "./endCapConfiguration";

export interface EndCapDrawingNodeOptions extends Omit<DocumentFileNodeOptions, "fileName"> {
    fileName?: string;
    /** The sketches drawn, in order; the first one not suppressed is the drawing. */
    sketchIds?: string;
}

const MM_PER_INCH = 25.4;
const DEG = 180 / Math.PI;

/** A sketch's geometry as a flat pattern in inches: cut edges, and construction arcs as bend lines. */
export function sketchFlatPattern(data: SketchData, name: string): FlatPattern {
    const outline: Segment[] = [];
    const bendLines: Segment[] = [];
    for (const entity of data.entities) {
        const v = entity.params.map((value) => value / MM_PER_INCH);
        let segment: Segment;
        if (entity.type === "line") segment = line([v[0], v[1]], [v[2], v[3]]);
        else if (entity.type === "arc") {
            const [cx, cy, sx, sy, ex, ey] = v;
            segment = arc(
                [cx, cy],
                Math.hypot(sx - cx, sy - cy),
                Math.atan2(sy - cy, sx - cx) * DEG,
                Math.atan2(ey - cy, ex - cx) * DEG,
            );
        } else continue;
        (entity.construction ? bendLines : outline).push(segment);
    }
    return { name, units: "inch", parts: [{ name, outline, bendLines }] };
}

/**
 * The End Cap's shop drawing: a DXF element drawn from whichever end cap sketch the
 * configuration shows ("End Cap" or "Reducing End Cap"), redrawn after every configuration
 * switch once the sketches have re-solved. Named the way Onshape names its exports.
 */
@serializable({ id: "EndCapDrawingNode" })
export class EndCapDrawingNode extends DocumentFileNode {
    /** `IVariableConsumer`: after the sketches (0), bodies (1) and variable features (2). */
    readonly variableSyncOrder = 3;

    @serialize()
    get sketchIds(): string {
        return this.getPrivateValue("sketchIds", "[]");
    }
    set sketchIds(value: string) {
        this.setProperty("sketchIds", value);
    }

    constructor(options: EndCapDrawingNodeOptions) {
        super({ ...options, fileName: options.fileName ?? "End Cap.dxf", format: options.format ?? "dxf" });
        this.setPrivateValue("sketchIds", options.sketchIds ?? "[]");
        ensureVariableSync(options.document);
    }

    static create(document: IDocument, sketches: readonly SketchNode[]): EndCapDrawingNode {
        const node = new EndCapDrawingNode({
            document,
            name: "End Cap Drawing",
            text: "",
            sketchIds: JSON.stringify(sketches.map((sketch) => sketch.id)),
        });
        node.redraw();
        return node;
    }

    applyVariables(): void {
        this.redraw();
    }

    /** The sketch the drawing shows now. */
    activeSketch(): SketchNode | undefined {
        const ids: string[] = JSON.parse(this.sketchIds);
        for (const id of ids) {
            const node = this.document.modelManager.findNode((candidate) => candidate.id === id);
            if (node instanceof SketchNode && !node.suppressed) return node;
        }
        return undefined;
    }

    /** Rewrites the file from the active sketch; derived state, outside the undo history. */
    redraw(): void {
        const sketch = this.activeSketch();
        if (sketch === undefined) return;
        const params = resolveEndCapValues(
            configuredEndCapValues(),
            this.document.variables.evaluate().scope,
        );
        const name = params.isOk ? endCapName(params.value) : sketch.name;
        const text = writeDxf(toDrawing(sketchFlatPattern(sketch.data, name)));
        const fileName = `${name}.dxf`;
        if (text === this.content && fileName === this.fileName) return;
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            this.fileName = fileName;
            this.content = text;
        } finally {
            history.disabled = disabled;
        }
    }
}
