// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, Plane } from "@chili3d/core";
import { type IFsModelingHost, type SketchLoopAnalysis, setFsModelingHost } from "@chili3d/featurescript";
import { completeEdgeHistory, completeFaceHistory } from "../features/historyCompletion";
import {
    groupConnected,
    hasBranchVertex,
    loopContains,
    needsKernelSplit,
    type Polygon,
    sampleLoop,
} from "../features/profileGeometry";
import { solveSketchConstraints } from "./sketchConstraints";

/**
 * Sketch loops by the profile builder's rules: crossings, collinear overlaps and branch
 * vertices need the kernel's splitter; otherwise the endpoint-connected groups, nested by
 * sampled-polygon containment (each group sampled once, on first use).
 */
export function analyzeSketchLoops(edges: IEdge[], plane: Plane): SketchLoopAnalysis | undefined {
    if (needsKernelSplit(edges)) return undefined;
    const groups = groupConnected(edges);
    if (groups.some(hasBranchVertex)) return undefined;
    const polygons = new Map<number, Polygon>();
    const polygon = (index: number): Polygon => {
        let sampled = polygons.get(index);
        if (sampled === undefined) {
            sampled = sampleLoop(groups[index], plane);
            polygons.set(index, sampled);
        }
        return sampled;
    };
    return { groups, contains: (outer, inner) => loopContains(polygon(outer), polygon(inner)) };
}

/**
 * The FeatureScript modeling context's CAD host: parametric's history completion (the
 * sub-shape identity layer), its sketch solver and its sketch-loop rules, so FeatureScript
 * and interactive features agree. Installed when this module loads.
 */
export const PARAMETRIC_MODELING_HOST: IFsModelingHost = {
    completeFaceHistory,
    completeEdgeHistory,
    analyzeSketchLoops,
    solveSketchConstraints,
};

setFsModelingHost(PARAMETRIC_MODELING_HOST);
