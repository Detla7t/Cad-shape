// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, type IShape, Matrix4, ShapeNode, serializedTypeId } from "@chili3d/core";
import { type ILinkService, linkService } from "../link/linkRegistry";
import type { LinkState } from "../link/linkTypes";
import { AssemblyNode } from "./assemblyNode";
import type { AssemblyInstanceData } from "./assemblyTypes";

/**
 * Evaluating an assembly: every instance's source looked up live and flattened into placed
 * solids — what the 3D view shows, the BOM counts and the exporters write. Synchronous: linked
 * sources come from the link cache (an instance whose link is not resolved yet is "pending" and
 * fills in when the link service reports it), local ones from the document's own nodes.
 */

export interface PlacedPart {
    /** The top-level instance the solid belongs to. */
    readonly instanceId: string;
    /** Index of the solid within its instance (sub-assemblies and linked assemblies have several). */
    readonly partIndex: number;
    readonly instanceName: string;
    readonly name: string;
    /** The solid in its own coordinates. Shared — never dispose it. */
    readonly shape: IShape;
    /** Solid → assembly coordinates (Matrix4 semantics: `inner` first, then the instance). */
    readonly placement: Matrix4;
    /** Solid → instance coordinates. */
    readonly inner: Matrix4;
    /** The Part Studio node it comes from, for a part of this document. */
    readonly node?: INode;
    readonly faceIds?: readonly (string | null)[];
    readonly edgeIds?: readonly (string | null)[];
    /** What makes two solids the same BOM item: `local:<nodeId>` or `<doc>@<commit>#<node>`. */
    readonly bomKey: string;
    readonly sourceLabel: string;
}

export type InstanceStatus = "ok" | "missing" | "pending" | "broken" | "error" | "cycle" | "suppressed";

export interface InstanceEvaluation {
    readonly instance: AssemblyInstanceData;
    readonly status: InstanceStatus;
    readonly message?: string;
    readonly parts: readonly PlacedPart[];
    readonly link?: LinkState;
}

export interface AssemblyEvaluation {
    readonly instances: readonly InstanceEvaluation[];
    /** Every visible solid, flattened. */
    readonly parts: readonly PlacedPart[];
}

export const LOCAL_SOURCE_LABEL = "This document";

/** Node classes that are shapes but not parts. */
const NOT_PARTS = new Set(["SketchNode", "MultiShapeNode"]);

/** Whether a node of a Part Studio is a part an assembly can place. */
export function isPartNode(node: INode): node is ShapeNode {
    if (!(node instanceof ShapeNode) || NOT_PARTS.has(serializedTypeId(node) ?? node.constructor.name))
        return false;
    // A parametric body's children are its consumed boolean tools, not parts of their own.
    return !(node.parent instanceof ShapeNode);
}

export function isAssemblyLike(node: INode): node is AssemblyNode {
    return node instanceof AssemblyNode;
}

/** The parts of a document's Part Studio, in tree order. */
export function localParts(document: IDocument): ShapeNode[] {
    return document.modelManager.findNodes((node) => isPartNode(node)) as ShapeNode[];
}

/** The assemblies of a document, in tree order. */
export function localAssemblies(document: IDocument): AssemblyNode[] {
    return document.modelManager.findNodes((node) => node instanceof AssemblyNode) as AssemblyNode[];
}

export function instanceMatrix(instance: AssemblyInstanceData): Matrix4 {
    return instance.transform.length === 16 ? Matrix4.fromArray(instance.transform) : Matrix4.identity();
}

export function evaluateAssembly(
    document: IDocument,
    assembly: AssemblyNode,
    links: ILinkService | undefined = linkService(),
    stack: readonly string[] = [],
): AssemblyEvaluation {
    const instances: InstanceEvaluation[] = [];
    const inner = [...stack, assembly.id];
    for (const instance of assembly.instances) {
        instances.push(evaluateInstance(document, assembly, instance, links, inner));
    }
    const parts = instances.flatMap((x) => (x.instance.hidden || x.instance.suppressed ? [] : x.parts));
    return { instances, parts };
}

