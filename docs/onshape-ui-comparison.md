# Chili3D and Onshape interaction comparison

Chili3D is closer to the requested sketch workflow, but it does not yet behave exactly like Onshape. The default layout now uses a single context toolbar, original thin-stroke CAD icons, a compact sketch panel, explicit accept/cancel, and inline dimension values. The most noticeable remaining differences are per-point constraint colors, the feature-tree structure, complete tool variants, and the remaining navigation details. This comparison records the current implementation and the next checks needed to make those differences smaller.

Checked on 8 October 2026 against the user's [Onshape Testing document](https://cad.onshape.com/documents/bcf2b0f57a114bba79c81ac1/w/f824c55ae3e3a7f33d2eb028/e/ab12fa5ffe1cc938561b1283), the supplied screenshots, and the local Chili3D build at `http://localhost:8081/`. The second Onshape flow trial used a 1440 × 900 CSS viewport; the final Chili3D captures use 1280 × 800. Toolbar/sidebar dimensions below are measured in CSS pixels. The temporary Onshape sketch was canceled; the document returned to Features (4), Parts (0).

**Evidence:** “Browser” means an interaction was performed or a visible state inspected. “Tests” means automated behavior checks. “Code” identifies implementation differences without claiming a matching browser trial. “Reference” means the user's screenshots. Unchecked comparisons remain explicit.

## Selection and constraints

| Interaction | Onshape | Chili3D now | Verification and remaining difference |
| --- | --- | --- | --- |
| Select several entities | Ordinary clicks accumulate selections; clicking a selected entity toggles it off. | The same behavior now works for curves and points, including the origin. Shift is no longer required. | Browser on both; regression test also covers mixed point and curve selection. |
| Clear selection | A blank click clears selected geometry. Escape did not clear the selected line and circle in the observed trial. | A blank click or Space clears selection. Escape ends an active tool or clears selection and keeps an idle sketch open. | Blank clicks verified in both; Chili3D Space verified in browser/tests. Exact Onshape Space behavior still needs a repeatable trial. Repeated Escape no longer implicitly accepts Chili3D sketch edits. |
| Vertical line | Selecting a diagonal line and applying Vertical made it vertical while preserving its origin attachment. | Vertical and Vertical Align accept a whole line. Align also accepts two points. | Browser: Chili3D line changed from `[180,80,260,380]` to `[180,80,180,380]`. |
| Attach an endpoint to the origin | A line started at the origin retained that attachment after Vertical. | Select the endpoint, select the origin, then Coincident. A second pick can reach the origin even underneath the first endpoint. | Chili3D browser result: `[0,0,0,380]`; automated tests cover overlapping picks and subsequent Alt-drag. Explicit attachment of an already displaced endpoint still needs a separate Onshape trial. |
| Coincident point versus curve | The tool describes a shared location between sketch entities. | Endpoint + point joins those points. Curve + point places the point on the curve; it does not force a particular endpoint to that point. | Chili3D tested in both pick orders. Do not interpret curve + origin as endpoint + origin. The existing-line Onshape pair cases have not all been exercised. |
| Constraint feedback | Constrained line strokes and individual point markers can have different colors. The origin-attached vertical line had a dark stroke and a blue free endpoint. | Entire entities are classified as fully constrained or free. A partly constrained line and its endpoints remain blue until the entity is fully constrained. | Browser/screenshots and code. **Still different:** per-point and partial line coloring. |
| Fully solved state | The examples use dark solved geometry on a light background. | The panel shows Solved or remaining degrees of freedom. Solved entities are dark in light mode and white in dark mode; free geometry uses blue or its layer color. | Browser in both Chili3D themes; tests check mixed fixed and free geometry. White in dark mode preserves the user's requested convention. |
| Conflicting constraints | An invalid mixed selection produced a visible explanation in the trial. | Invalid pairs report an error. A new conflicting constraint restores the previous drawing. Conflicting dimension edits keep the input open. | Onshape browser; Chili3D tests and dimension-dialog browser checks. Different error messages and placement remain. |
| Several lines with one Vertical action | The Onshape tooltip supports one or more lines. | Current line/align commands operate on one line or one pair of points per invocation. | Onshape UI text, Chili3D code. Batch selection behavior is a remaining gap, not a verified match. |

## Dragging and sketch editing

