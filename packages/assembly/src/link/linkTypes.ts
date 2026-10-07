// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "@chili3d/core";

/**
 * Cross-document links — Onshape's "insert from another document": a reference to one node
 * (a part, or an assembly) of ANOTHER document, at a chosen point of that document's version
 * history.
 *
 * - `{ kind: "version", name }` — pinned to a named version. Never moves on its own; when the
 *   source gains a newer version the link shows "update available".
 * - `{ kind: "branch", name }` — follows the head of a branch ("Main"): the link updates
 *   itself whenever the source document is saved (or found to have moved when opened).
 * - `{ kind: "commit", id }` — pinned to one microversion; "update available" when its branch
 *   moved on.
 *
 * `resolvedCommit` is the commit the link currently shows — what the consuming document
 * versions (an update is a recorded change) and what its cached geometry is keyed by.
 */

export type LinkVersionSpec =
    | { readonly kind: "version"; readonly name: string }
    | { readonly kind: "branch"; readonly name: string }
    | { readonly kind: "commit"; readonly id: string };

export interface PartLinkData {
    readonly documentId: string;
    /** The source node (part or assembly) id. */
    readonly nodeId: string;
    readonly version: LinkVersionSpec;
    /** The commit currently shown; undefined until first resolved. */
    readonly resolvedCommit?: string;
    /** Last known names, for display while the source is unreachable. */
    readonly documentName?: string;
    readonly nodeName?: string;
    /** Last known label of the resolved commit ("V2", "Main", a message). */
    readonly versionLabel?: string;
}

export type LinkStatus = "pending" | "ok" | "updateAvailable" | "broken" | "error";

/** The i18n key naming a link's state. */
export function linkStatusKey(state: LinkState | undefined): I18nKeys {
    switch (state?.status) {
        case "ok":
            return "link.status.ok";
        case "updateAvailable":
            return "link.status.updateAvailable";
        case "broken":
            return "link.status.broken";
        case "error":
            return "link.status.error";
        default:
            return "link.status.pending";
    }
}

/** A newer target a pinned link could move to. */
export interface LinkUpdate {
    readonly version: LinkVersionSpec;
    readonly commit: string;
    readonly label: string;
}

/** Runtime state of one link (never serialized). */
export interface LinkState {
    readonly status: LinkStatus;
    readonly message?: string;
    readonly update?: LinkUpdate;
    /** True while the shown geometry came from the cache because the source could not be read. */
    readonly fromCache?: boolean;
}

/** One solid of a resolved link, as cached: a part link has one, an assembly link one per placed part. */
export interface CachedPartData {
    readonly name: string;
    readonly brep: string;
    /** Placement inside the linked node (column-major 4×4); identity for a part link. */
    readonly transform: readonly number[];
    /** Stable face / edge ids by sub-shape index, when the source tracks them (parametric bodies). */
    readonly faceIds?: readonly (string | null)[];
    readonly edgeIds?: readonly (string | null)[];
    /** What makes two BOM rows the same item (source document, commit and node). */
    readonly bomKey: string;
    /** Where the solid comes from, for the BOM. */
    readonly sourceLabel: string;
}

export interface LinkCacheEntry {
    readonly key: string;
    readonly documentId: string;
    readonly documentName: string;
    readonly commit: string;
    readonly nodeId: string;
    readonly nodeName: string;
    readonly kind: "part" | "assembly";
    readonly versionLabel: string;
    readonly parts: readonly CachedPartData[];
}

export function linkCacheKey(documentId: string, commit: string, nodeId: string): string {
    return `${documentId}@${commit}#${nodeId}`;
}

export function linkKeyOf(link: PartLinkData): string | undefined {
    return link.resolvedCommit === undefined
        ? undefined
        : linkCacheKey(link.documentId, link.resolvedCommit, link.nodeId);
}

export function describeVersion(spec: LinkVersionSpec): string {
    switch (spec.kind) {
        case "version":
            return spec.name;
        case "branch":
            return `${spec.name} (latest)`;
        case "commit":
            return spec.id.slice(0, 7);
    }
}

/** The version a link shows: its spec, plus the resolved label when that says more ("V2 · Edit (3f2a9c1)"). */
export function describeLinkVersion(link: PartLinkData): string {
    const spec = describeVersion(link.version);
    const label = link.versionLabel;
    const named = link.version.kind === "commit" ? undefined : link.version.name;
    return label === undefined || label === named ? spec : `${spec} · ${label}`;
}

export function sameVersionSpec(a: LinkVersionSpec, b: LinkVersionSpec): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "commit") return a.id === (b as { id: string }).id;
    return a.name === (b as { name: string }).name;
}

/** Parses a stored link; undefined when it is not one. */
export function parseLink(json: string): PartLinkData | undefined {
    try {
        const value = JSON.parse(json) as Partial<PartLinkData> | null;
        if (
            value === null ||
            typeof value !== "object" ||
            typeof value.documentId !== "string" ||
            typeof value.nodeId !== "string" ||
            !isVersionSpec(value.version)
        ) {
            return undefined;
        }
        return value as PartLinkData;
    } catch {
        return undefined;
    }
}

export function isVersionSpec(value: unknown): value is LinkVersionSpec {
    if (value === null || typeof value !== "object") return false;
    const spec = value as Record<string, unknown>;
    if (spec["kind"] === "commit") return typeof spec["id"] === "string";
    return (spec["kind"] === "version" || spec["kind"] === "branch") && typeof spec["name"] === "string";
}
