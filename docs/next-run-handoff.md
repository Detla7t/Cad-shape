# Chili3D next run plan and test checklist

Updated 10 October 2026. This handoff covers the desktop-export and CAD UI work from the previous chat, including the latest sketch selection and measurement changes. The 10 October 2026 run committed all of it, cleared every Biome warning, fixed the failing tests and the browser-review findings, and recorded results below; what remains is listed under the checklist and Automated checks.

Read this file, `AGENTS.md`, and the relevant sections of [the interaction comparison](onshape-ui-comparison.md) before continuing. Checked items below mean implemented, with the stated evidence; unchecked items are work for the next run. Historical test results are not a fresh verification of the current checkout.

## Checkout and starting point

- Workspace: `/home/hugo/Projects/Cad-shape`.
- Branch at handoff: `claude/parametric-featurescript-system-jptbr5`.
- HEAD at handoff: `86f1754f`, `feat(app): add automation, timelines and desktop export workflows`.
- As of the 10 October 2026 run everything is committed on this branch (through `2b14e441` plus this doc). The review screenshots in `artifacts/next-run-review/` (41 PNGs, ~5 MB) are kept locally and are not committed.
- Current `package.json` starts development on **8081**, despite the 8080 example in `AGENTS.md`. Use the actual server output. Production must retain `next build ... --no-mangling` because serialized classes depend on their names.
- Use a new review document or a fresh copy of `/?template=end-cap-configurator`; preserve the user's working document and preferences.
- For collaborative browser testing, use T3 `preview_status`, then `preview_open` when necessary. Distinguish real pointer/keyboard interactions and screenshots from dispatched events, mocked tests or rasterized DOM.

## First priorities

- [x] Re-run the final selection, measurement and construction-dash tests, then the broader regression suite. Full `npm test` passes (see Automated checks).
- [x] Reproduce and classify the three previously reported failures below. They were test expectations that predated the quantity-unit defaults, fixed in `3c7bbad5`.
- [x] Complete the native browser checklist, especially point/curve selection, plane re-picking, measurement hover guides, annotation dragging and screenshot comparison. Results per item are in the checklist below; screenshots are in `artifacts/next-run-review/`.
- [x] Finish command-window recording as FeatureScript or a persistent replayable modeling operation (`66538d28`, see Command recording).
- [x] Add independent export color filtering (`d8041c34`, see Export selection).
- [x] Update this checklist with exact test outcomes and retained screenshot paths. Commits were requested for this run (10 October 2026); all Biome warnings were cleared first (`5dd9a7d7`).

## Features implemented