| Interaction | Onshape | Chili3D now | Verification and remaining difference |
| --- | --- | --- | --- |
| Drag a circle edge | Alt-dragging the circumference enlarged the circle while its center stayed in place. | Alt-dragging the circumference changes radius. Existing radius dimensions remain authoritative. | Browser on both; constrained-radius regression test. Previously Chili3D translated the circle from its edge; corrected. |
| Drag a circle center | Center translation is the comparison target; not separately exercised in this Onshape session. | Dragging the center moves the circle and preserves its radius. | Chili3D automated test. Onshape center drag still needs its own recorded trial. |
| Drag lines, arcs and points | Further combinations of fixed and free geometry need direct comparison. | Alt-drag moves free curves/points while solving existing constraints. Alt suppresses new snap constraints. Escape restores the pre-drag geometry. | Chili3D browser and tests, including an origin-attached vertical line and fixed geometry. Do not treat this as complete Onshape drag parity. |
| Drag without Alt | The full modifier matrix has not been compared. | Points can be dragged normally with snapping. Whole-curve dragging requires Alt. | Chili3D code/tests. Mouse and modifier parity remains open. |
| Construction geometry | The toolbar exposes Construction with shortcut Q. Dashed construction lines appear in the supplied examples. | A persistent construction toggle and per-entity styling produce dashed curves. Construction geometry is excluded from modeling profiles. | Onshape toolbar/reference; Chili3D browser and profile tests. Q toggles construction within sketch mode and honors custom shortcut overrides. Its toolbar button reflects the toggle state. |
| Layers and colors | DXF-style sketch layers were requested by the user; this session did not establish equivalent native Onshape layer controls. | Named layers have colors and visibility; entities retain layer/style data through save and DXF conversion. | Chili3D browser/code/tests. This is an intentional addition, not a claimed Onshape match. R12 export approximates RGB colors to its supported palette. |
| Dimension entry | D → select a rectangle edge → place the label opened an input beside the label. Entering `4 in` resized the rectangle. | Select a line with Distance, or select two points, then place its label. An inline input accepts Enter, cancels with Escape/outside click, and validates expressions and conflicts. Double-click an existing label to edit. | Browser on both. Chili3D line length changed to 500 mm; existing radius label reopened inline. Point-fix X/Y still uses a dialog. General D-key inference across all geometry types and the full repeated-dimension workflow remain different. |
| Finish versus cancel | Green accept and red cancel are separate. Cancel removed the temporary new sketch in the trial. | Green check accepts; red X restores the entry data/name or removes a newly created sketch. Escape leaves the session open. | Browser: accepted a dimensioned line, reopened it, added a circle, canceled, and compared the original data byte-for-byte. New-sketch cancellation also removed the node. Tests cover geometry, layers, name, pending picks, and preserving independent node edits. Cancellation is an undoable compensating change; it does not erase the intervening undo history. |

## Layout and rendering

| Area | Onshape | Chili3D now | Remaining difference |
| --- | --- | --- | --- |
| Top tools | A 36 px context toolbar below a 40 px document header. Sketch tools replace modeling tools. | Default: 36 px single-row context toolbar below a 40 px header; canvas starts at y = 76. Undo/redo lead, main tools follow, pinned tools and search remain available. Toolsets live in a header menu. | Browser measurements match the top spacing. The older ribbon remains an option in Customize tools and tabs. Available commands and grouping differ; unimplemented Onshape tools are not displayed as placeholders. |
| Left sidebar | 40 px utility rail plus a 200 px feature tree; canvas begins at x = 246. | 240 px sidebar plus border; canvas begins at x = 241. Name filter preserves ancestors of matches. Empty Properties collapses to its header. | Browser and filter tests. Chili3D still has its own document/body tree; separate Features/Parts sections, rollback presentation and utility rail are not matched. |
| Sketch panel | About 220 px wide, with sketch-plane field, checkboxes, accept/cancel icons. | 216 px panel: name, green check/red X, plane, construction and constraints; layers and help are collapsed; solver status is in the footer. | Browser screenshots. The Chili3D layer controls and explicit DOF status are deliberate additions. |
| Selection color | Orange selected strokes in the live trial. | Gold selected strokes with a soft halo. | Intentional user preference; not an exact color match. Browser verified. |
| Sketch regions | Neutral gray filled closed regions, blue free curves and dark constrained geometry. | Neutral gray closed profiles, adaptive curve segments and separate constraint/selection colors. | Light profile fill was strengthened after screenshot comparison. Overlap and hole behavior are tested; exact visual parity is not claimed. |
| Origin and planes | Small dark origin ring, faint blue bounded plane graphics and labels. | Colored origin point and long muted datum axes. | Noticeable visual gap. A clearer origin marker and bounded named plane graphics should be next. Browser/reference/code. |
| View orientation | Labeled view cube with surrounding rotation arrows. N aligned the active sketch to its plane in the trial. | Labeled beveled cube with six faces, twelve edge targets, eight corner targets, rotation/roll arrows and an isometric button. Right-drag orbits; Ctrl/Command+right-drag pans. | Browser and tests: cube targets, sketch orbit, pan, and normal-view restoration. Exact rotation sensitivity, animated view transitions, view menus and the complete keyboard mapping still differ. |
| Smooth curves | Smooth circle edges in the trial and supplied references. | Adaptive sketch tessellation, finer solid meshing, WebGL antialiasing and increased pixel ratio. | Browser confirmed antialiasing enabled and pixel ratio 1.5. GPU performance and very large sketches have not been benchmarked. |
| Tool customization | Full context-menu customization was not compared in this Onshape session. | Right-click tools to assign shortcuts, pin or add to tabs. Tabs can be created, renamed, hidden and reordered. Preferences persist. | Chili3D browser/tests. These satisfy the user's requested controls; do not label them exact Onshape equivalents. |
| Tool families | Split arrows open labeled menus; choosing Center point rectangle replaced the main rectangle icon, which remained after Escape. The running tool was highlighted. | Families remember their last chosen command; active commands highlight. Menus show names and shortcuts, accept arrow-key navigation and Escape. Full toolset/group menu buttons open on any part of the button. | Browser: selected Horizontal Distance from its family and the main button changed. Tests cover retained command execution, context switching, custom additions and menu keyboard focus. Rectangle/circle/arc currently have one sketch variant each, so they are separate buttons. |

