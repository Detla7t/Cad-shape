// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import font from "./fonts/helvetiker_regular.typeface.json";
import type { SketchData } from "./sketchModel";
import { appendEntity } from "./sketchOperations";
/** Font outlines remain editable sketch curves and participate in closed profiles. */
export function appendText(data: SketchData, text: string, height: number, origin: [number, number]): void {
    if (!text.trim() || !(height > 0)) throw new Error("Enter text and a positive height.");
    if (text.length > 200) throw new Error("Use at most 200 characters per text insertion.");
    const glyphs = font.glyphs as Record<string, { ha: number; o?: string }>,
        scale = height / font.resolution;
    let x = origin[0],
        y = origin[1];
    for (const letter of text) {
        if (letter === "\n") {
            x = origin[0];
            y -= height * 1.4;
            continue;
        }
        const glyph = glyphs[letter];
        if (!glyph) throw new Error(`The outline font does not contain “${letter}”.`);
        const tokens = glyph.o?.trim().split(/\s+/) ?? [];
        let i = 0,
            current: [number, number] = [x, y];
        const point = (): [number, number] => [
            x + Number(tokens[i++]) * scale,
            y + Number(tokens[i++]) * scale,
        ];
        while (i < tokens.length) {
            const op = tokens[i++];
            if (op === "m") current = point();
            else if (op === "l") {
                const end = point();
                if (Math.hypot(end[0] - current[0], end[1] - current[1]) > 1e-7)
                    appendEntity(data, "line", [...current, ...end]);
                current = end;
            } else if (op === "q") {
                const end = point(),
                    control = point();
                appendEntity(data, "bezier", [...current, ...control, ...end]);
                current = end;
            } else if (op === "b") {
                const end = point(),
                    c1 = point(),
                    c2 = point();
                appendEntity(data, "bezier", [...current, ...c1, ...c2, ...end]);
                current = end;
            } else throw new Error(`Unsupported font outline command: ${op}`);
        }
        x += glyph.ha * scale;
    }
}
