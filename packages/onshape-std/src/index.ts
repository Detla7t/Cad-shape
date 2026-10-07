// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import bundleUrl from "../std/onshape-std-3083.json.gz";

/**
 * Onshape's FeatureScript standard library — the `onshape/std/*.fs` sources Feature
 * Studios import — packed as one gzipped JSON asset (`scripts/bundle-onshape-std.mjs`).
 * The std is MIT-licensed by PTC Inc. (`std/LICENSE.txt`); this loader is AGPL like the
 * rest of the app.
 */

export const ONSHAPE_STD_VERSION = 3083;

export interface OnshapeStdBundleData {
    readonly version: number;
    /** The std's MIT license text. */
    readonly license: string;
    /** `"<module>.fs"` → source, for every module under `onshape/std/`. */
    readonly files: Readonly<Record<string, string>>;
}

/** Decodes the bundle: gzipped JSON — or plain JSON when a server already decompressed it. */
export async function decodeOnshapeStd(bytes: ArrayBuffer | Uint8Array): Promise<OnshapeStdBundleData> {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const gzipped = data[0] === 0x1f && data[1] === 0x8b;
    const text = gzipped
        ? await new Response(
              new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : new TextDecoder().decode(data);
    return JSON.parse(text) as OnshapeStdBundleData;
}

/** Fetches and decodes the bundled std (the asset the build emits). */
export async function loadOnshapeStd(url: string = bundleUrl): Promise<OnshapeStdBundleData> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Onshape std library: ${response.status} ${response.statusText}`);
    return decodeOnshapeStd(await response.arrayBuffer());
}
