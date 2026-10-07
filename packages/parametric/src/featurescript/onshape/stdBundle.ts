// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { OnshapeStdSource } from "./onshapeStd";

/** Onshape's std library packed by `scripts/bundle-onshape-std.mjs` (once decompressed). */
export interface OnshapeStdBundle {
    readonly version: number;
    /** The std's MIT license text. */
    readonly license: string;
    readonly files: Readonly<Record<string, string>>;
}

export function onshapeStdFromBundle(bundle: OnshapeStdBundle): OnshapeStdSource {
    return {
        version: bundle.version,
        read: (file) => (Object.hasOwn(bundle.files, file) ? bundle.files[file] : undefined),
    };
}