| Status | Change | Evidence and limits |
| --- | --- | --- |
| [x] | Open exported files in desktop apps | Local bridge, app detection, open/reveal, toast actions, Share where supported, and Desktop apps preferences. Previously 82 targeted tests passed; a real bridge saved a file and launched a dummy app. A real CAD application's import is still a smoke test to perform. |
| [x] | Fix the false early-development document warning | Next build defines use plain values; legacy documents without a schema version are accepted. Quoted-version document was opened in the browser; schema tests passed. |
| [x] | Property precision and responsive fields | Matrix translation/rotation/scale respect document units, precision and decimal comma; fields wrap in a narrow sidebar. Tests and browser checks passed. This does not establish conversion of every legacy property editor. |
| [x] | Timeline design and groups | Grey band, rail/ticks, horizontal scrolling, selection, persistent groups, +/− expansion, continuous owner bars, up to three owner lanes and overflow popover. Variables and other sceneless nodes are excluded. Tests and browser checks passed. |
| [x] | Timeline dragging and rollback | Step/group dragging shifts neighbors and reorders as one undo step; invalid dependencies/orders are refused. Double-click in tree/timeline and Edit roll to just after the selected step. Tests and browser checks passed. |
| [x] | Explicit components and sub-components | `ComponentFolderNode`, cube icon, New component, component-only activate rings, filtered timeline, parent navigation and new nodes inserted into the active component. Ordinary folder selection does not redirect new parts. This supersedes the earlier implementation that activated every folder. |
| [x] | Matching tree and timeline colors | Shared owner palette and continuous tree strips; runs break at ownership/depth/lane changes. Tests passed; tree before/after evidence was DOM rasterization, not a complete native screenshot. |
| [x] | Chrome and menus | 6 px scrollbars; 5 px resizer grab zones with a 1 px dark line; square 28 px sidebar handle; single main tree history bar; document-tab Save/Save to/Print/Export/Settings/Close menu; configuration visibility/reset menu; cog menu portalled above other elements. Tests/browser checks were reported. |
| [x] | Command window and resizing | Input above suggestions/help/result preview; HELP, LOOKUP, SELECT, SET, VIEW, UNDO/REDO, HISTORY, RECORD; application command dispatch; live expressions; transactions for mutations; top-edge resize. History export is `chili3d-console.txt`. It does not produce FeatureScript. |
| [x] | Sketch plane selection box | Click-to-pick plane/planar face, red clear button, keyboard actions, cancel/toggle, one undo step, solve/view update, and handler restoration. The dropdown was replaced. Tests passed; earlier app check used dispatched clicks and a scripted pick, so native pointer verification remains. |
| [x] | Sketch and drawing export filters | Sketch export includes construction toggle (off by default), external-reference toggle and layer names; drawing export offers layer checkboxes. Color swatches and color preservation exist, but no independent color-selection filter. |
| [x] | CAD file icons | New/Open/Save/Save to/Import/Export/Print SVGs updated. A generic device-browsing or physical-printer delivery workflow was not established by this icon change. |
| [x] | Inactive sketch construction and point picking | Construction curves have cached kernel edges; endpoints/centers have cached kernel vertices; hover/selection highlights the individual item. Tests passed; native interaction remains on the checklist. |
| [x] | Toggle selection and undoable blank clearing | Ordinary clicks toggle sketch curves/points; blank clearing of selected sub-shapes is an undo step, and clearing an empty selection adds none. Latest browser report exercised two points, toggle, blank clear and undo. Whole-node selection retains its separate behavior. |
| [x] | Larger point hit area and measurement guides | Point hit radius follows zoom in pixels (snap distance × 1.5, about 15 px by default). Two points show distance; two curves offer min/max/center distances with hover guides and per-value variable buttons. Equal-valued alternate distances are omitted. Tests and latest app checks passed with the validation limits below. |
| [x] | Whole-sketch yellow outline | Whole-node selection avoids the measurement guide tracing all edges over the yellow selection. Picked sub-shapes and component legs can still have dashed guides. |
| [x] | Zoom-dependent construction dashes | Current defaults are **36/54/270/54 px**. Period snaps to 1, 2 or 5 × 10ⁿ in model units, using `DisplayScale` bands. Former default preferences migrate; custom settings remain. This supersedes older 12/18/90/18 and constant-pixel descriptions. |
| [x] | View cube appearance and corner picking | White corners and most-facing face, grey oblique/back faces, hidden-face labels culled, enlarged 16 px corner targets for isometric views. Tests and app checks passed; earlier images were gizmo DOM rasterizations. |
| [x] | 3D annotations and styling | Notes/general notes/flags/linear and diameter dimensions/GD&T/datums; radius supported through dimension type; readable labels; frame/leader selection; unlocked drag with one undo step; lock and multi-selection color/text-size/line-width edits; Select all annotations. Tests and a composited app capture passed. Anchors remain fixed points rather than associative topology references. |

## Missing or partial implementation

### Command recording

