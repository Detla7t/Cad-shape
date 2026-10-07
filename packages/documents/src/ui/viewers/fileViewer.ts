// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Localize } from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "../documents.module.css";
import type { IDocumentViewer, ViewerContext } from "../viewer";

/** A file with no viewer (legacy .doc, presentations, …): kept in the project, downloadable from the header. */
export function createFileViewer(_context: ViewerContext): IDocumentViewer {
    return {
        element: div({ className: style.message, textContent: new Localize("documents.file.noViewer") }),
        dispose: () => {},
    };
}