## Second hands-on flow trial

1. Opened the reference in a separate preview, clicked Sketch before choosing a plane, picked Top, and pressed N. Sketch tools appeared immediately and the plane prompt occupied the small floating panel.
2. Opened the rectangle split menu. It offered Corner rectangle (G), Center point rectangle (R), and Aligned rectangle. Selected Center point rectangle and drew with center/corner clicks. The main icon remembered the variant; Escape stopped the drawing tool while the sketch stayed open.
3. Toggled Q and inspected Construction's highlighted toolbar state. This trial established mode toggling, not conversion of a selected edge.
4. Used D on a rectangle edge, placed the dimension label, and entered `4 in` in the inline input. The input was 100 × 26 px and positioned beside the label.
5. Canceled the temporary sketch using the red X. The reference returned to Features (4), Parts (0).

Chili3D now follows that entry sequence: Sketch immediately switches context and offers a plane/face prompt with Top, Front and Right choices. Its dimension tool accepts a whole line or two points. Browser checks covered drawing through toolbar buttons, active-tool highlighting, family selection, inline editing, finish, double-click reentry, and both cancellation cases.

During the final local trial, the preview's native typing/key tools reported success without producing input or key events. Keyboard checks therefore dispatched bubbling DOM keyboard/input events through the page's normal listeners, backed by unit tests. Native mouse clicks and double-clicks were used for the other trials. This is a limit of the verification record, not a claim that physical keyboard input was exercised in that final run.

## View cube and camera trial

The former axis bubbles have been replaced with an original SVG view cube, following the reference's placement, light faces, bevels, labels, small colored axes and surrounding arrows. This uses Chili3D camera state; it does not embed Onshape assets or code.