- [x] Record modeling commands with their parameters and picked references into a persistent replayable representation and/or generated FeatureScript. `CommandRecorder` (`packages/core/src/model/commandRecording.ts`) listens to the document's history while `RECORD on`: each completed undo step becomes one step of node-graph changes (`add` with the serialized nodes — parameters and stored refs included —, `set` of a node property, `remove`, `move`, variable upserts/removals, configuration). They are stored in `document.userData["chili3d.commandRecording"]`, so save/reload keeps them. `RECORD replay` re-applies them as one transaction with fresh, remapped ids; `RECORD featurescript` writes a Feature Studio (plain variables become `setVariable`; everything else is listed as not expressible). `HISTORY` stays the typed-line log.
- [x] Test a recorded create/edit sequence, document save/reload and replay; verify equivalent geometry and normal undo/redo. Queries and previews must not become modeling features. `RECORD off` must still allow ordinary modeling transactions. Covered by `packages/core/test/commandRecording.test.ts`, `packages/app/test/commandRecording.kernel.test.ts` (OCCT box create + edit → JSON → replay: same volume and bounds, undo/redo) and `packages/ui/test/consoleEngine.test.ts`.

Open: non-node edits (material, document units, review/timeline state) are reported as "not recorded" and skipped; an edit to a node the target lacks is skipped and reported; the RECORD on/off state is per session (only the steps persist); configuration switches are not recorded; FeatureScript export expresses only plain variables, since Chili3d nodes (bodies, sketches, PMI) carry no FeatureScript counterpart.

### Export selection

- [x] Colour selection with shared filtering. `@chili3d/drawing` owns the one pure filter: `filterDrawing(drawing, { layers?, colors? })` (`DrawingSelection`; `filterDrawingLayers` delegates to it). Each colour key is the entity's effective colour (`effectiveColor`: entity `color` override, else its layer's colour, else `DEFAULT_DRAWING_COLOR`), normalized to lowercase `#rrggbb` (`normalizeColor`); `drawingColors` lists them with counts. Layers and colours combine with AND; empty layer records survive only if selected. Every path filters through it: `sketchDrawing(data, { construction, external, layers, colors })` (sketch command, `sketch.export.colors` comma list), `exportDrawingFile(drawing, { selection })` (export dialog: sketch context menu, `drawing.exportViews`, viewer ribbon) and the drawing viewer's DXF/SVG/PDF/… exports (`chooseExportSelection`, a modal; Cancel aborts with `documents.export.cancelled`). Dialog UI: Layers and Colors checkbox lists (swatch, label, count; all ticked; shown only with more than one row). Writers emit overrides (DXF group 62 nearest ACI, SVG per-entity `stroke`, PDF stroke colour) and DXF import reads 62/420/ByBlock back, so imported drawings filter by colour too.
- [x] Combinations verified on the written DXF/SVG text: `packages/drawing/test/drawing.test.ts`, `packages/parametric/test/sketch/sketchDrawingOptions.test.ts` (construction × external × layer × colour, override vs ByLayer, external refs) and `packages/documents/test/exportSelection.test.ts` (dialog, `chooseExportSelection`, viewer exports, DXF import colours).
- [ ] Remaining: the sketch context menu's "create drawing" document file (`sketchActions.ts`) is written unfiltered (the filter applies when it is exported); DXF R12 has no true colour, so overrides map to the nearest ACI 1–8 and re-import as that colour; `sketchDrawing`'s own layer `colorIndex` mapping is unchanged.

Start in `packages/drawing/src/drawing.ts` (`filterDrawing`), `packages/parametric/src/sketch/sketchDrawing.ts`, `packages/documents/src/ui/exportDialog.ts` and `packages/documents/src/ui/viewers/drawingViewer.ts`.

### Known scope limits

These are existing limitations, not evidence that the recent UI implementations are absent. Keep them separate from the immediate regression work.

