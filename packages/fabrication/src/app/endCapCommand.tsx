// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, type IDocument, PubSub } from "@chili3d/core";
import { mountIsland } from "@chili3d/react";
import type { EndCapParams } from "../endcap/endCap";
import { DEFAULT_END_CAP_FORM, type EndCapFormValue, readEndCapForm } from "../react/endCapForm";
import { EndCapEditor } from "../react/endCapView";
import { addEndCapSketch } from "./endCapSketch";

/** Inches, like the Onshape workspace the end caps come from. */
const INCH_UNITS = { length: "in", angle: "deg", lengthPrecision: 4, anglePrecision: 1 } as const;

/** The dialog opens on the last cap inserted in this session. */
let lastForm: EndCapFormValue = DEFAULT_END_CAP_FORM;

async function targetDocument(application: IApplication, name: string): Promise<IDocument> {
    return application.activeView?.document ?? application.newDocument(name, { ...INCH_UNITS });
}

/**
 * Inserts the end cap's flat pattern as a sketch — into the active document, or a new inch
 * document when none is open — and frames it. Errors go to the user, not the console.
 */
export async function insertEndCap(application: IApplication, params: EndCapParams): Promise<boolean> {
    const document = await targetDocument(application, "End Cap");
    const sketch = addEndCapSketch(document, params);
    if (!sketch.isOk) {
        PubSub.default.pub("displayError", sketch.error);
        return false;
    }
    document.visual.update();
    application.activeView?.cameraController.fitContent();
    return true;
}

/**
 * Sheet Metal ▸ Round Duct ▸ End Cap: the End Cap Configurator's panel (a React island in the
 * dialog — the same component as the `/endcap` page) and its flat pattern, inserted as a sketch.
 */
@command({ key: "sheetMetal.endCap", icon: "icon-arc" })
export class EndCapCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const host = document.createElement("div");
        let form = lastForm;
        const island = mountIsland(
            host,
            <EndCapEditor
                initial={form}
                onChange={(value) => {
                    form = value;
                }}
            />,
            application,
        );
        PubSub.default.pub("showDialog", "command.sheetMetal.endCap", host, [
            {
                content: "common.confirm",
                // An incomplete form keeps the dialog open; the form shows what is missing.
                shouldClose: () => readEndCapForm(form).params !== undefined,
                onclick: async () => {
                    const params = readEndCapForm(form).params;
                    if (params === undefined) return;
                    island.dispose();
                    lastForm = form;
                    await insertEndCap(application, params);
                },
            },
            { content: "common.cancel", onclick: () => island.dispose() },
        ]);
    }
}