function evaluateInstance(
    document: IDocument,
    assembly: AssemblyNode,
    instance: AssemblyInstanceData,
    links: ILinkService | undefined,
    stack: readonly string[],
): InstanceEvaluation {
    if (instance.suppressed) return { instance, status: "suppressed", parts: [] };
    const placement = instanceMatrix(instance);
    const source = instance.source;
    const place = (
        shape: IShape,
        index: number,
        name: string,
        innerMatrix: Matrix4,
        extra: Partial<PlacedPart> & Pick<PlacedPart, "bomKey" | "sourceLabel">,
    ): PlacedPart => ({
        instanceId: instance.id,
        partIndex: index,
        instanceName: instance.name,
        name,
        shape,
        inner: innerMatrix,
        placement: innerMatrix.multiply(placement),
        ...extra,
    });

    if (source.kind === "part") {
        const node = document.modelManager.findNode((x) => x.id === source.nodeId);
        if (node === undefined || !isPartNode(node)) {
            return {
                instance,
                status: "missing",
                message: "The part is no longer in this document",
                parts: [],
            };
        }
        const shape = node.shape;
        if (!shape.isOk) return { instance, status: "error", message: shape.error, parts: [] };
        return {
            instance,
            status: "ok",
            parts: [
                place(shape.value, 0, node.name, node.worldTransform(), {
                    node,
                    bomKey: `local:${node.id}`,
                    sourceLabel: LOCAL_SOURCE_LABEL,
                }),
            ],
        };
    }

    if (source.kind === "assembly") {
        if (stack.includes(source.nodeId)) {
            return { instance, status: "cycle", message: "The assembly contains itself", parts: [] };
        }
        const node = document.modelManager.findNode((x) => x.id === source.nodeId);
        if (!(node instanceof AssemblyNode)) {
            return {
                instance,
                status: "missing",
                message: "The assembly is no longer in this document",
                parts: [],
            };
        }
        const sub = evaluateAssembly(document, node, links, stack);
        return {
            instance,
            status: sub.instances.some((x) => x.status !== "ok" && x.status !== "suppressed")
                ? "error"
                : "ok",
            message: sub.instances.find((x) => x.message !== undefined)?.message,
            parts: sub.parts.map((part, index) =>
                place(part.shape, index, `${node.name} › ${part.name}`, part.placement, {
                    node: part.node,
                    faceIds: part.faceIds,
                    edgeIds: part.edgeIds,
                    bomKey: part.bomKey,
                    sourceLabel: part.sourceLabel,
                }),
            ),
        };
    }

    const state = links === undefined ? undefined : links.stateOf(assembly, instance.id);
    const resolved = links?.shapesOf(source.link);
    if (resolved === undefined) {
        const status: InstanceStatus =
            state?.status === "broken" ? "broken" : state?.status === "error" ? "error" : "pending";
        return { instance, status, message: state?.message, parts: [], link: state };
    }
    const { entry, shapes } = resolved;
    const parts = entry.parts.map((part, index) =>
        place(
            shapes[index],
            index,
            entry.kind === "part" ? entry.nodeName : `${entry.nodeName} › ${part.name}`,
            Matrix4.fromArray(part.transform),
            {
                faceIds: part.faceIds,
                edgeIds: part.edgeIds,
                bomKey: part.bomKey,
                sourceLabel: part.sourceLabel,
            },
        ),
    );
    const status: InstanceStatus = state?.status === "broken" ? "broken" : "ok";
    return { instance, status, message: state?.message, parts, link: state };
}

/** The stable id of a solid's face / edge by index, when its source tracks ids. */
export function entityIdOf(part: PlacedPart, kind: "face" | "edge", index: number): string | undefined {
    const ids = kind === "face" ? part.faceIds : part.edgeIds;
    if (ids !== undefined) return ids[index] ?? undefined;
    const tracker = part.node as
        | {
              faceIdAt?: (index: number) => string | undefined;
              edgeIdAt?: (index: number) => string | undefined;
          }
        | undefined;
    const lookup = kind === "face" ? tracker?.faceIdAt : tracker?.edgeIdAt;
    return typeof lookup === "function" ? lookup.call(tracker, index) : undefined;
}

/** The index of a face / edge with a stable id in a solid, when its source tracks ids. */
export function entityIndexOf(part: PlacedPart, kind: "face" | "edge", id: string): number | undefined {
    const ids = kind === "face" ? part.faceIds : part.edgeIds;
    if (ids !== undefined) {
        const index = ids.indexOf(id);
        return index < 0 ? undefined : index;
    }
    const tracker = part.node as
        | {
              faceIndexById?: (id: string) => number | undefined;
              edgeIndexById?: (id: string) => number | undefined;
          }
        | undefined;
    const lookup = kind === "face" ? tracker?.faceIndexById : tracker?.edgeIndexById;
    return typeof lookup === "function" ? lookup.call(tracker, id) : undefined;
}
