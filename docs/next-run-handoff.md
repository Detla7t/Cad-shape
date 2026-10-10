# Chili3D next run plan and test checklist

Updated 10 October 2026. This handoff covers the desktop-export and CAD UI work from the previous chat, including the latest sketch selection and measurement changes. Most requested behavior is implemented. FeatureScript recording, independent export color filtering, final regression testing and several native browser checks remain incomplete.

Read this file, `AGENTS.md`, and the relevant sections of [the interaction comparison](onshape-ui-comparison.md) before continuing. Checked items below mean implemented, with the stated evidence; unchecked items are work for the next run. Historical test results are not a fresh verification of the current checkout.

## Checkout and starting point

- Workspace: `/home/hugo/Projects/Cad-shape`.
- Branch at handoff: `claude/parametric-featurescript-system-jptbr5`.
- HEAD at handoff: `86f1754f`, `feat(app): add automation, timelines and desktop export workflows`.
- There are many modified tracked files and new untracked source/test files. Preserve them. Desktop export, the document-version fix and matrix property formatting are already in HEAD; the later console, component, annotation, timeline, cube and selection revisions include uncommitted work. Earlier chat statements that “nothing is committed” do not describe the entire checkout now.
- Current `package.json` starts development on **8081**, despite the 8080 example in `AGENTS.md`. Use the actual server output. Production must retain `next build ... --no-mangling` because serialized classes depend on their names.
- Use a new review document or a fresh copy of `/?template=end-cap-configurator`; preserve the user's working document and preferences.
- For collaborative browser testing, use T3 `preview_status`, then `preview_open` when necessary. Distinguish real pointer/keyboard interactions and screenshots from dispatched events, mocked tests or rasterized DOM.

## First priorities

- [ ] Re-run the final selection, measurement and construction-dash tests, then the broader regression suite. The last broader run preceded the final duplicate-distance-row change and two test adjustments.
- [ ] Reproduce and classify the three previously reported failures below. Do not call the suite clean or label a new failure pre-existing without evidence.
- [ ] Complete the native browser checklist, especially point/curve selection, plane re-picking, measurement hover guides, annotation dragging and screenshot comparison.
- [ ] Finish command-window recording as FeatureScript or a persistent replayable modeling operation, rather than treating the current text log as that feature.
- [ ] Add independent export color filtering if completing the user's “colors/layers” request; preserve the working construction, external-reference and layer filters.
- [ ] Update this checklist and the comparison with exact test outcomes and retained screenshot paths. Make commits or publication only when requested; this handoff request does not ask for either.

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

- [ ] **Selection:** outside sketch edit, click two endpoints and a center without modifiers; each highlights alone. Click a selected point/curve again to remove it. Repeat with construction lines, arcs and overlapping points/curves, at several zooms. Blank click clears; Ctrl+Z restores; redo clears; a second empty blank click adds no undo entry. Confirm selecting ordinary bodies/tree rows and switching tools still works.
- [ ] **Hit area:** click about 13 px from a point at multiple zoom levels; verify it wins over its neighboring edge without making densely spaced points impossible to choose.
- [ ] **Measurement:** two points show one distance guide/value and the appropriate components. Use lines/arcs with different min/max/center values; hover each available row and verify correct endpoint markers, dashed segment and value; leaving restores the main trace; changing/clearing selection removes stale geometry. Each variable button must create the measurement for that row.
- [ ] **Equal distances:** test curves whose min/max/center values happen to match. Current deduplication applies to all entity types, although its comment describes two points. Check that omitting a same-valued row does not remove a useful distinct guide the user expects. Treat this as a potential edge case until reproduced.
- [ ] **Plane re-pick:** open a sketch; click/clear the plane box; pick a datum, offset plane and real solid face; verify tracked reference, solve, camera turn, undo/redo and save/reopen. Exercise Escape, second-click cancellation and finishing the sketch during a pick; subsequent tools must receive the restored handler.
- [ ] **Timeline/components:** overflow scrolling, open and closed group dragging, valid reorder plus undo/redo, invalid dependency refusal, +/− rail, single tree history bar, matching colors, three-owner/overflow lanes, and rollback-before-editor on tree/timeline double-click. Plain folders have no activate ring; components nest, scope the timeline, receive new parts and return to their parent.
- [ ] **Annotations:** place all kinds on a comparable model; capture readable labels in light/dark themes and multiple views; select lines and frames, drag unlocked frames, undo/redo, lock, style one/multiple/all, and save/reopen. Remove demo overlaps before comparing with the user's reference. Earlier evidence composited the WebGL frame with HTML labels and contained overlapping placements.
- [ ] **Cube/dashes:** corner hit targets reach the expected isometric view; hidden-face labels never show through; white facing face/corners and grey others match the reference; animation frames advance. Zoom construction curves across several scale bands and verify density, selection and custom preference preservation.
- [ ] **Chrome/menus/console:** cog stays in front and closes correctly; document-tab actions work; visibility-condition editor matches the requested menu and persists changes; narrow sidebar wraps fields; divider and console resizing retain usable bounds; suggestions/Tab/help/expression preview/history work; sidebar toggle is square and functional.
- [ ] **Exports/desktop:** inspect real DXF/SVG output for construction/external/layer selection, units and colors; check drawing format paths. With the helper running, open a supported file in a real detected CAD app, reveal it, exercise auto-open on/off and bridge-unavailable fallback. Dummy launcher tests do not prove a CAD importer accepts the file.

