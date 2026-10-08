// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type ICommand, PubSub, readFilesAsync } from "@chili3d/core";
import { appendSketch, SketchEditor } from "@chili3d/parametric";
import { drawingToSketchData } from "./cad/drawingToSketch";
import { importDwg } from "./cad/dwg";
import { importDxf } from "./cad/dxfToDrawing";

@command({ key: "sketch.importDrawing", icon: "icon-import" })
export class ImportSketchDrawingCommand implements ICommand {
    async execute(): Promise<void> {
        const editor = SketchEditor.getActive();
        if (!editor) return;
        const files = await readFilesAsync(".dxf,.dwg", false);
        if (!files.isOk || !files.value[0]) return;
        const file = files.value[0],
            bytes = new Uint8Array(await file.arrayBuffer());
        const result = /\.dwg$/i.test(file.name) ? await importDwg(bytes) : importDxf(bytes);
        if (!result.isOk) {
            PubSub.default.pub("displayError", result.error);
            return;
        }
        if (SketchEditor.getActive() !== editor) return;
        const imported = drawingToSketchData(result.value.drawing, result.value.sources),
            before = editor.solver.toData(),
            data = structuredClone(before);
        appendSketch(data, imported.data);
        editor.solver.reset(data);
        if (!editor.solve(true).result.startsWith("Ok")) {
            editor.solver.reset(before);
            editor.solve(true);
            PubSub.default.pub("displayError", "The drawing could not be added to this sketch.");
            return;
        }
        editor.commit();
        editor.view.cameraController.fitContent();
        if (imported.omitted)
            PubSub.default.pub(
                "displayError",
                `${imported.omitted} annotation or unsupported drawing entities were omitted; sketch geometry was imported.`,
            );
    }
}
