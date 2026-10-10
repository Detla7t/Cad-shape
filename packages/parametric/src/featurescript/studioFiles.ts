// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    registerProjectManifestContributor,
    safeProjectFileName,
    Transaction,
} from "@chili3d/core";
import { onshapeStdVersion } from "@chili3d/featurescript";
import { FEATURE_STUDIO_EXTENSION, FeatureStudioNode } from "./featureStudioNode";
import { documentStudios } from "./studioCompiler";

/**
 * Feature Studios as files: a studio's FeatureScript source is plain text, exported and
 * imported as `.fs` (Onshape's extension), and stored as `featurestudios/<name>.fs`
 * inside a `.chili3d` project rather than inline in `document.json`.
 */

// The std the studios were written against travels with the project.
registerProjectManifestContributor(() => {
    const version = onshapeStdVersion();
    return version === undefined ? undefined : { featureScript: { std: "onshape", version } };
});

/** The download name of a studio: its name made file-safe, plus `.fs`. */
export function featureStudioFileName(studio: FeatureStudioNode, used = new Set<string>()): string {
    return safeProjectFileName(studio.name, FEATURE_STUDIO_EXTENSION, used);
}

/**
 * `wanted`, or "wanted (2)", ... — whichever no studio of the document uses yet. Studios
 * import each other by name, so an imported file keeps its own name whenever it is free.
 */
export function uniqueStudioName(document: IDocument, wanted: string): string {
    const taken = new Set(documentStudios(document).map((studio) => studio.name));
    const base = wanted.trim().length > 0 ? wanted.trim() : "Feature Studio";
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const name = `${base} (${n})`;
        if (!taken.has(name)) return name;
    }
}

/** The studio name a `.fs` file name gives: the name without its extension. */
export function studioNameOfFile(fileName: string): string {
    const base = fileName.replace(/^.*[\\/]/, "");
    return base.toLowerCase().endsWith(FEATURE_STUDIO_EXTENSION)
        ? base.slice(0, -FEATURE_STUDIO_EXTENSION.length)
        : base;
}

/** Adds a Feature Studio holding `source` to the document, as one undo step. */
export function importFeatureStudio(
    document: IDocument,
    fileName: string,
    source: string,
): FeatureStudioNode {
    const studio = new FeatureStudioNode({
        document,
        name: uniqueStudioName(document, studioNameOfFile(fileName)),
        source,
    });
    Transaction.execute(document, "import feature studio", () => {
        document.modelManager.addNode(studio);
    });
    return studio;
}