- [ ] Associative PMI anchors that follow edited faces/edges, and screen-anchored general-note blocks. Current annotations store fixed 3D points.
- [ ] End Cap `Wall Inner Edge` and `Custom Crimp`. Their nondefault effect is unknown from the reference exports; obtain reference behavior before adding controls that claim to change geometry.
- [ ] Exact Onshape flat feature-list/rollback presentation. The requested single bar and rollback-on-edit are implemented, but body-owned feature nesting still differs.
- [ ] Loft section re-picking while editing; additional Thin/Path/Connections/end-condition/isocurve controls where kernel support permits.
- [ ] Sketch ellipse/elliptical-arc/conic tools require solver support; general D-key inference and the complete repeated-dimension workflow still differ.
- [ ] Additional plane construction methods, including three-point planes and associative parent-plane offsets.
- [ ] Extrude surface/thin/draft/up-to-face/second-end controls, explicit boolean target selection, press-pull arrow and revolve manipulator. Exact source-feature attribution for a picked face also remains limited.
- [ ] Navigation sensitivity/pivot calibration, arrow-key orbit and Alt roll-removal parity; zebra/curvature visualization and capped section cuts.
- [ ] Remaining legacy property unit/precision conversion. For example, `measurePanel.ts` currently formats degrees to three decimals and radians to six rather than using document angle precision.
- [ ] Unsupported closed export formats remain intentionally disabled; Measure curvature deviation remains disabled until the kernel exposes it. These need backend capability, not only enabling a UI item.

The older “no drawing dimension/annotation tools” note in the comparison is superseded: DXF drawing dimensions, notes, title blocks and view insertion were subsequently added. Do not start implementing those again based on that earlier paragraph.

## Native browser test checklist

Use real pointer/keyboard events at a normal canvas size, in a review copy. Save full screenshots under `artifacts/next-run-review/` or `docs/ui-comparison/`; do not rely on `/tmp/claude-1000` images surviving a chat or machine change.

**Run of 10 October 2026** (real pointer/keyboard input in the dev app; screenshots in `artifacts/next-run-review/`, named by item). Bugs found and fixed are listed per item; the remaining minor issues follow the checklist.

| Item | Result | Notes and screenshots |
| --- | --- | --- |
| Selection | Partial → fixed | Points, toggling, blank clear, undo/redo and the empty-clear no-op work (`02-…`, `03-…`). A curve lying on a coplanar datum plane lost to the plane (`01-selection-coplanar-plane-wins.png`); picking now prefers the curve (`bfb8aa0c`). |
| Hit area | Partial → fixed | 13 px reach works, but among densely spaced points the first vertex in range won, not the nearest (`04-hitarea-dense-point-wrong-vertex.png`); now the nearest wins (`bfb8aa0c`). |
| Measurement | Pass | Hover rows, guides and per-row variable buttons (`05-…`, `06-…`). |
| Equal distances | Partial | Parallel lines (`04b-…`): when Center equals Min, its row is omitted although its guide (midpoint to midpoint) differs. Left as is; see below. |
| Plane re-pick | Pass | Datum, solid face, finish during pick (`07-…`). Tree rows cannot be picked while the pick runs. |
| Timeline/components | Pass | Valid/invalid reorder, groups, rail, rollback, component scoping (`08-…`). Overflow scrolling and three-owner lanes were not exercised. |
| Annotations | Partial → fixed | All kinds, both themes, two views, lock, style, reopen (`09-…`–`14-…`). Saving a document with PMI failed (thumbnail bounds read PMI geometry as a BufferGeometry, fixed in `dac11fd2`); a drag lost pointer capture and recorded no undo step (`09-annotations-drag-capture-lost.png`); FCF/datum/flag text was white on white in the dark theme; a mixed annotation selection showed only Name. Drag, dark-theme text (`bfb8aa0c`) and mixed selections (`2b14e441`) are fixed. |
| Cube/dashes | Partial → fixed | Corner picks reach the isometric views (`15-…`); dashes rescale across zoom bands (`16-…`). Graphics ▸ Apply was blocked because the default second dash (270) exceeded its field's max of 100 (`16-dashes-apply-blocked.png`); the max is now 1000 (`dac11fd2`). |
| Chrome/menus/console | Partial | Cog, document-tab menu, visibility-condition editor (persists after save), sidebar collapse (`17-…`). Console not exercised. |
| Exports/desktop | Partial | DXF defaults to inches (`$INSUNITS` 1, mm gives 4), layers SKETCH / SKETCH_CONSTRUCTION / EXTERNAL, construction off is honoured, SVG is true scale (`18-…`). Colour filtering was not exercised in the browser (the review document had no coloured entities); the desktop bridge was not run. |

