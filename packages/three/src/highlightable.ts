// Part of the Chili3d Project, under the AGPL-3.0 Licensettt.
// See LICENSE file in the project root for full license information.

export interface IHighlightable {
    highlight(): void;
    unhighlight(): void;
}

export function isHighlightable(value: unknown): value is IHighlightable {
    const candidate = value as Partial<IHighlightable> | null | undefined;
    return (
        !!candidate &&
        typeof candidate.highlight === "function" &&
        typeof candidate.unhighlight === "function"
    );
}
