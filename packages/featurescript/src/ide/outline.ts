// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Declaration, DeclarationKind } from "./declarations";

/** The studio outline: its features, functions, types, enums and constants, in source order. */

export interface OutlineItem {
    readonly name: string;
    readonly kind: Exclude<DeclarationKind, "import">;
    readonly exported: boolean;
    /** A feature's "Feature Type Name". */
    readonly label?: string;
    /** Offset of the declared name — where a click jumps. */
    readonly from: number;
    readonly to: number;
    /** A function's parameter names; a feature's parameter count. */
    readonly detail?: string;
}

export function outlineOf(declarations: readonly Declaration[]): OutlineItem[] {
    const items: OutlineItem[] = [];
    for (const declaration of declarations) {
        if (declaration.kind === "import") continue;
        let detail: string | undefined;
        if (declaration.kind === "feature") detail = `${declaration.fields?.length ?? 0}`;
        else if (declaration.signature !== undefined) {
            detail = `(${declaration.signature.params.map((param) => param.name).join(", ")})`;
        } else if (declaration.kind === "enum") detail = `${declaration.members?.length ?? 0}`;
        items.push({
            name: declaration.name,
            kind: declaration.kind,
            exported: declaration.exported,
            label:
                declaration.kind === "feature" ? declaration.annotation?.get("Feature Type Name") : undefined,
            from: declaration.nameFrom,
            to: declaration.nameTo,
            detail,
        });
    }
    return items;
}
