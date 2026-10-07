// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation";
import type { VisualNode } from "../model";

export interface IMeshExporter {
    exportToStl(node: VisualNode[], asciiMode: boolean): Result<BlobPart>;
    exportToPly(node: VisualNode[], asciiMode: boolean): Result<BlobPart>;
    exportToObj(node: VisualNode[]): Result<BlobPart>;
    /** glTF 2.0: binary `.glb` or JSON `.gltf` (buffers embedded), one named node per model node. */
    exportToGltf(node: VisualNode[], binary: boolean): Promise<Result<BlobPart>>;
}
