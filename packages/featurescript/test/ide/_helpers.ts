// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { scanDeclarations } from "../../src/ide/declarations";
import { scanTokens } from "../../src/ide/scanner";
import { StdIndex } from "../../src/ide/stdIndex";
import { buildSymbolTable, type StudioSource } from "../../src/ide/symbols";
import { ONSHAPE_STD } from "../_helpers/onshapeStd";

/** One std index for the whole test file: scanning std's `geometry.fs` closure is the slow part. */
export const STD_INDEX = new StdIndex(ONSHAPE_STD);

export const CURSOR = "‸";

/** A studio source with `‸` marking the cursor: the source without it, and the cursor offset. */
export function withCursor(marked: string): { source: string; pos: number } {
    const pos = marked.indexOf(CURSOR);
    if (pos < 0) throw new Error("no cursor marker");
    return { source: marked.slice(0, pos) + marked.slice(pos + CURSOR.length), pos };
}

/** Everything the language service needs about a studio source. */
export function analyze(
    source: string,
    studios: readonly StudioSource[] = [],
    std: StdIndex | undefined = STD_INDEX,
) {
    const declarations = scanDeclarations(source);
    const table = buildSymbolTable(declarations, {
        std,
        studio: (path) => studios.find((studio) => studio.name === path || studio.id === path),
    });
    return { source, tokens: scanTokens(source), declarations, table };
}

export const HEADER = 'FeatureScript 3083;\nimport(path : "onshape/std/geometry.fs", version : "3083.0");\n';
