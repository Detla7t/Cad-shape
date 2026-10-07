// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    type I18nKeys,
    type IDocument,
    type IFace,
    type INode,
    type IVertex,
    ShapeNode,
    ShapeTypes,
    type VisualShapeData,
} from "@chili3d/core";
import { isBodyTrackingNode, ParametricBodyNode, SketchNode, sheetModelOf } from "@chili3d/parametric";
import type { GeometrySelection } from "../model/setup";
import type { Vec3 } from "../model/toolpath";

/**
 * Picking in the Part Studio's viewport for the CAM Studio: operation geometry (faces and
 * edges by tracked id on parametric bodies, so picks survive rebuilds; sketches; sheet
 * metal flat patterns; bodies), a planar face or a vertex for the WCS, parts. Each pick
 * runs the document's picker (status-bar prompt, OK/cancel control) and leaves the
 * selection empty; a cancelled pick resolves to undefined.
 */

export type PickKind = "face" | "edge" | "sketch" | "flatPattern" | "body";

const isBody = (node: INode) => node instanceof ShapeNode && !(node instanceof SketchNode);
const isSheetMetal = (node: INode) =>
    node instanceof ParametricBodyNode && node.shape.isOk && sheetModelOf(node.shape.value) !== undefined;

async function withController<T>(
    document: IDocument,
    pick: (controller: AsyncController) => Promise<T>,
): Promise<T | undefined> {
    const controller = new AsyncController();
    try {
        const value = await pick(controller);
        return controller.result?.status === "success" ? value : undefined;
    } finally {
        controller.dispose();
        document.selection.clearSelection();
    }
}

function subShapeSelection(kind: "face" | "edge", data: VisualShapeData): GeometrySelection | undefined {
    const node = data.owner.node;
    if (!(node instanceof ShapeNode)) return undefined;
    const index = data.indexes[0];
    const id = isBodyTrackingNode(node)
        ? kind === "face"
            ? node.faceIdAt(index)
            : node.edgeIdAt(index)
        : undefined;
    return { kind, nodeId: node.id, index, ...(id === undefined ? {} : { id }) };
}

const NODE_PROMPTS: Record<"sketch" | "flatPattern" | "body", I18nKeys> = {
    sketch: "prompt.select.sketch",
    flatPattern: "prompt.select.models",
    body: "prompt.select.models",
};

/** Picks operation geometry of one kind in the viewport. */
export async function pickGeometry(
    document: IDocument,
    kind: PickKind,
): Promise<GeometrySelection[] | undefined> {
    if (kind === "face" || kind === "edge") {
        return withController(document, async (controller) => {
            const picked = await document.picker.pickShape(
                kind === "face" ? "prompt.select.faces" : "prompt.select.edges",
                controller,
                {
                    shapeType: kind === "face" ? ShapeTypes.face : ShapeTypes.edge,
                    multi: true,
                    nodeFilter: { allow: isBody },
                },
            );
            return picked.flatMap((data) => subShapeSelection(kind, data) ?? []);
        });
    }
    const allow =
        kind === "sketch"
            ? (node: INode) => node instanceof SketchNode
            : kind === "flatPattern"
              ? isSheetMetal
              : isBody;
    return withController(document, async (controller) => {
        const nodes = await document.picker.pickNode(NODE_PROMPTS[kind], controller, {
            multi: true,
            nodeFilter: { allow },
        });
        return nodes.map((node): GeometrySelection => ({ kind, nodeId: node.id }));
    });
}

/** Picks bodies (the parts of a setup). */
export async function pickBodies(document: IDocument): Promise<string[] | undefined> {
    return withController(document, async (controller) => {
        const nodes = await document.picker.pickNode("prompt.select.models", controller, {
            multi: true,
            nodeFilter: { allow: isBody },
        });
        return nodes.map((node) => node.id);
    });
}

/** Picks a planar face: a point on it and its outward normal, in model coordinates. */
export async function pickPlanarFace(
    document: IDocument,
): Promise<{ origin: Vec3; normal: Vec3 } | undefined> {
    return withController(document, async (controller) => {
        const [data] = await document.picker.pickShape("prompt.select.faces", controller, {
            shapeType: ShapeTypes.face,
            multi: false,
            nodeFilter: { allow: isBody },
            shapeFilter: { allow: (shape) => (shape as IFace).surface().isPlanar() },
        });
        if (data === undefined) return undefined;
        const face = data.shape as unknown as IFace;
        const [point, normal] = face.normal(0, 0);
        const box = face.boundingBox();
        const centre = data.transform.ofPoint({
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2,
        });
        const p = data.transform.ofPoint(point);
        const n = data.transform.ofVector(normal).normalize() ?? normal;
        const d = (centre.x - p.x) * n.x + (centre.y - p.y) * n.y + (centre.z - p.z) * n.z;
        return {
            origin: [centre.x - d * n.x, centre.y - d * n.y, centre.z - d * n.z],
            normal: [n.x, n.y, n.z],
        };
    });
}

/** Picks a vertex, in model coordinates. */
export async function pickVertex(document: IDocument): Promise<Vec3 | undefined> {
    return withController(document, async (controller) => {
        const [data] = await document.picker.pickShape("prompt.select.vertexes", controller, {
            shapeType: ShapeTypes.vertex,
            multi: false,
        });
        if (data === undefined) return undefined;
        const point = data.transform.ofPoint((data.shape as unknown as IVertex).point());
        return [point.x, point.y, point.z];
    });
}
