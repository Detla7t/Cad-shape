// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n } from "@chili3d/core";
import style from "./elements.module.css";

/** The dot an element's tab (and its row in the tab browser) shows while its editor holds unsaved edits. */
export function unsavedMark(): HTMLElement {
    const mark = document.createElement("span");
    mark.className = style.unsaved;
    mark.textContent = "●";
    mark.dataset["unsaved"] = "";
    I18n.set(mark, "title", "editorBuffers.marker");
    mark.setAttribute("aria-label", I18n.translate("editorBuffers.marker"));
    return mark;
}