Onshape was inspected in a separate preview at 1280 × 800. A right-button drag of 120 horizontal pixels changed the displayed orientation from Trimetric to a free view and rotated the cube with it. No geometry was changed in the reference document. Its [official navigation guide](https://cad.onshape.com/help/Content/View/view_navigation_and_the_view_cube.htm) documents right-drag orbit, Ctrl+right-drag pan, clickable faces/edges/corners, and arrow steps of 15° (Shift 90°, Ctrl 5°).

| Check | Chili3D result | Evidence / limit |
| --- | --- | --- |
| Free orbit while drawing | A 120 × 36 px right-drag tilted a top-view sketch. The same Line command and point-pick handler remained active. Camera target stayed at the origin and distance stayed 1892.9613 mm. | Browser DOM pointer-event sequence through the viewport's normal handlers; camera math and routing tests. Physical right-button capture across the application window was not exercised by the preview tool. |
| Pan | Ctrl+right-drag moved the target 169.3116 mm for a 40 × 20 px gesture; camera orientation and zoom distance did not change. | Browser; Ctrl and Command routing tested. Middle-button profile bindings remain available. |
| Constraint picking | Right-drag kept an active Coincident pick. A subsequent stationary right-click canceled it, with identical geometry data before and after. | Browser and viewport arbitration tests. Stationary clicks are delegated to each active tool; the Line tool itself uses Escape to cancel. |
| Cube faces and diagonals | Native clicks on Top, Top–Right edge, and Top–Front–Right corner produced normalized view directions `(0,0,1)`, `(0.7071,0,0.7071)`, and `(0.5774,-0.5774,0.5774)`. | Browser; tests also cover all six named faces, preserving target and zoom. |
| Rotation arrows | Shift-click rotated exactly 90°. | Browser dispatched modifier click; tests cover 15°, 90° and 5°. Curved arrows roll around the view axis. |
| Return to sketch | Normal to sketch restored `(0,0,1)` after orbit. | Browser toolbar click; the existing N shortcut invokes the same command. |
| Visual appearance | Cube inspected in light and dark themes; dark solved geometry remains white. | Native screenshots below. The small lower cube returns to isometric; it is not Onshape's full view menu. |

Remaining navigation differences: snapping is immediate rather than animated; the cube has no saved/named-view menu; keyboard arrow orbit and Onshape's Alt-to-remove-roll behavior are not implemented. Alt+right-drag retains Chili3D's existing world-Z orbit. Free-orbit sensitivity and selection pivot behavior have not been calibrated for exact Onshape parity. The browser connection briefly dropped during this trial and recovered; completed checks above were performed after recovery.

## Screenshots

These are native browser captures, preserved without image editing. Their exported resolution is lower than the CSS viewport size, so use the interaction records above for precise behavior rather than reading small labels from the images.

| Onshape observation | Chili3D review |
| --- | --- |
| [Line and circle selected together](ui-comparison/onshape-selection.png) | [Mixed solved, free and selected geometry](ui-comparison/chili-light.png) |
| [Origin-attached vertical line with a free endpoint](ui-comparison/onshape-vertical.png) | [Dark theme with white solved geometry](ui-comparison/chili-dark.png) |
| [Circle after circumference drag](ui-comparison/onshape-circle-drag.png) | The radius-drag browser check preserved the circle center at `(-160,250)` and changed its radius from `90` to approximately `149.66` mm. |
| [Context toolbar and rectangle trial](ui-comparison/onshape-toolbar-flow.png) | [Rebuilt context toolbar and compact sketch panel](ui-comparison/chili-light.png) |
| [Inline dimension entry](ui-comparison/onshape-inline-dimension.png) | [Inline radius editing](ui-comparison/chili-inline-dimension.png) |
| [Reference view cube](ui-comparison/onshape-view-cube.png) | [Chili3D cube and sketch](ui-comparison/chili-view-cube.png) |
| [Reference after right-drag](ui-comparison/onshape-right-orbit.png) | [Cube in dark theme](ui-comparison/chili-view-cube-dark.png), [normal sketch view](ui-comparison/chili-view-cube-top.png) |

## Next changes in order

1. Match per-point constraint colors and partly constrained line strokes, with independent tests for fixed endpoints and free length.
2. Make the origin easier to identify and add bounded named sketch-plane graphics.
3. Refine the feature tree, separate Features/Parts organization and rollback presentation.
4. Add the missing sketch tool variants and compare repeated dimension commands, general D-key inference, batch constraints and box selection.
5. Calibrate navigation sensitivity and pivots; compare remaining Alt, keyboard-arrow, zoom and center-versus-edge drag behavior.

The current automated regressions cover selection toggles, origin picks, vertical alignment, Coincident pairs, constraint rollback, circle resizing, Alt-drag restoration, construction profiles, layers, shortcut persistence and ribbon interactions. Build and validation results should accompany this comparison whenever the implementation changes; unchecked rows must not be promoted to verified without the corresponding trial.

Validation after the toolbar/flow revision: **7,999 tests passed across 481 files**, `npx tsc --noEmit` passed, and `npm run build` completed including plugins. The build still reports bundle-size warnings. The mixed-geometry screenshot fixture has four fully constrained lines alongside free circles, a free rectangle and a construction centerline; its sketch status is 13 remaining degrees of freedom. WebGL antialiasing was confirmed in the running browser.

Validation after the cube/navigation revision: **8,002 tests passed across 481 files**, `npx tsc --noEmit` passed, and `npm run build` completed including plugins (bundle-size warnings remain). The navigation help and AI tool expectations now report right-drag rotation. Final browser checks used the separate “Camera navigation review” document, with 11 unchanged sketch entities. The local preview server stopped during the final reload; it was restarted, the saved camera-review document reopened, and the updated build checked again ([final native capture](ui-comparison/chili-view-cube-final.png)).
