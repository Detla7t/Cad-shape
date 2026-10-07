// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { PartLinkData } from "../link/linkTypes";
import type { Vec3 } from "../math/rigid";
import type { MateType } from "../solver/mateSolver";

/**
 * The data an assembly stores — instances and mates, as plain JSON (one object per instance
 * and per mate, so the version history diffs and merges them item by item).
 */

/** What an instance places: a part of this document, another assembly of it, or a linked node. */
export type InstanceSourceData =
    | { readonly kind: "part"; readonly nodeId: string }
    | { readonly kind: "assembly"; readonly nodeId: string }
    | { readonly kind: "link"; readonly link: PartLinkData };

export interface AssemblyInstanceData {
    readonly id: string;
    readonly name: string;
    readonly source: InstanceSourceData;
    /** Placement of the source in the assembly, column-major 4×4 (`Matrix4` layout). */
    readonly transform: readonly number[];
    /** Fixed in place: the solver never moves it (Onshape's "Fix"). */
    readonly grounded?: boolean;
    readonly suppressed?: boolean;
    readonly hidden?: boolean;
}

/** What a mate connector was inferred from — kept to re-anchor it when the part changes. */
export interface ConnectorEntityData {
    readonly kind: "face" | "edge" | "vertex";
    /** Sub-shape index in its part's shape. */
    readonly index: number;
    /** The part's stable id of that sub-shape, when it tracks ids. */
    readonly id?: string;
    /** For a connector on a part inside a sub-assembly instance: that part's index in the instance. */
    readonly part?: number;
    readonly inference: ConnectorInference;
    /** Which of the entity's candidate origins the connector sits at. */
    readonly anchor?: ConnectorAnchor;
}

/**
 * A candidate origin on a picked entity: its centroid, or a vertex, a straight edge's midpoint
 * or a circular edge's center — `index` among the solid's vertices / edges (none: the entity itself).
 */
export interface ConnectorAnchor {
    readonly kind: "centroid" | "vertex" | "edgeMid" | "circleCenter";
    readonly index?: number;
}

export type ConnectorInference =
    | "planarFace"
    | "cylindricalFace"
    | "sphericalFace"
    | "conicalFace"
    | "face"
    | "circularEdge"
    | "linearEdge"
    | "edge"
    | "vertex"
    | "origin";

/** A mate connector: a frame fixed on an instance, in the instance's own coordinates. */
export interface MateConnectorData {
    readonly instanceId: string;
    readonly origin: Vec3;
    readonly zAxis: Vec3;
    readonly xAxis: Vec3;
    readonly entity?: ConnectorEntityData;
}

export interface MateData {
    readonly id: string;
    readonly name: string;
    readonly type: MateType;
    readonly a: MateConnectorData;
    readonly b: MateConnectorData;
    /** Align the connectors' Z axes instead of opposing them. */
    readonly flipped?: boolean;
    /** Offset of B from A: mm in A's frame, `angle` in degrees about A's Z. */
    readonly offset?: {
        readonly x?: number;
        readonly y?: number;
        readonly z?: number;
        readonly angle?: number;
    };
    /** Revolute: degrees; slider / cylindrical: mm. */
    readonly limits?: { readonly min?: number; readonly max?: number };
    readonly suppressed?: boolean;
}

export const IDENTITY_TRANSFORM: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
