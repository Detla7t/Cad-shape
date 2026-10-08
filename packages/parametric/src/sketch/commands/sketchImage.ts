// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, command, PubSub, readFileAsync } from "@chili3d/core";
import { editSketch } from "../editor/editSketch";
import type { SketchEditor } from "../editor/sketchEditor";
import { SketchConstraintCommand } from "./sketchConstraints";
import { sketchToolInput } from "./sketchToolInput";
@command({ key: "sketch.insertImage", icon: "icon-import" })
export class InsertSketchImageCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const files = await readFileAsync("image/png,image/jpeg,image/webp", false, "readAsDataURL");
        if (!files.isOk || !files.value[0]) return;
        const file = files.value[0];
        if (file.data.length > 22_000_000) {
            PubSub.default.pub("displayError", "Choose an image smaller than 16 MB.");
            return;
        }
        const image = new Image();
        image.src = file.data;
        try {
            await image.decode();
        } catch {
            PubSub.default.pub("displayError", "The image could not be decoded.");
            return;
        }
        const values = await sketchToolInput(
            editor.view,
            "Insert image",
            { "Width (mm)": 100 },
            this.controller,
        );
        if (!values) return;
        const width = Number(values["Width (mm)"]);
        if (!(width > 0)) return;
        const at = await editor.pickPosition("prompt.pickSketchPoint", undefined, this.controller);
        if (!at) return;
        editSketch(editor, (data) => {
            data.images ??= [];
            data.images.push({
                id: crypto.randomUUID(),
                name: file.fileName,
                dataUrl: file.data,
                x: at[0],
                y: at[1],
                width,
                height: (width * image.naturalHeight) / image.naturalWidth,
            });
        });
    }
}
