// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type ShapeNode, ShapeTypes } from "@chili3d/core";
import { isBodyTrackingNode, ParametricBodyNode, SketchNode } from "@chili3d/parametric";
import type { MachineProfileData } from "../model/machine";
import type { CamLoop, CamOperationContext } from "../model/operation";
import type { CamOperationData, GeometrySelection } from "../model/setup";
import { flatPatternLoops, sketchLoops } from "./loopSources";
import { DEFAULT_LOOP_TOLERANCE } from "./loops";
import { findShapeNode, type SetupGeometry, shapeInputError } from "./setupGeometry";
import { operationTool } from "./tools";

/**
 * One operation's `CamOperationContext` over its setup's shared geometry. Picks resolve
 * lazily, when the handler asks: a face or edge pick by its tracked id on a parametric
 * body (every piece of a split face), else by its index, on the node's shape moved into
 * WCS; a sketch or flat pattern into WCS loops. A pick whose node is gone throws — the
 * generator reports it as the operation's error.
 */

type SubShapeKind = "face" | "edge";

function subShapeIndexes(
    node: ShapeNode,
    pick: Extract<GeometrySelection, { kind: "face" | "edge" }>,
): number[] {
    if (pick.id !== undefined) {
        // A lost tracked reference must not silently select a different face/edge
        // that happens to occupy the old index after a topology change.
        if (!isBodyTrackingNode(node)) return [];
        return pick.kind === "face" ? node.faceIndexesOfId(pick.id) : node.edgeIndexesOfId(pick.id);
    }
    return pick.index === undefined ? [] : [pick.index];
}

export function resolveSubShapes(
    geometry: SetupGeometry,
    selection: readonly GeometrySelection[] | undefined,
    kind: SubShapeKind,
): IShape[] {
    const type = kind === "face" ? ShapeTypes.face : ShapeTypes.edge;
    const result: IShape[] = [];
    for (const pick of selection ?? []) {
        if (pick.kind !== kind && pick.kind !== "body") continue;
        const node = findShapeNode(geometry.document, pick.nodeId);
        if (node === undefined) throw new Error(`The picked ${kind}'s part is no longer in the document`);
        const shape = geometry.shapeInWcs(node);
        if (shape === undefined) throw new Error(`"${node.name}" has no valid shape`);
        const subShapes = shape.findSubShapes(type);
        if (pick.kind === "body") {
            result.push(...subShapes.map((sub) => geometry.own(sub)));
            continue;
        }
        const indexes = subShapeIndexes(node, pick);
        if (indexes.length === 0 || indexes.some((index) => subShapes[index] === undefined)) {
            for (const sub of subShapes) sub.dispose();
            throw new Error(`A picked ${kind} of "${node.name}" no longer exists — pick it again`);
        }
        for (const index of indexes) result.push(subShapes[index]);
        subShapes.forEach((sub, index) => {
            if (indexes.includes(index)) geometry.own(sub);
            else sub.dispose();
        });
    }
    return result;
}

export function resolveLoops(
    geometry: SetupGeometry,
    selection: readonly GeometrySelection[] | undefined,
    tolerance = DEFAULT_LOOP_TOLERANCE,
): CamLoop[] {
    const loops: CamLoop[] = [];
    for (const pick of selection ?? []) {
        if (pick.kind !== "sketch" && pick.kind !== "flatPattern") continue;
        const [node] = geometry.document.modelManager.findNodes((candidate) => candidate.id === pick.nodeId);
        if (pick.kind === "sketch") {
            if (!(node instanceof SketchNode))
                throw new Error("The picked sketch is no longer in the document");
            const error = shapeInputError(node);
            if (error !== undefined) throw new Error(error);
            loops.push(...sketchLoops(node, geometry.modelToWcs, tolerance));
            continue;
        }
        if (!(node instanceof ParametricBodyNode))
            throw new Error("The picked sheet metal part is no longer in the document");
        const error = shapeInputError(node);
        if (error !== undefined) throw new Error(error);
        const flat = flatPatternLoops(node, geometry.modelToWcs, tolerance);
        if (!flat.isOk) throw new Error(flat.error);
        loops.push(...flat.value);
    }
    return loops;
}

/** The nodes an operation's picks read, for change tracking. */
export function selectionNodeIds(selection: readonly GeometrySelection[] | undefined): string[] {
    return [...new Set((selection ?? []).map((pick) => pick.nodeId))];
}

export function createOperationContext(
    geometry: SetupGeometry,
    machine: MachineProfileData,
    operation: CamOperationData,
    tolerance = DEFAULT_LOOP_TOLERANCE,
    signal?: AbortSignal,
): CamOperationContext {
    let faces: IFace[] | undefined;
    let edges: IEdge[] | undefined;
    let loops: CamLoop[] | undefined;
    const setup = geometry.setup;
    return {
        document: geometry.document,
        signal,
        setup,
        machine,
        tool: operationTool(setup, machine, operation),
        parts: geometry.parts,
        stock: geometry.stock,
        partMesh: (linearDeflection) => geometry.partMesh(linearDeflection),
        selectedFaces: () => {
            faces ??= resolveSubShapes(geometry, operation.selection, "face") as IFace[];
            return faces;
        },
        selectedEdges: () => {
            edges ??= resolveSubShapes(geometry, operation.selection, "edge") as IEdge[];
            return edges;
        },
        selectedLoops: () => {
            loops ??= resolveLoops(geometry, operation.selection, tolerance);
            return loops;
        },
    };
}