Remaining minor issues from this run: the equal-distance Center row (above); at a ~145 px sidebar the header icons overlap titles and fields clip; dragging a divider selects page text; clicking a selected tree row deselects it; a PMI label draws over the view cube; clicking a construction dash selects the whole arc; arcs tessellate coarsely when zoomed close; a refused timeline reorder logs `console.error`; panel layout is not persisted.

- [x] **Selection:** outside sketch edit, click two endpoints and a center without modifiers; each highlights alone. Click a selected point/curve again to remove it. Repeat with construction lines, arcs and overlapping points/curves, at several zooms. Blank click clears; Ctrl+Z restores; redo clears; a second empty blank click adds no undo entry. Confirm selecting ordinary bodies/tree rows and switching tools still works.
- [x] **Hit area:** click about 13 px from a point at multiple zoom levels; verify it wins over its neighboring edge without making densely spaced points impossible to choose.
- [x] **Measurement:** two points show one distance guide/value and the appropriate components. Use lines/arcs with different min/max/center values; hover each available row and verify correct endpoint markers, dashed segment and value; leaving restores the main trace; changing/clearing selection removes stale geometry. Each variable button must create the measurement for that row.
- [ ] **Equal distances:** test curves whose min/max/center values happen to match. Current deduplication applies to all entity types, although its comment describes two points. Check that omitting a same-valued row does not remove a useful distinct guide the user expects. Treat this as a potential edge case until reproduced.
- [x] **Plane re-pick:** open a sketch; click/clear the plane box; pick a datum, offset plane and real solid face; verify tracked reference, solve, camera turn, undo/redo and save/reopen. Exercise Escape, second-click cancellation and finishing the sketch during a pick; subsequent tools must receive the restored handler.
- [ ] **Timeline/components:** overflow scrolling, open and closed group dragging, valid reorder plus undo/redo, invalid dependency refusal, +/− rail, single tree history bar, matching colors, three-owner/overflow lanes, and rollback-before-editor on tree/timeline double-click. Plain folders have no activate ring; components nest, scope the timeline, receive new parts and return to their parent.
- [x] **Annotations:** place all kinds on a comparable model; capture readable labels in light/dark themes and multiple views; select lines and frames, drag unlocked frames, undo/redo, lock, style one/multiple/all, and save/reopen. Remove demo overlaps before comparing with the user's reference. Earlier evidence composited the WebGL frame with HTML labels and contained overlapping placements.
- [x] **Cube/dashes:** corner hit targets reach the expected isometric view; hidden-face labels never show through; white facing face/corners and grey others match the reference; animation frames advance. Zoom construction curves across several scale bands and verify density, selection and custom preference preservation.
- [ ] **Chrome/menus/console:** cog stays in front and closes correctly; document-tab actions work; visibility-condition editor matches the requested menu and persists changes; narrow sidebar wraps fields; divider and console resizing retain usable bounds; suggestions/Tab/help/expression preview/history work; sidebar toggle is square and functional.
- [ ] **Exports/desktop:** inspect real DXF/SVG output for construction/external/layer selection, units and colors; check drawing format paths. With the helper running, open a supported file in a real detected CAD app, reveal it, exercise auto-open on/off and bridge-unavailable fallback. Dummy launcher tests do not prove a CAD importer accepts the file.

## Automated checks and known failures

Run of 10 October 2026, on the final checkout (all fixes above committed, through `2b14e441`), full output kept and exit status read directly:

