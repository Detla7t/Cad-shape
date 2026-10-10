// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The drawing element in front, for the Drawing toolbar's commands: the viewer registers
 * itself while its tab is the active one (`activated` / `deactivated`), the commands act on
 * whichever is registered. None when the Part Studio or another element is in front.
 */
export interface IActiveDrawing {
    /** Brings the drawing's geometry into the Part Studio as a sketch. */
    createSketch(): void;
    /** Shows the whole drawing. */
    fit(): void;
    /** Downloads the drawing in one of its formats. */
    export(extension: ".dxf" | ".dwg" | ".svg"): Promise<void>;
    /** Opens the drawing preferences. */
    preferences(): void;
    /** Arms the note tool: the next click places a note. */
    note(): void;
    /** Arms the dimension tool: two clicks dimension the distance between them. */
    dimension(): void;
    /** Edits the sheet's title block (title, drawn by, number, revision, size). */
    titleBlock(): void;
    /** Replaces the sheet's views with the Part Studio's current parts. */
    insertViews(): void;
    /** Saves the sheet's layout as a named drawing template. */
    saveTemplate(): void;
    /** Loads a DXF as template art behind the sheet. */
    importTemplate(): void;
}

let current: IActiveDrawing | undefined;

export function setActiveDrawing(drawing: IActiveDrawing | undefined): void {
    current = drawing;
}

export function activeDrawing(): IActiveDrawing | undefined {
    return current;
}
