// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type INode,
    isVariableStudioNode,
    Localize,
    registerElementKind,
    registerElementView,
    type VariableStudioNode,
} from "@chili3d/core";
import { div, span, svg } from "@chili3d/element";
import { VariablesDataContent } from "../property/variables/variablesDataContent";
import { VariablesEditor } from "../property/variables/variablesEditor";
import style from "./elements.module.css";

/**
 * Variable Studios as document elements: a tab per studio, showing the same variables
 * editor as the Parameters panel — bound to the studio instead of the document table —
 * full-size. Edits write through (one undo step each) and re-scope the document, so the
 * Part Studio rebuilds exactly as it does for a table edit.
 */
export const VARIABLE_STUDIO_KIND = "variableStudio";

registerElementKind({
    kind: VARIABLE_STUDIO_KIND,
    icon: "icon-tag",
    display: "elements.variableStudio",
    isElement: isVariableStudioNode,
    newCommand: "variable.newStudio",
});

registerElementView(VARIABLE_STUDIO_KIND, (node: INode, document: IDocument) => {
    const studio = node as VariableStudioNode;
    const editor = new VariablesEditor(
        new VariablesDataContent(document, () => document.visual.update(), studio),
    );
    const title = span({ className: style.studioTitle, textContent: studio.name });
    const onStudioChanged = (property: string) => {
        if (property === "name") title.textContent = studio.name;
    };
    studio.onPropertyChanged(onStudioChanged);
    const element = div(
        { className: style.variableStudio },
        div({ className: style.studioHeader }, svg({ className: style.studioIcon, icon: "icon-tag" }), title),
        div({ className: style.studioHint, textContent: new Localize("elements.variableStudio.hint") }),
        div({ className: style.studioBody }, editor),
    );
    return {
        element,
        dispose: () => {
            studio.removePropertyChanged(onStudioChanged);
            editor.dispose();
        },
    };
});
