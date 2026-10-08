// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AppGuideStore,
    Config,
    formatShortcutKey,
    I18N_KEYS,
    I18n,
    type I18nKeys,
    Navigation3D,
    Navigation3DTypes,
    ShortcutProfiles,
} from "@chili3d/core";
import type { Skill } from "./types";

/** Command keys the manual may reference; a `{key}` outside this set stays literal (and is a bug). */
const COMMAND_KEYS = new Set(
    I18N_KEYS.filter((key) => key.startsWith("command.")).map((key) => key.slice("command.".length)),
);

/** command -> display keys in the active navigation profile. */
function activeHotkeys(): Map<string, string> {
    const profile = ShortcutProfiles[Config.instance.navigation3D] ?? {};
    const byCommand = new Map<string, string>();
    for (const [command, keyOrKeys] of Object.entries(profile)) {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        byCommand.set(command, keys.map(formatShortcutKey).join(" / "));
    }
    return byCommand;
}

/**
 * Resolve `{command.key}` placeholders to what the user has on screen: the label in their
 * language and the binding in their navigation profile. Nothing about a button is baked into
 * this file, so the manual cannot teach a name or a hotkey that this session does not have.
 *
 * Places are the one thing it cannot resolve — a command's tab and group are read from the
 * live ribbon by the get_ribbon tool, and the manual points there instead of guessing.
 */
export function resolveCommandRefs(text: string): string {
    if (!text.includes("{")) return text;
    const hotkeys = activeHotkeys();
    return text.replace(/\{([a-z][\w.]*)\}/g, (match, key: string) => {
        if (!COMMAND_KEYS.has(key)) return match;
        const label = I18n.translate(`command.${key}` as I18nKeys);
        const keys = hotkeys.get(key);
        return keys ? `“${label}” (${keys})` : `“${label}”`;
    });
}

const mouseKey = (key: string) =>
    key
        .split("+")
        .map((part) => (part === "Middle" ? "middle-drag" : part === "Right" ? "right-drag" : part))
        .join(" + ");

/** Per-profile pan/rotate table, asked of Navigation3D rather than restated here. */
function navigationProfiles(): string {
    return Navigation3DTypes.map((profile) => {
        const { pan, rotate } = Navigation3D.navigationKeyMap(profile);
        return `  - ${profile}: pan = ${mouseKey(pan)}, rotate = ${mouseKey(rotate)}`;
    }).join("\n");
}

const INTRO = `Chili3D app guide — how to operate the application itself.

Use this document to TEACH. The user is sitting in front of the app and can click along, so answer with the actual path: the tab, the group, the button, the hotkey, the click sequence. Every command named below carries the label the user's own language gives it and the hotkey their navigation profile binds — so name the button in their language, and lean on the tab, the group and the hotkey to disambiguate, since those are language-independent.

This manual covers what commands DO and how the app behaves. It deliberately says nothing about where a button sits: that is the live ribbon, and get_ribbon reads it — the tabs, groups and buttons of this very session, plugins included, in the user's language, plus the commands that have no ribbon button at all (a dialog, the model tree, or hotkey only). Call it before telling anyone where to click, and believe it over this manual if the two ever disagree.

Layout of the window: title bar on top (Home button, quick commands, ribbon tab headers), the ribbon below it, the viewport in the middle, the model tree and the property panel on the sides of the viewport, and a status bar at the bottom. The status bar is where a running command says what it wants next ("select models", "pick a face") — during a multi-step command, that line, not trial and error, is how the user knows what to click.`;

