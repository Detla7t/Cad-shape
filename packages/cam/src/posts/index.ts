// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerPostProcessor } from "../model/post";
import { CUTTING_DIALECTS, CuttingPost } from "./cuttingPost";
import { MILL_DIALECTS, MillPost } from "./millPost";
import { WireEdmPost } from "./wireEdmPost";

export * from "./cuttingPost";
export * from "./gcodeWriter";
export * from "./millPost";
export * from "./motion";
export * from "./wireEdmPost";

/** Registers the built-in posts: the mill dialects, the 2D cutting posts and wire EDM. */
export function registerBuiltInPosts(): void {
    for (const dialect of MILL_DIALECTS) registerPostProcessor(new MillPost(dialect));
    for (const dialect of CUTTING_DIALECTS) registerPostProcessor(new CuttingPost(dialect));
    registerPostProcessor(new WireEdmPost());
}

registerBuiltInPosts();
