// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    dialectOfPost,
    machineForPost,
    machineProfile,
    ncCamProgram,
    postProcessor,
    postProcessors,
    readNcProgram,
    repostNcProgram,
    type ToolpathData,
} from "../../src";
import { expectSameToolpaths } from "../_helpers/ncRoundTrip";

/** Re-posting a read program: every post of the program's kind writes the same motion. */

const FANUC = `%
O2001 (HOUSING)
(T1 D=8. CR=1. - BULL NOSE)
(T5 D=4.2 - DRILL)
G90 G94 G17 G49 G40 G80
G21
G28 G91 Z0.
G90
(FACE)
T1 M6
S9000 M3
G54
M8
G0 X-10. Y0.
G43 Z10. H1
G1 Z-0.5 F300.
X40. F1200.
G2 X50. Y10. I0. J10.
G1 Y30.
G3 X30. Y50. R20.
G0 Z10.
M9
M5
G28 G91 Z0.
G90
(HOLES)
T5 M6
S3000 M3
G54
G0 X10. Y10.
G43 Z10. H5
G98 G81 X10. Y10. Z-6. R2. F200.
X20.
G80
M5
G28 G91 Z0.
G90
M30
%
`;

/** The toolpaths of a read program as a post would get them (no reference returns). */
function programmed(text: string): ToolpathData[] {
    return readNcProgram(text).toolpaths.map((path) => ({
        ...path.toolpath,
        moves: path.toolpath.moves.filter((_, index) => !path.homeMoves.has(index)),
    }));
}

describe("re-posting a read program", () => {
    const read = readNcProgram(FANUC);

    test("tools come from the T numbers and the comment tool table", () => {
        const program = ncCamProgram(read, machineProfile("generic-3-axis")!);
        expect(
            [...program.tools.values()].map((tool) => [
                tool.id,
                tool.number,
                tool.kind,
                tool.diameter,
                tool.cornerRadius,
            ]),
        ).toEqual([
            ["T1", 1, "bullNose", 8, 1],
            ["T5", 5, "drill", 4.2, undefined],
        ]);
        expect(program.toolpaths.map((path) => path.label)).toEqual(["FACE", "HOLES"]);
        expect(program.setup.programName).toBe("2001");
    });

    test.each(
        postProcessors("mill")
            .filter((post) => ["fanuc", "haas", "linuxcnc", "mach3", "grbl"].includes(post.id))
            .map((post) => post.id),
    )("as %s, the motion is the same", (postId) => {
        const result = repostNcProgram(read, postId);
        expect(result.isOk).toBe(true);
        const again = readNcProgram(result.value!.text, { dialect: dialectOfPost(postId) });
        expectSameToolpaths(programmed(FANUC), again);
    });

    test("a mill program cannot go to a printer post, and says why", () => {
        const result = repostNcProgram(read, "marlin");
        expect(result.isOk).toBe(false);
        expect(result.error).toContain('"drill" moves are not printer moves');
    });

    test("the machine is the program's when the post fits it, else one of the post's kind", () => {
        const mill = machineProfile("generic-3-axis")!;
        expect(machineForPost(postProcessor("fanuc")!, mill)).toBe(mill);
        expect(machineForPost(postProcessor("waterjet")!, mill).kind).toBe("waterjet");
        expect(repostNcProgram(read, "no-such-post").error).toBe('There is no post "no-such-post"');
    });

    test("a plasma program re-posted for a waterjet keeps its pierces", () => {
        const plasma = readNcProgram(
            [
                "G90 G21",
                "G0 X10 Y10",
                "M07",
                "G4 P0.8",
                "M51",
                "G1 X50 F2500",
                "G2 X60 Y20 I0 J10",
                "M50",
                "M08",
                "M30",
            ].join("\n"),
            {
                dialect: "plasma",
            },
        );
        const result = repostNcProgram(plasma, "waterjet");
        expect(result.isOk).toBe(true);
        expect(result.value!.machine.kind).toBe("waterjet");
        const again = readNcProgram(result.value!.text, { dialect: "waterjet" });
        expectSameToolpaths(
            plasma.toolpaths.map((path) => path.toolpath),
            again,
        );
        expect(result.value!.text).toContain("M03\nG4 P0.8");
    });
});