const SECTIONS = [
    `## Navigating the viewport
- Wheel = zoom toward or away from the cursor; the Solidworks and Creo profiles reverse the wheel direction to match those applications.
- Right-drag freely orbits; Ctrl (or Command) + right-drag pans. Alt + right-drag keeps a world-vertical orbit. Middle-button controls depend on the navigation profile (the current one is also reported by get_ribbon):
${navigationProfiles()}
- Double-press the middle button (two presses within half a second) = fit content (frame everything).
- Left-drag does NOT move the camera — in the viewport it draws a rubber-band selection box. A rotation orbits around the centre of the selection, or of the shape under the cursor when nothing is selected.
- A stationary right-click is passed to the active tool on release, for example to cancel a sketch constraint pick. Dragging with the right button navigates without cancelling the tool. Right-click toolbar tools for shortcuts, pinning and tab customization.
- Touch: one finger drags while a pick is active, two fingers pan and zoom, three fingers rotate.`,

    `## Selecting geometry
- Left-click a shape to select its whole node; left-click empty space to clear the selection.
- Shift+click toggles a node in the viewport selection. (Ctrl+click does not toggle there; in the model tree Ctrl+click toggles and Shift+click selects a range.)
- A left-drag rubber band selects every node whose bounding box falls inside it.
- Hovering highlights a shape in green and a selected shape keeps a green highlight, so the colour alone is a weak confirmation: check the property panel or the status bar prompt instead of trusting the tint.
- Escape clears the selection, or cancels the command in progress. While picking, Enter or Space accepts the current pick, and Tab cycles to the next overlapping shape under the cursor.`,

    `## Reorienting the view
- The labeled view cube in the top-right corner follows the camera. Click a face for Top, Bottom, Front, Back, Left or Right; click an edge or corner for a diagonal view. Drag the cube to orbit.
- The surrounding arrows rotate 15 degrees, Shift+click rotates 90 degrees, and Ctrl/Command+click rotates 5 degrees. Curved arrows roll the view; the small cube below returns to isometric.
- Sketches initially open normal to their plane but can be orbited. Press N while editing a sketch to restore its normal view.
- Hiding the shapes you do not need (eye icon in the model tree) is usually easier than fighting the camera.`,

    `## Model tree and property panel
- The model tree selects nodes exactly as the viewport does; the eye icon on a row shows or hides that node.
- Drag a row onto a folder to re-parent it. Only folders accept a drop — releasing beside a node makes it a sibling.
- There is no rename in the tree and no right-click menu: rename a node in the property panel's Name field.
- Three different removals, and users mix them up: {modify.deleteNode} removes the selected nodes entirely (this is what the Delete key runs); {modify.removeShapes} picks sub-shapes (edges or faces) on a shape and deletes just those, rebuilding the node; {modify.removeFeature} picks a face a feature created (for instance the rounded face of a fillet) and removes that feature. The last two replace the node with the healed shape, so undo is the way back.
- Double-click a sketch node to open it for editing.
- The property panel shows the selected node's Name, a transform expander (translation / scale / rotation), the shape's own parameters, and — for a parametric body — its feature list.
- Every edit in the property panel applies immediately and is one undo step. The same rows are what get_node_properties reads and set_node_properties writes, so changing a dimension that already exists is a property edit — never a delete-and-recreate.`,

    `## The working plane
- The dynamic working plane is on by default: while placing a point, the app picks whichever of the world XY / XZ / YZ planes is closest to the cursor, so points land on the most natural plane. The Working Plane group's toggle turns that off, and points then land on the view's current workplane.
- Set: a dialog offers XOY / YOZ / ZOX.
- Align To Plane: pick a face and adopt it as the workplane.
- From Section: pick an edge, then a point on it — the workplane stands perpendicular to the curve at that point.`,

    `## Sketching
The workflow to teach:
1. {sketch.create} — pick a plane or a flat face; the sketch is created and opens for editing.
2. The Sketch tab appears (it is contextual — visible only while sketching, and get_ribbon reports it as contextual). The camera locks to a straight-on orthographic view of the sketch plane, the solid's own faces are hidden, and rotation is disabled.
3. Draw with {sketch.line}, {sketch.circle}, {sketch.arc}, {sketch.rectangle}.
4. Points snap while drawing — to nearby points, to lines and axes, and to circles and arcs — and a nearly horizontal or vertical line silently gets a Horizontal/Vertical constraint; near-tangent entities are constrained tangent. The same magnetic snapping applies while dragging a point, and the constraint is added when the drag settles.
5. Constraints come from the Constraint group and dimensions from the Dimension group. A dimension is placed with a live preview and a value dialog: confirming commits it as one undo step, cancelling rolls the constraint back. Double-click a dimension later to change its value.
6. The status bar reports under-constrained, fully-constrained or conflicting.
7. {sketch.exit} leaves the session. {sketch.enter} re-opens a sketch, and double-clicking a sketch node in the tree or viewport does the same.
- External edges: {sketch.projectEdges} brings coplanar edges of the solid into the sketch; each one is either a Reference (construction-only, dashed) or a Profile (it takes part in the profile). {sketch.toggleExternal} switches a picked reference between the two roles, and a reference whose source disappears is drawn red.
- Escape peels off one layer at a time (label placement, then pick, then constraint, then entity, then the session); Delete removes the hovered or selected constraint or entity.`,

    `## Parametric features
- A parametric body stores no shapes: it replays its ordered feature list, so changing any feature rebuilds everything after it.
- The feature list lives in the property panel when a single body is selected. Each row's “⋯” menu offers Rename, Reselect (re-pick the shapes the feature refers to), Suppress/Unsuppress and Delete; rows are drag-reordered.
- Feature parameters are edited inline in the row and commit on Enter or click-away — each edit is one undo step.
- If a feature fails, the body keeps the last shape that did build and the failing row shows the error: fix it or suppress that feature.
- References resolve against the timeline position of the feature that owns them, so a feature added later cannot break an earlier reference.
- Suppressed features are skipped when rebuilding but keep their place in the list.
- The features are added from the Parametric tab: {feature.extrude} (operation New/Join/Cut/Intersect, symmetric, start offset, depth), {feature.revolve}, {feature.fillet}, {feature.chamfer}, {feature.fuse}, {feature.cut} and {feature.common}.
- {feature.variable} opens the document-wide Parameters dialog: each parameter has a name, a type (length / angle / unitless), an expression and an optional description. Parameters are shared by the whole document — any feature parameter or sketch dimension may reference one by name, and a variable may reference the ones listed above it.
- An expression takes numbers, other parameter names, + - * / %, parentheses, pi/e, and abs, sqrt, floor, ceil, round, min, max, sin, cos, tan, asin, acos, atan, atan2 — angles are in degrees throughout. Types are checked: a length parameter in an angle slot is an error, sqrt wants even exponents, and a variable cannot reference one declared below it.
- {configuration.edit} opens the Configuration panel (Onshape's configurations): inputs are lists (named options, one the default), checkboxes and configuration variables, and the active configuration is switched there or in the configuration bar above the element tabs — switching is not an undo step. Any parameter, sketch dimension, variable or feature suppression becomes configured by holding \`configure(Size, "S": 10, "L": w * 2)\` (or \`configure(Holes, true: 5, false: 0)\` for a checkbox); the Configure button on a feature parameter writes that for you, and editing a configured cell changes the active configuration's value only.`,

    `## Documents and files
- The app opens on a start screen: {doc.new}, {doc.open}, the recent documents and the settings (see below).
- {doc.save} stores the document in the browser (IndexedDB); it then appears in the start screen's recents.
- {doc.saveToFile} downloads the document as a .chili3d project (a zip: manifest.json, document.json, every Feature Studio as a readable .fs file, a thumbnail); {doc.open} reads it back, and still opens legacy .cd files.
- There is NO autosave — nothing is stored until the user saves. Closing with a document open asks for confirmation first.
- Import: .step, .stp, .iges, .igs, .brep, .stl, and .fs (becomes a new Feature Studio). Export: .step, .iges, .brep, .stl, .stl binary, .ply, .ply binary, .obj, .glb, .gltf, .3mf — the export dialog chooses the format and can pack several objects into a .zip.
- 2D export, in millimetres, as DXF (R12) or SVG: {sheetMetal.exportFlat} writes a sheet metal body's flat pattern (outline and holes, bend lines on BEND_UP / BEND_DOWN labelled with angle and radius, crimp/bead marks on FORMING); {sketch.export} writes a sketch in its plane's coordinates. {featurescript.exportStudio} / {featurescript.importStudio} move Feature Studios as .fs files.
- The File tab gathers all of this: open/save, import/export, 2D export and Feature Studio files.
- Dropping files onto the window: a .chili3d or .cd opens, plugin files load, anything else is imported.`,

    `## Settings, units and the AI assistant
- The only settings screen is the start screen (Home button in the title bar): Language, Theme (system by default) and 3D Navigation. They persist in the browser.
- Units are millimetres and degrees everywhere, and no setting changes that.
- The status bar holds the snap configuration: endpoint, midpoint, centre, perpendicular, intersection, tangent, on curve, on surface, plus snap tracking.
- The AI assistant panel is toggled by {ai.toggleChat} and has no hotkey. It starts docked open; drag its header to detach it into a floating window, and drag it back to re-dock. Its first use asks for provider, base URL, model and API key. Send with Ctrl+Enter or the send button, and images can be attached.`,
];

