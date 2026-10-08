// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { SketchData } from "../sketchModel";
import type { SketchEditor } from "./sketchEditor";

export function editSketch(editor: SketchEditor, run: (data: SketchData) => void) {
    const before = editor.solver.toData(),
        data = structuredClone(before);
    run(data);
    try {
        editor.solver.reset(data);
        const solved = editor.solve(true);
        if (!solved.result.startsWith("Ok")) {
            throw new Error(
                "This edit conflicts with existing dimensions or constraints. Remove the conflicting constraint first.",
            );
        }
    } catch (error) {
        editor.solver.reset(before);
        editor.solve(true);
        throw error;
    }
    editor.commit();
}
