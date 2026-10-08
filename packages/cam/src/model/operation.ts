// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, IEdge, IFace, IShape, Result } from "@chili3d/core";
import type { MachineKind, MachineProfileData } from "./machine";
import type { CamOperationData, SetupData } from "./setup";
import type { ToolData } from "./tool";
import type { ToolpathData, Vec3 } from "./toolpath";

/**
 * Operation types are registered like parametric features: a handler per `type`, found by
 * the CAM Studio when it generates a setup. Each handler declares the machines it runs on and
 * the parameters it shows, and turns one operation into one toolpath.
 */

export type CamCategory = "2d" | "3d" | "5axis" | "cutting" | "wire" | "additive";

/** One parameter row of an operation's panel. Lengths in mm, angles in degrees. */
export interface CamParameterSpec {
    readonly key: string;
    /** English label (shown as is until the CAM keys are translated). */
    readonly label: string;
    readonly kind: "length" | "angle" | "number" | "integer" | "boolean" | "enum" | "string";
    readonly options?: readonly { readonly value: string; readonly label: string }[];
    readonly min?: number;
    readonly max?: number;
    /** Shown only when another parameter has one of these values. */
    readonly visibleWhen?: { readonly key: string; readonly values: readonly unknown[] };
    readonly description?: string;
}

/** Triangles of the parts in WCS (for 3D and 5-axis strategies). */
export interface CamMesh {
    /** xyz triples. */
    readonly positions: Float32Array;
    /** Vertex indices, three per triangle. */
    readonly indices: Uint32Array;
}

/** 2D loops in the setup's XY plane (WCS), outer loops counter-clockwise, holes clockwise. */
export interface CamLoop {
    readonly points: readonly (readonly [number, number])[];
    /** True for a closed loop (contours); false for an open chain (engraving, a bend mark). */
    readonly closed: boolean;
    /** The loop's role from its source: a flat pattern's outline/hole/bend line, or a sketch loop. */
    readonly role?: "outline" | "hole" | "bend" | "mark" | "sketch";
    /** Z of the plane the loop lies in (WCS). */
    readonly z?: number;
}

/** Everything an operation needs to generate, resolved in the setup's WCS. */
export interface CamOperationContext {
    readonly document: IDocument;
    /** Aborted when a job is cancelled, superseded, invalidated, or its studio is disposed. */
    readonly signal?: AbortSignal;
    readonly setup: SetupData;
    readonly machine: MachineProfileData;
    /** The operation's tool (the operation's `toolId`, else the machine's first suitable tool). */
    readonly tool: ToolData;
    /** The setup's parts, transformed into WCS. */
    readonly parts: readonly IShape[];
    /** The stock's bounding box in WCS. */
    readonly stock: { readonly min: Vec3; readonly max: Vec3 };
    /** Machining triangulation in WCS, cached by absolute deflection in mm (default 0.01). */
    partMesh(linearDeflection?: number): CamMesh;
    /** The operation's picked faces / edges, in WCS. */
    selectedFaces(): IFace[];
    selectedEdges(): IEdge[];
    /** The operation's picked sketches and flat patterns as 2D loops (z = 0 is the WCS plane). */
    selectedLoops(): CamLoop[];
}

export interface CamOperationHandler {
    readonly type: string;
    readonly label: string;
    readonly category: CamCategory;
    /** The machines this operation programs. */
    readonly machineKinds: readonly MachineKind[];
    /** What the operation picks, for the panel's selection row. */
    readonly selects?: readonly ("face" | "edge" | "sketch" | "flatPattern" | "body")[];
    /** Parameter values a new operation starts with. */
    defaults(machine: MachineProfileData, tool?: ToolData): Record<string, unknown>;
    parameters(operation: CamOperationData): readonly CamParameterSpec[];
    /** One toolpath; may be async (a slicer running elsewhere). Errors are results, not throws. */
    generate(
        operation: CamOperationData,
        context: CamOperationContext,
    ): Result<ToolpathData> | Promise<Result<ToolpathData>>;
}

const handlers = new Map<string, CamOperationHandler>();

export function registerCamOperation(handler: CamOperationHandler): void {
    handlers.set(handler.type, handler);
}

export function camOperation(type: string): CamOperationHandler | undefined {
    return handlers.get(type);
}

/** The operations available on a machine kind, by category then label. */
export function camOperations(kind?: MachineKind): CamOperationHandler[] {
    return [...handlers.values()]
        .filter((handler) => kind === undefined || handler.machineKinds.includes(kind))
        .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}