/**
 * The manual the assistant reads: the built-in text unless someone replaced it, followed by
 * every section modules and plugins registered (see AppGuideStore). Assembled on demand, not
 * when the skill is constructed — registration happens as plugins load, and a contributed
 * section may use the same `{command.key}` references the built-in text uses.
 */
function buildAppGuideDoc(): string {
    const override = AppGuideStore.getBase();
    const parts = [resolveCommandRefs(override ?? [INTRO, ...SECTIONS].join("\n\n"))];
    for (const section of AppGuideStore.getSections()) {
        parts.push(resolveCommandRefs(`## ${section.name}\n${section.content}`));
    }
    return parts.join("\n\n");
}

/**
 * The app's own manual. Unlike the other skills this one is about the UI rather than the
 * modeling API, so it is the answer to "how do I…" and "where is…" questions: it maps every
 * command to its ribbon tab/group and hotkey, and explains navigation, selection, the model
 * tree, sketch mode and the parametric feature list.
 */
export const appGuide: Skill = {
    name: "app-guide",
    description:
        'How to operate the Chili3D app itself: where every command lives (ribbon tabs and groups, toolbars, hotkeys), viewport navigation and selection, the model tree and property panel, sketch mode, parametric features, file operations and settings — load it to answer any "how do I…" or "where is…" question',
    get content() {
        return buildAppGuideDoc();
    },
};
