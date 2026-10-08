// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Original SVG artwork based on the shaded, isometric vocabulary in the supplied CAD references. */
const symbols: Record<string, string> = {
    part: '<path fill="#d4d7da" d="m2 8 6-2 4 2v-5l6 3v10l-7 3-9-4Z"/><path fill="#fafafa" d="m2 8 5 3 5-2V3l-5 2v6M7 11v6l4 2v-7l7-3"/><path d="m12 8 6 1M11 12l-4-1"/>',
    extrude:
        '<path fill="#eceeef" d="m3 5 9-3 5 3-9 3Z"/><path fill="#c6c9cb" d="M3 5v12l5 2V8Z"/><path fill="#fafafa" d="m8 8 9-3v12l-9 2Z"/><path d="M5 4v11l3 2 7-2V4"/>',
    revolve:
        '<ellipse fill="#d5d7d9" cx="10" cy="10" rx="7" ry="8"/><ellipse fill="#fafafa" cx="10" cy="10" rx="3" ry="4"/><path d="M10 2v4m0 8v4M3 10h4m6 0h4"/><path stroke="#5882b6" d="m15 3 3 1-1 3"/>',
    sweep: '<path fill="#c7cacc" d="M2 13q0-5 5-5h4q2 0 2-3V3h5v4q0 6-6 6H8q-1 0-1 2v3H2Z"/><path d="M4 17v-3q0-4 5-4h3q4 0 4-5"/>',
    loft: '<path fill="#c4c7ca" d="M6 4q2 6-3 13 7 4 14 0-5-7-3-13Z"/><ellipse fill="#f5f6f7" cx="10" cy="4" rx="4" ry="2"/><path d="M3 17q7-3 14 0"/>',
    fillet: '<path fill="#dddfe1" d="M3 8q0-5 5-5h6l4 4v11H3Z"/><path fill="#b5b9bd" d="M3 8h5v10H3Z"/><path fill="#fafafa" d="M8 18V9q0-3 3-3h6l1 1v11Z"/><path d="M3 8q2 2 5 1m0-6 3 3"/>',
    chamfer:
        '<path fill="#dddfe1" d="m3 7 4-4h7l4 4v11H3Z"/><path fill="#b6babd" d="M3 7h5v11H3Z"/><path fill="#fafafa" d="m8 7 4-4 6 4v11H8Z"/><path stroke="#6a86aa" d="m3 7 5 0 4-4"/>',
    shell: '<path fill="#d4d7d9" d="m2 6 10-3 6 3v11l-10 2-6-3Z"/><path fill="#fafafa" d="m4 7 8-2 4 2-8 2Z"/><path fill="#a8aeb3" d="m5 7 7-2v3L8 9Z"/><path d="M8 9v10m8-12v8l-8 2"/>',
    hole: '<path fill="#d3d6d8" d="m2 6 10-3 6 4v10l-10 2-6-4Z"/><path fill="#fafafa" d="m2 6 6 4 10-3M8 10v9"/><ellipse fill="#555b60" cx="10" cy="6.5" rx="3" ry="1.7"/>',
    draft: '<path fill="#d5d8da" d="M5 3h8l5 14H2Z"/><path fill="#fafafa" d="m5 3 4 3-3 12-4-1Z"/><path d="M9 6h5M6 18l12-1"/>',
    plane: '<path fill="#eef0f3" d="m2 3 15 4v12L2 15Z"/><path fill="#c6d7ea" d="m3 5 12 3v8L3 13Z"/><path stroke="#6984a8" d="m3 5 12 3"/>',
    partStudio:
        '<path fill="#fafafa" d="m2 4 4-2 4 2v14l-4-2-4 2Z"/><path fill="#c9cccf" d="M6 2v14l4 2V4Z"/><path fill="#fafafa" d="m10 3 4-1 4 2v14l-4-2-4 1Z"/><path fill="#d4d7da" d="M14 2v14l4 2V4Z"/>',
    assembly:
        '<path fill="#c3c7ca" d="M2 2h11l5 5v11H7l-5-5Z"/><path fill="#fafafa" d="M2 2v11l5 5V7Z"/><path fill="#e9ebed" d="m2 2 5 5h11l-5-5Z"/><path d="M5 2l5 5v11m0-11h8"/>',
    featureStudio:
        '<path fill="#f4f5f6" d="m6 3 4-2 4 2v5l-4 2-4-2ZM3 10l4 2v5l-4 2-2-2v-5Zm10 2 4-2 2 2v5l-4 2-2-2Z"/><path d="m6 3 4 2 4-2m-4 2v5m-7 0 2 2 2-2m-2 2v5m8-5 2 2 4-2m-4 2v5"/>',
    variable:
        '<path d="M5 2Q1 10 5 18M15 2q4 8 0 16M7 6l6 8m0-8-6 8"/><path stroke-width="1.6" d="M6 3h8M6 17h8"/>',
    cam: '<path fill="#c7cbce" d="M3 2h14v4H3Zm2 13h10l3 3H2Z"/><path fill="#eee" d="M7 6h6v4l-3 4-3-4Z"/><path stroke="#6789b5" d="M10 10v6"/>',
    drawing: '<path fill="#fafafa" d="M1 3h17v14H1Z"/><path d="M12 12h6v5h-6ZM3 5h3m-3 0v3"/>',
    document: '<path fill="#fafafa" d="M4 2h9l4 4v12H4Z"/><path d="M13 2v5h4"/>',
    material:
        '<path fill="#c9cccf" d="M2 8h3v10H2Zm6-4h3v14H8Zm6 2h3v12h-3Z"/><path d="M2 5h3m3-4h3m3 2h3M1 12h17"/>',
    folder: '<path fill="#fafafa" d="M1 5h7l2 2h9v11H1Z"/>',
    configuration:
        '<path fill="#d9dcde" d="M2 12h16v6H2Z"/><path fill="#c1c5c9" d="m4 11 6-8 6 4-5 8Z"/><path fill="#eee" d="m10 3 4-2 5 4-3 2Z"/><path d="M7 13v5m6-5v5m-8-3h10"/>',
    tables: '<path fill="#fafafa" d="m7 7 6-2 5 3v8l-6 3-5-3Z"/><path d="m7 7 5 3 6-2m-6 2v9"/><path fill="#d9e6f5" stroke="#507fb4" d="M1 1h9v8H1ZM1 4h9M4 1v8M7 1v8"/>',
    inspection:
        '<path fill="#dddfe1" d="m5 5 7-3 5 3v10l-7 3-5-3Z"/><path d="m5 5 5 3 7-3m-7 3v10M1 12h6m-3-2v7h13v-4"/><path stroke="#5589c0" d="M2 17h5m7-4h5"/>',
    sheetMetal:
        '<path fill="#f0f1f2" d="M2 2h8v7l8-2v9l-8 3V9H2Z"/><path d="M2 5h8M5 2v7m8-1v9M3 11l5 5m-5-2 5 5"/>',
    history:
        '<path d="M4 3v14M7 4h11M7 9h11M7 14h11M4 7l6 4v7"/><circle fill="#fafafa" cx="4" cy="3" r="2"/><circle fill="#fafafa" cx="4" cy="17" r="2"/><circle fill="#fafafa" cx="10" cy="17" r="2"/>',
    import: '<path fill="currentColor" d="m10 2-5 6h3v6h4V8h3Z"/><path d="M2 18h16"/>',
};

const aliases: Record<string, string> = {
    "featurescript.newStudio": "featureStudio",
    featurescript: "featureStudio",
    featureStudio: "featureStudio",
    "assembly.new": "assembly",
    "cam.newStudio": "cam",
    camStudio: "cam",
    "variable.newTable": "variable",
    variableTable: "variable",
    variableStudio: "variable",
    variables: "variable",
    "documents.newDrawing": "drawing",
    "plane.create": "plane",
    "file.import": "import",
    "create.revol": "revolve",
    drawingDocument: "drawing",
    markdownDocument: "document",
    richTextDocument: "document",
    textDocument: "document",
    spreadsheetDocument: "tables",
    pdfDocument: "document",
    fileDocument: "document",
};

export function createModelingIcon(command: string): SVGSVGElement | undefined {
    const key = aliases[command] ?? command.split(".").at(-1)!;
    const markup = symbols[key];
    if (!markup) return undefined;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({
        viewBox: "0 0 20 20",
        width: "20",
        height: "20",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": ".8",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        "aria-hidden": "true",
    }))
        icon.setAttribute(key, value);
    icon.dataset["cadIcon"] = key;
    icon.innerHTML = markup;
    return icon;
}
