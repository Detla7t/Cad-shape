// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, Plane } from "@chili3d/core";
import { fail } from "../lang/values";
import type { FsSketch } from "./sketch";

/**
 * Edge groups of a sketch that connect end to end without crossings or T-junctions, as
 * the CAD around the engine decides them — so FeatureScript sketch regions match the
 * interactive sketch's.
 */
export interface SketchLoopAnalysis {
    /** The edges grouped by endpoint connectivity (open groups included). */
    readonly groups: readonly IEdge[][];
    /** Whether group `inner` lies inside group `outer` (meaningful for closed groups only). */
    contains(outer: number, inner: number): boolean;
}

/**
 * What the modeling context needs from the CAD application around it. The engine has no
 * sub-shape identity layer, constraint solver or sketch-profile rules of its own: those
 * belong to the parametric module, which installs itself here when it loads
 * (`@chili3d/parametric`'s `featurescript/modelingHost.ts`), so FeatureScript features and
 * interactive features agree on all three.
 *
 * Without an installed host (engine-only use, `modelingHost.kernel.test.ts`) the context
 * keeps the history the kernel reports, builds sketch regions with the kernel's splitter
 * only (every region at depth 0; a lone closed curve such as a circle yields none) and
 * rejects sketch constraints — Onshape's std sketches need the parametric host.
 */
export interface IFsModelingHost {
    /**
     * Completes a kernel face history: `map[i]` is the input index output face `i` derives
     * from, or -1. Returns the map with outputs the kernel failed to report matched to
     * geometrically identical inputs.
     */
    completeFaceHistory(
        inputs: readonly IFace[],
        outputs: readonly IFace[],
        map: readonly number[],
    ): number[];
    /** `completeFaceHistory` for edges. */
    completeEdgeHistory(
        inputs: readonly IEdge[],
        outputs: readonly IEdge[],
        map: readonly number[],
    ): number[];
    /**
     * The simple loops of a sketch's drawn `edges` on `plane`, or `undefined` when they cross,
     * overlap or branch and need the kernel's splitter.
     */
    analyzeSketchLoops(edges: IEdge[], plane: Plane): SketchLoopAnalysis | undefined;
    /** Solves the sketch's `skConstraint`s and initial guesses, replacing its entities' edges. */
    solveSketchConstraints(sketch: FsSketch): void;
}

/** The engine-only host: kernel-reported history, kernel-split regions, no constraint solver. */
export const KERNEL_ONLY_HOST: IFsModelingHost = {
    completeFaceHistory: (_inputs, _outputs, map) => [...map],
    completeEdgeHistory: (_inputs, _outputs, map) => [...map],
    analyzeSketchLoops: () => undefined,
    solveSketchConstraints(sketch) {
        if (sketch.constraints.length > 0 || sketch.initialGuesses.size > 0)
            fail("Sketch constraints need the parametric module's sketch solver, which is not loaded");
    },
};

let host: IFsModelingHost = KERNEL_ONLY_HOST;

/** Installs the CAD host the modeling context delegates to; `undefined` restores the engine-only host. */
export function setFsModelingHost(next: IFsModelingHost | undefined): void {
    host = next ?? KERNEL_ONLY_HOST;
}

/** The installed modeling host. */
export function fsModelingHost(): IFsModelingHost {
    return host;
}