| Check | Result |
| --- | --- |
| `node scripts/typecheck.mjs` | exit 0 |
| `npm run check:ci` | exit 0; `npx biome check --diagnostic-level=warn .` reports no warnings or errors |
| `npm test` | exit 0: 660 files, 9,696 tests, 9,695 passed, 1 skipped, 0 failed |
| `npm run build` | exit 0, 207 built assets verified (run before the last picking/PMI fixes, which change no build configuration) |
| `npm run preview` smoke test | not run |

The three previously reported failures (`elementWorkspace.test.ts` Variable Studio ×2, `geometryPanel.kernel.test.ts` mass and moments) reproduced; production behaviour was right and the expectations predated the quantity-unit defaults (lengths in the document unit, mass in kg). Fixed in `3c7bbad5`. Note that the default three-decimal precision shows small masses coarsely (2.54 g reads `0.003 kg`); consider more digits for mass.

- [x] Reproduce the three failures and decide production vs expectation (expectations, `3c7bbad5`).
- [x] Targeted and integration groups (all inside the full run above).
- [x] `npm test`, `npm run check:ci`, `npm run build`.
- [ ] `npm run preview` and smoke-test the exported build.

## Files to inspect by task

| Task | Main implementation |
| --- | --- |
| Selection and hit radius | `packages/core/src/eventHandlers/nodeSelectionEventHandler.ts`, `packages/three/src/threeView.ts`, `packages/three/src/threeHighlighter.ts`, `packages/parametric/src/sketch/sketchNode.ts` |
| Measurement rows and traces | `packages/ui/src/review/selectionMeasurementControl.ts`, `measurementGuide.ts`, `measurePanel.ts` |
| Timeline and ownership | `packages/core/src/model/partStudioTimeline.ts`, `packages/ui/src/project/timeline/partStudioTimelineBar.tsx`, `packages/ui/src/project/tree/ownerColors.ts`, `tree.ts`, `treeItemGroup.ts` |
| Components | `packages/core/src/model/componentContext.ts`, `componentFolderNode.ts`, `packages/app/src/commands/component.ts` |
| Annotations | `packages/core/src/model/pmiAnnotation.ts`, `packages/app/src/commands/annotation/pmiCommands.ts`, `packages/three/src/threePmiAnnotation.ts`, `pmiElements.ts`, `threePmi.module.css`, `threeView.ts` |
| Plane picker | `packages/parametric/src/sketch/editor/sketchPanel.ts`, `packages/parametric/src/sketch/commands/pickedPlane.ts` |
| Cube and dashes | `packages/three/src/viewGizmo.ts`, `viewGizmo.module.css`, `packages/core/src/visual/displayScale.ts`, `packages/core/src/graphicsPreferences.ts`, `packages/parametric/src/sketch/entityMesh.ts` |
| Console and chrome | `packages/ui/src/console/`, `packages/ui/src/editor.ts`, `editor.module.css`, `packages/ui/src/ribbon/documentTabMenu.ts`, `packages/ui/src/project/modelSidebar.ts` |
| Desktop delivery | `scripts/desktop-bridge.mjs`, `packages/core/src/desktop/`, `packages/ui/src/desktop/exportDelivery.ts` |

## Brief to paste into the next chat

> Continue the CAD UI work in `/home/hugo/Projects/Cad-shape`. Read `docs/next-run-handoff.md` and `AGENTS.md` first. The 10 October 2026 run committed all work, cleared Biome warnings, fixed the failing tests and the browser-review findings; the full suite passes. Open: the unchecked browser items (equal distances, timeline overflow/lanes, console, export colours and the desktop bridge with a real CAD app), the remaining minor issues listed under the checklist, the preview smoke test, and the longer-term items. Update the handoff with exact outcomes.

If more historical detail is needed, the source T3 thread is `9f641e63-29cd-4ce1-a361-594bedebee52`. Its messages view contains the requests and completion reports; its activity view contains the test output. Later corrections supersede earlier component, plane-picker, cube-label and dash descriptions.
