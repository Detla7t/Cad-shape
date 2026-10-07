// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolData } from "./tool";
import type { Vec3 } from "./toolpath";

/**
 * A setup: one fixturing of the work on one machine — the work coordinate system, the stock,
 * the parts it machines and the ordered operations that cut them. Plain JSON, stored in a
 * CAM Studio (`camStudioNode.ts`).
 */
export interface SetupData {
    readonly id: string;
    readonly name: string;
    /** A machine profile id (`machine.ts`). */
    readonly machineId: string;
    /** WCS in model coordinates: origin and axes (x ⟂ z, both unit). */
    readonly wcs: { readonly origin: Vec3; readonly xAxis: Vec3; readonly zAxis: Vec3 };
    readonly stock: StockData;
    /** Model node ids of the parts (bodies) this setup machines. */
    readonly partIds: readonly string[];
    readonly operations: readonly CamOperationData[];
    /** Tools this setup adds to the machine's own (`MachineProfileData.tools`). */
    readonly tools?: readonly ToolData[];
    /** Program number / name the post writes. */
    readonly programName?: string;
    /** The post-processor chosen for this setup (default: the machine's `post.id`), and its options. */
    readonly postId?: string;
    readonly postOptions?: Readonly<Record<string, unknown>>;
}

export type StockData =
    /** The parts' bounding box grown by margins (mm, per side; +z on top). */
    | {
          readonly kind: "box";
          readonly margin: {
              readonly x: number;
              readonly y: number;
              readonly zTop: number;
              readonly zBottom: number;
          };
      }
    /** A round bar along the WCS z axis. */
    | { readonly kind: "cylinder"; readonly diameter: number; readonly length: number; readonly zTop: number }
    /** Another model body is the stock (a casting, a previous setup's result). */
    | { readonly kind: "body"; readonly nodeId: string }
    /** A flat sheet on the table for 2D cutting (waterjet, plasma, laser, wire). */
    | { readonly kind: "sheet"; readonly width: number; readonly height: number; readonly thickness: number };

/**
 * Geometry an operation is applied to, picked in the model: faces or edges of a part, a
 * whole sketch, or a sheet metal body's flat pattern. `id` is the tracked sub-shape id when
 * the owner tracks ids (parametric bodies), so picks survive rebuilds; `index` otherwise.
 */
export type GeometrySelection =
    | {
          readonly kind: "face" | "edge";
          readonly nodeId: string;
          readonly id?: string;
          readonly index?: number;
      }
    | { readonly kind: "sketch"; readonly nodeId: string }
    | { readonly kind: "flatPattern"; readonly nodeId: string }
    | { readonly kind: "body"; readonly nodeId: string };

/** One operation of a setup; `params` holds the operation type's own fields. */
export interface CamOperationData {
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly toolId?: string;
    readonly suppressed?: boolean;
    readonly selection?: readonly GeometrySelection[];
    readonly params: Readonly<Record<string, unknown>>;
}
