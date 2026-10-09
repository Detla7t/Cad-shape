// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerDocumentTemplate } from "@chili3d/core";
import { END_CAP_TEMPLATE } from "./endCapTemplate";

export * from "./endCapCommand";
export * from "./endCapConfiguration";
export * from "./endCapSketch";
export * from "./endCapSketchNode";
export * from "./endCapTemplate";

// Loading the module publishes its templates, as loading it registers its commands and nodes.
registerDocumentTemplate(END_CAP_TEMPLATE);
