// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys, IDisposable, IDocument } from "@chili3d/core";
import type { NcProgramNode } from "../ncProgramNode";
import type { NcProgram } from "../program";

/**
 * Actions beside the backplot of an NC Program — the place a stock-removal "Simulate"
 * plugs in. An action gets the element, its program as last read and the document; views
 * opened after a registration show its button.
 */
export interface NcProgramAction {
    readonly id: string;
    readonly label: I18nKeys;
    run(context: {
        readonly node: NcProgramNode;
        readonly program: NcProgram;
        readonly document: IDocument;
    }): void | Promise<void>;
}

const actions: NcProgramAction[] = [];

/** Registers (or replaces, by id) an action of the NC Program view. */
export function registerNcProgramAction(action: NcProgramAction): IDisposable {
    const index = actions.findIndex((existing) => existing.id === action.id);
    if (index >= 0) actions.splice(index, 1, action);
    else actions.push(action);
    return {
        dispose: () => {
            const at = actions.indexOf(action);
            if (at >= 0) actions.splice(at, 1);
        },
    };
}

export function ncProgramActions(): readonly NcProgramAction[] {
    return actions;
}