## Automated checks and known failures

The last reported broad run for selection work was **6,595 passed and 3 failed** across core/ui/three/app/parametric. It happened before the final deduplication and test adjustments. After those adjustments, the construction-pick and measurement-control files reported **5 passed, 0 failed**. Type check and changed-file Biome checks were reported clean. The earlier **9,593 passed, 3 failed** full run belongs to an earlier annotation revision, not the final checkout. No new code tests or production build were run while writing this handoff.

Previously reported failures, recovered from the prior run's output:

1. `packages/ui/test/elementWorkspace.test.ts` — `the Variable Studio element > shows the variables editor bound to the studio, full-size`.
2. `packages/ui/test/elementWorkspace.test.ts` — `the Variable Studio element > a studio row the parameter table shadows is marked, and keeps its own value`.
3. `packages/ui/test/geometryPanel.kernel.test.ts` — `part mass and all nine moments apply density with correct dimensions`.

- [ ] Reproduce these exact failures and record current assertion messages. Determine whether production behavior or test expectations are wrong; do not simply suppress them. Earlier `packages/ai` type errors were attributed to concurrent work, but later reports were clean, so they are not an established current blocker.
- [ ] Run targeted checks first:

```bash
npm run typecheck
npx rstest packages/core/test/nodeSelectionEventHandler.test.ts packages/ui/test/selectionMeasurementControl.test.ts packages/parametric/test/sketch/constructionPick.kernel.test.ts
npx rstest packages/ui/test/elementWorkspace.test.ts packages/ui/test/geometryPanel.kernel.test.ts
```

- [ ] Run the integration groups affected by this batch:

```bash
npx rstest packages/core/test/partStudioTimeline.test.ts packages/core/test/componentContext.test.ts packages/ui/test/timelineReorder.test.tsx packages/ui/test/treeActivate.test.ts packages/ui/test/treeOwnerLanes.test.ts packages/app/test/commands/component.test.ts
npx rstest packages/core/test/pmiAnnotation.test.ts packages/three/test/threePmiAnnotation.test.ts packages/three/test/threeViewPmiLabels.test.ts packages/app/test/commands/annotation/pmiCommands.test.ts
npx rstest packages/core/test/displayScale.test.ts packages/three/test/viewGizmo.test.ts packages/parametric/test/sketch/sketchPanel.plane.test.ts packages/parametric/test/sketch/sketchDrawingOptions.test.ts
npx rstest packages/ui/test/consoleEngine.test.ts packages/ui/test/commandWindow.test.tsx packages/ui/test/documentTabMenu.test.ts packages/ui/test/configurationVisibilityEditor.test.ts packages/ui/test/matrixProperty.test.ts packages/ui/test/exportDelivery.test.ts packages/core/test/desktopBridge.test.ts packages/core/test/documentSchema.test.ts
```

- [ ] Run `npm test`, `npm run check:ci`, `npm run build`, then `npm run preview` and smoke-test the exported build. Do not infer current production success from older builds. If making a commit, follow `AGENTS.md` and run `npm run check` before committing; it auto-fixes files, so review its changes.
- [ ] Keep complete command output and exit status. Earlier checks often piped to grep/head, which can hide failures or the underlying command's exit status.

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

> Continue the CAD UI work in `/home/hugo/Projects/Cad-shape`. Read `docs/next-run-handoff.md` and `AGENTS.md` first, preserve the dirty working tree, and follow the priority/test checklist. Most features are implemented; FeatureScript recording and independent color export filtering remain partial, while final regressions and native browser/screenshot checks remain open. Do not reimplement finished work or claim old test results verify the current checkout. Update the handoff with exact outcomes and remaining items.

If more historical detail is needed, the source T3 thread is `9f641e63-29cd-4ce1-a361-594bedebee52`. Its messages view contains the requests and completion reports; its activity view contains the test output. Later corrections supersede earlier component, plane-picker, cube-label and dash descriptions.
