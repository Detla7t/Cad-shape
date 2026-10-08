# Chili3D production readiness and UX improvement plan

Bring the existing CAD/CAM system to production through complete, validated user workflows. Improve UX in every milestone: clearer modeling state, predictable interaction, responsive computation, recoverable failures, and trustworthy manufacturing output. Keep TypeScript, OCCT, Three.js, Rust, Rspack, Rstest, Biome, and npm workspaces.

The starting point is the audit of committed branch HEAD `285cb7e2`. It passed the existing 8,055 tests and the isolated production build and lint checks. Additional probes reproduced three CAM freshness/validity defects and a gap in disposal of replaced final shapes. The audit also identified a machining mesh accuracy gap. These findings establish priorities; they do not establish completion of any milestone below.

## First production release scope

The first production release includes the complete suite requested by the product owner: 2D, 3D, sheet metal, CAM, PCB, document editing and viewing, full version control, easy importing, parametric tools, easy expansion, and FeatureScript compatibility with Onshape's own standard-library source. None of these areas is deferred to a later production release. Internal builds and betas can deliver these areas incrementally.

There is no fixed deadline. Progress follows dependencies, measured quality, and exit criteria at the pace required. Milestones describe evidence and deliverables, rather than weeks or promises of team capacity.

| Required area | First-release workflow | Qualification evidence |
| --- | --- | --- |
| 2D | Draw, constrain, dimension, edit, import, and export sketches and technical drawings | Solver/reference cases, drawing visibility and dimensions, browser editing journeys, round trips |
| 3D and parametric tools | Build and edit feature chains, variables/configurations, imported parts, assemblies, and linked components | Adversarial topology edits, reference geometry, undo/rebuild/save journeys |
| Sheet metal | Model, edit, unfold/refold, create flat patterns, and prepare manufacturing output | Thickness/bend/relief cases, flat-pattern comparisons, measured fabricated samples |
| CAM | Set up, generate, inspect, regenerate, and post the supported milling, cutting, EDM, and additive workflows | Accuracy budgets, independent checks, qualified machine/post pairs and manufacturing trials |
| PCB | Create or import schematic/net connectivity, place components, route and fill a board, run rule checks, and export fabrication/assembly files | Connectivity and DRC fixtures, independent output inspection, fabricated reference board |
| Documents | View supported files and edit supported text, rich-text, and spreadsheet formats within the project | Format/fidelity matrix, edit/save/reopen cases, clear handling of unsupported content |
| Version control | Commit, branch, compare, merge, resolve conflicts, create versions, restore, and maintain revisioned links across the whole project | History integrity, merge/conflict journeys, cross-workspace reference consistency, portable recovery |
| Importing | Bring supported CAD, drawings, meshes, PCB, and office files into the appropriate workspace through one coherent flow | Content detection, units/placement checks, malformed-file handling, preserved originals |
| FeatureScript | Run unmodified standard-library source and compatible custom features against explicitly supported Onshape std versions | Language, built-in, geometry, query/history, feature UI, and versioned differential conformance |
| Expandability | Add features, operations, posts, importers, and workspaces through documented extension contracts | External sample extensions, dependency/lifecycle checks, compatibility across an upgrade |

Keep a capability matrix with experimental, beta, production, and unavailable states for individual features, browser combinations, file-format operations, machines, and posts. This makes implementation gaps visible during development. It cannot be used to reclassify a required first-release area as optional to pass the release gate. Specify concrete supported operations and tested limits within each area; broad labels such as “CAM supported” are insufficient.

PCB is a new product workstream: the audit did not find an implemented PCB workspace. Document viewers and editors already exist, but their round-trip fidelity needs qualification. FeatureScript has substantial foundations and existing conformance tests; parsing the bundled modules and passing documented examples does not establish the requested 1:1 compatibility.

“Full version control” means the complete project history workflow above, including files, source, boards, configurations, and cross-document links. Add portable history and a storage/synchronization boundary. Real-time simultaneous coediting is a separate product decision; do not claim it from the existence of branches and merges.

For PCB, the planned complete journey includes schematic/netlist input through board manufacture. Start with the electrical data contract and board editor, then qualify schematic authoring and interchange as part of that journey. Circuit simulation is a separate capability and is not implied by PCB layout.

## Architecture and stack direction

Keep the current interface-driven workspace architecture. Add shared contracts for validity, revision dependencies, native-resource ownership, persistence, extension lifecycle, and geometric precision. Avoid creating a separate implementation of these concepts in every new workspace.

| Change | Reason and boundary |
| --- | --- |
| Browser acceptance tests alongside Rstest | Test actual selection, focus, editing, save/reopen, and workspace transitions; retain fast unit and kernel coverage |
| Revisioned worker jobs for pure computation | Improve interaction latency while preserving trustworthy results; start with CAM, then PCB rule/fill work and profiled bottlenecks |
| Explicit domain, UI, and bootstrap exports | Make worker/headless use possible and enforce package dependency boundaries in CI |
| Versioned document schemas and runtime provenance | Preserve projects and reproducible rebuilding through application, kernel, and std upgrades |
| A dedicated PCB package and electrical model | Nets, layers, pads, routing, and electrical rules require their own domain; reuse the 2D kernel and rendering infrastructure where suitable |
| A conformance harness around the existing FeatureScript interpreter and bridge | Close measured compatibility gaps without replacing working language infrastructure speculatively |
| Portable repository storage adapters | Extend local project history to durable exchange and eventual shared storage without coupling the model to a service |

Retain the custom reactive UI and CSS modules while improving the interaction contracts and shared controls. Consider a UI-framework migration only if a measured problem remains expensive after these changes. Move additional algorithms into Rust when profiling and boundary costs justify it; preserve OCCT in C++ for B-rep operations. Keep heavy format libraries and optional workspaces lazy. These choices improve maintainability without making a stack rewrite the prerequisite for better UX.

## Development cadence

- Allocate roughly 60 percent of capacity to reliability, performance, persistence, and qualification, and 40 percent to UX and workflow improvements. Tests and documentation belong within both allocations. Rebalance when a release-blocking defect appears.
- Give each milestone a named engineering owner and a UX acceptance owner. One person can fill both roles; do not assume separate teams.
- Deliver changes as small vertical slices with the model behavior, UI state, tests, and recovery behavior reviewed together. For example, stale-result detection and its actionable CAM status should ship together.
- Hold a workflow review after each meaningful delivery using real projects and a short usability trial. Record task completion, selection mistakes, recovery attempts, and interaction delays. Review the task, rather than only the screenshot.
- Include one visible UX improvement in each milestone. Reserve time for keyboard access, contrast, labels, empty states, and compact displays as normal delivery work.
- Use short-lived branches and small PRs against the actual integration branch. Set CI triggers to match that branch; do not assume the documented `dev` branch is already in use.
- Preserve the sidebar, Parts, configuration, sketch, and navigation improvements already underway. Integrate and validate them as the UX baseline before redesigning those areas again.

## Milestone 0 Establish the baseline and release contracts

**Engineering work**

- Integrate the current UI work into a passing build without folding unrelated implementation changes into it.
- Add CI gates for deterministic `npm ci`, read-only Biome checks, the production build including plugins, the existing tests, and native Rust tests. Add an explicit typecheck command if it makes feedback faster than the build.
- Add a browser test harness with a clean user profile, repeatable fixtures, console-error checks, and save/reopen support. Keep Rstest for unit and kernel tests.
- Record compiler, kernel, standard-library, and generated artifact versions. Rebuild and test WASM when its sources change; use cached native toolchains where needed. Establish artifact provenance before making a full C++ rebuild mandatory on every PR.
- Create the capability matrix and a shared benchmark corpus. Include a constrained bracket, a sheet-metal duct, a pocketed milling part, a curved surface, and an assembly with linked parts.
- Add a reference PCB, an imported mixed-format project, a rich-text document, a formula spreadsheet, and a project with branches and merge conflicts. Inventory every std export and host built-in required by the pinned Onshape library, and start the compatibility ledger here.
- Measure startup, interaction latency, rebuilds, CAM generation, memory, and task completion on declared reference hardware.

**UX work**

- Establish consistent selection, Escape, Enter, accept/cancel, viewport navigation, and undo behavior across the workspaces included in release scope.
- Validate the current resizable Features/Parts sidebar, configuration controls, toolbar context, and saved layout preferences.
- Create a compact interaction specification describing these behaviors, including keyboard focus and error placement.

**Exit criteria**

- Required checks run on the integration branch and its PRs, and a failing build blocks merge.
- Benchmark fixtures and results are reproducible.
- A browser test completes sketch, extrude, edit, undo/redo, save, and reopen.
- Current UX work passes its own interaction checks and the common journey.

## Milestone 1 Make model and CAM state trustworthy

**Engineering work**

- Introduce an evaluation-state contract that separates requested revision, last successful geometry revision, evaluation status, and displayed last good geometry. Extend the core interfaces without making core depend on parametric or CAM packages.
- Include geometry, world placement, relevant ancestor placement, referenced selections, stock, tools, machine settings, and evaluation validity in CAM dependency snapshots.
- Capture immutable inputs before a generation run. Publish its result only for the matching revision. Superseded jobs must stop where supported, or finish without replacing current results.
- Handle suppression, deletion, undo/redo, document closing, and node replacement while generation runs. Repair the watch lifecycle as well as the cache key.
- Block posting when a required part has a failed or pending rebuild, or an operation is stale, running, failed, or missing.
- Fix ownership of replaced final shapes. Verify disposal across rebuild, rollback, failed rebuild, undo/redo, and document closure.

**UX work**

- Show clear Ready, Computing, Changed, and Failed states on features and CAM operations.
- Explain when displayed geometry is the last successful result. Keep the failing feature reachable and offer parameter editing or reference repair from its error.
- Preserve the previous preview while computing, visibly identify it as outdated, and explain why posting is unavailable.
- Make generation feedback immediate and cancellation discoverable. Preserve selection and viewport framing through refreshes.

**Exit criteria**

- The audit regression scenarios pass: moving a part invalidates CAM; a mid-run edit cannot bless old output; a failed CAD rebuild prevents posting; replaced final shapes are released.
- Browser tests verify the visible state and recovery path for each case, including undo and document switching.
- Closing a document leaves no job capable of publishing into it and no retained owned final shape from the tested lifecycle.

## Milestone 2 Protect saved work and complete version control

**Engineering work**

- Add schema migrations and stable serialized type identifiers with aliases for existing class-name identifiers. Separate application version from document schema version.
- Save and validate regeneration provenance, including kernel and FeatureScript standard-library versions. An unavailable required runtime must produce an explicit compatibility state rather than silently regenerate with a different dialect.
- Resolve IndexedDB writes on transaction completion and handle aborts and quota failures. Coordinate document, history, and link-cache records so a saved revision can be restored consistently.
- Add recovery autosaves separate from the user's explicit saved/versioned checkpoint. Define how recovery affects followed document links so an autosave does not unexpectedly update another document.
- Handle uncommitted Feature Studio and document-editor text in recovery and navigation. Define save/close behavior explicitly for these buffers.
- Maintain a golden project corpus covering older schemas, attached files, configurations, linked parts, missing sources, and unknown extension folders.
- Qualify commits, branches, named versions, diffs, three-way merges, conflict resolution, and restore across every workspace. Include Feature Studio source, PCB objects, attached files, and CAM setup/tool/post definitions in history; regenerated caches must not masquerade as authored changes.
- Use stable object identifiers and semantic diffs where available. Keep competing edits to the same object explicit, and offer an honest file/text conflict for content without a safe semantic merger. A merge must never silently discard one side.
- Revalidate geometry, electrical connectivity, linked revisions, and generated output after merge or restore. Preserve the source history and make an interrupted merge recoverable.
- Provide portable export/import of complete history and verify it in a fresh profile. Define a repository storage adapter and synchronization protocol with atomic publication, revision/concurrency checks, and retry behavior before implementing remote storage. Qualify authentication and access controls if a hosted/shared repository is offered.

**UX work**

- Show dirty, saving, saved, and save-failed states with a useful recovery action.
- Offer recover, compare, or discard after interrupted work. Never replace the last explicit save with a recovery candidate without a clear user choice.
- Explain missing link sources and show the saved linked geometry with its revision.
- Make close/cancel behavior consistent and communicate what is preserved in unsaved editor buffers.
- Make the active branch and working changes visible. Provide useful geometry/source/file comparisons, understandable conflict choices, and a preview before restore or link update. Distinguish undo, recovery, commits, and named versions in the UI.

**Exit criteria**

- Older supported fixtures migrate and retain expected geometry and document content.
- Save-abort, storage-full, reload, and missing-source tests preserve the last committed project.
- A recovery journey restores the tested model and editor changes after interruption.
- An autosave does not advance a linked consumer's followed saved revision.
- A user can branch a mixed CAD/PCB/document project, edit both branches, resolve conflicts, merge, restore, and reopen with correct references and generated-output validity.
- Complete history survives portable export/import. Any implemented synchronization path passes interrupted transfer and concurrent-update tests without lost commits.

## Milestone 3 Improve responsiveness and modeling interaction

Milestone 1 is a prerequisite for asynchronous result publication. Independent startup and interaction improvements can begin earlier.

**Engineering work**

- Load optional plugins on use. Separate pure domain exports, UI exports, and registration/bootstrap entry points so worker and headless consumers avoid UI initialization.
- Move pure CAM mesh processing and surfacing into a worker through revisioned jobs. Define buffer ownership, progress, cancellation, shutdown, and bounded concurrency before adding a worker pool.
- Avoid detached-buffer bugs when transferring data shared by multiple operations. Cache immutable inputs in the worker or transfer dedicated owned buffers.
- Profile variable/data invalidation and reduce unnecessary rebuilds by tracking actual dependencies. Preserve conservative invalidation for dynamic FeatureScript dependencies until tracked safely.
- Measure long-session resource behavior and repeated rebuilds. Benchmark C++ size-oriented versus speed-oriented compilation before changing optimization flags.
- Design the larger OCCT worker boundary around worker-owned shape handles and asynchronous scheduling. Implement it only after measuring the remaining UI blocking and validating its lifecycle and memory costs.

**UX work**

- Improve per-point and partially constrained sketch feedback; retain color-independent indicators and legible light/dark themes.
- Improve dimension inference, repeated dimension entry, and batch constraints for supported geometry.
- Tune selection disambiguation, hover feedback, camera navigation, and selection pivots against real modeling tasks.
- Keep tool context, selection, and editing state stable during background work. Avoid repeated modal alerts for expected errors.

**Exit criteria**

- The viewport and basic interaction remain usable during reference CAM jobs.
- Superseded jobs cannot overwrite results, and cancellation stops supported work without leaving inconsistent state.
- The reference sketch and feature-edit tasks show measurable improvement in latency or task completion, with no geometry or undo regression.
- Resource use reaches a stable range after repeated edit/close cycles on the declared corpus; suspected growth is investigated before qualification.

## Milestone 4 Complete and qualify every required workspace

The workstreams below can advance alongside the shared milestones. Their release gates all remain mandatory. Start PCB domain design and FeatureScript conformance inventory in Milestone 0; they must not wait until the other workspaces are finished. Shared evaluation, storage, and job contracts constrain how their results enter the project.

**Engineering work**

- Add machining tessellation with an absolute error budget separate from the display mesh. Cache by geometry revision and requested precision. Account for meshing, toolpath approximation, simplification, and post rounding in the total error budget.
- Test against independent analytic geometry and reference outputs, not only the same mesh or algorithm used by generation.
- Expand adversarial CAD edits: split/merged edges, near-degenerate geometry, changed sketch topology, suppression/reorder, broken references, failed features, configurations, and units.
- For sheet metal, validate material thickness, bend allowance, reliefs, hems/seams, flat patterns, kerf, leads, and tabs against reference parts and measured fabrication samples.
- For 2.5D milling, validate stock/WCS, tool dimensions, depths, retracts, entry/link moves, holes, islands, and clearance on the chosen parts and machines.
- Qualify specific machine/profile/post combinations with golden programs, independent review or simulation, and controlled physical trials. Code-generation goldens alone do not qualify a machine.
- Complete drawing HLR visibility, partial-edge extraction, and curved silhouettes; validate dimensions and exported geometry. Technical drawings are part of the required 2D workflow.

**UX work**

- Make setup creation a coherent flow: machine, parts, stock, WCS, tools, operations, generate, review, and post. Allow experienced users to edit those sections directly.
- Highlight the WCS, stock, chosen geometry, cutting direction, and clearance. Explain unsupported combinations at the point of selection.
- Provide recoverable selection/reference errors and visible units and tolerance values.
- Show the chosen post, generated revision, file name, and relevant setup details before export. Distinguish toolpath playback from validated material-removal or collision simulation.
- Make flat-pattern export and cutting preparation easy to repeat after design changes.

### 2D, sketches, and technical drawings

- Qualify supported sketch entities, constraints, dimensions, trim/extend, projections, and DXF/DWG import through edit and export. Cover underconstrained, overconstrained, conflicting, and degenerate cases with correct solver feedback.
- Complete drawing views, sections and annotations in the declared drawing feature matrix. Test hidden-line visibility, curves, units, scale, and dimension attachment after model edits.
- Pair this work with easy repeated drawing/dimension entry, inference, clear constraint diagnostics, visible snapping, and consistent keyboard acceptance/cancellation. Let the user find the responsible constraint or lost reference directly.
- Gate: a user imports or draws a profile, constrains it, edits a driving dimension, uses it in a model, and exports a dimensioned drawing with independently checked geometry. Representative difficult edits preserve valid constraints or expose a recoverable failure.

### 3D, parametric modeling, and assemblies

- Publish and qualify the complete intended feature inventory, including supported extrudes, revolves, sweeps/lofts, patterns, booleans, shells, fillets, chamfers, and direct edits. Track genuinely missing operations as implementation work.
- Qualify variables, expressions, configurations, data-driven parameters, feature ordering/suppression, and imported geometry. Exercise stable references across split/merged topology and failed upstream edits.
- Include local and linked assemblies, placement, supported mates/limits, and deliberate source-version updates. Validate restored and merged assemblies as well as fresh ones.
- Pair this work with consistent feature panels, previews, selection filters, reference repair, feature discovery, and clear variable scope/units. Keep the current Features/Parts and configuration work moving through these tasks.
- Gate: representative multi-feature parts and assemblies survive adversarial edits, undo/redo, configuration switches, source updates, save/reopen, and version restore with independently checked geometry and placement.

### Sheet metal

- Qualify the flat-first model and supported bends, reliefs, hems, seams, flanges, rolls, crimps, beads, and edge treatments. Make transitions that end the sheet-metal chain explicit and reversible.
- Specify material properties and bend conventions, validate formed versus flat geometry, and track how manufacturing changes affect associated CAM and drawings.
- Pair this work with easy formed/flat switching, selectable bend/treatment controls, visible bend direction and allowance, useful errors, and a direct route to cutting preparation.
- Gate: the reference sheet-metal projects regenerate and export accurate flat patterns after edits; fabricated samples agree with the declared allowance and tolerance conventions.

### CAM across supported manufacturing families

- Use separate qualification matrices for 2D/2.5D milling, 3D surfacing, indexed and simultaneous five-axis, profile cutting, wire EDM, and additive workflows. Define supported operations and qualified machines/posts within each family; treat the existing implementations as candidates requiring evidence.
- Validate collision/clearance behavior, kinematics, axis conventions, retracts, leads, stock state, EDM taper/skims, and additive extrusion/travel parameters as applicable. Distinguish a visual preview from checked simulation.
- Validate local slicer-bridge setup and failure recovery if used. Keep generated programs and imported/exported slicer projects tied to their source revision and settings.
- Pair this work with reusable setup/tool libraries, sensible operation defaults, explainable invalid/stale states, progress/cancellation, and geometry picking that stays consistent across operations.
- Gate: every manufacturing family included in the release matrix has independent output checks and controlled physical trial evidence for its qualified machine/post combinations. An upstream edit cannot leave publishable outdated output.

### PCB and electronic/mechanical integration

- Add a PCB workspace with stable IDs for components, footprints, pads, nets, tracks, vias, zones, board outlines, layers/stackup, and rules. Store authored electrical objects in project history; derive connectivity, fills, 3D previews, and manufacturing files from revisioned snapshots.
- Implement the schematic/netlist-to-board flow, component and footprint library handling, placement, routing, vias, copper fills, and electrical/design-rule checks. Establish schematic authoring and supported interchange in the feature matrix; a board viewer alone does not satisfy this workflow.
- Reuse the Rust polygon kernel for suitable clearance/fill geometry, while keeping the electrical connectivity graph and rule semantics in the PCB domain. Use workers for expensive fills/checks and invalidate their results on relevant edits.
- Link the board outline, holes, and component envelopes into the 3D assembly/enclosure workflow. Preserve intentional revision pinning and expose mechanical clashes and stale linked geometry.
- Generate and independently inspect Gerber, drill, BOM, and placement outputs, with explicit layer, origin, side, units, and component orientation conventions. Use established PCB tools as interoperability checks; [KiCad's PCB documentation](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html) provides a concrete reference workflow for routing, DRC, and fabrication exports.
- Pair this work with visible ratsnest/net selection, routing constraints, snap feedback, linked board/3D selection, actionable DRC locations, and straightforward output review.
- Gate: create or import a reference electronic design, produce and route its board, repair rule violations, fit it into an enclosure, export checked fabrication/assembly files, fabricate and verify the board, then edit and version the complete project without losing connectivity or references.

### Document editing, viewing, and importing

- Publish a per-format matrix for viewing, editing, exporting, and preservation. Cover the current text/Markdown, rich-text, spreadsheet, PDF/image, CAD/drawing, and mesh readers; add PCB interchange to the same import entry point.
- Preserve original attachments. Qualify text encodings, spreadsheet values/formulas/recalculation, rich-text formatting, images, tables, and supported metadata. Unsupported constructs must be preserved or identified before editing/export; do not silently turn a rich original into a reduced document.
- Treat PDF/image viewing and supported text/rich-text/spreadsheet editing as explicit operations. Do not imply every viewed format is fully editable. Specify further editing features in the matrix before claiming them.
- Validate content sniffing, malformed inputs, units, orientation, assembly structure, external resources, and large-file behavior. Distinguish native editable imports, reference geometry, and files retained for viewing; offer STEP/DXF or other supported conversion routes where native import is unavailable.
- Pair this work with drag/drop and one coherent import flow, destination preview, visible units, clear conversion results, editable/view-only indicators, consistent save behavior, and useful errors. Preserve editor buffers and focus across workspace changes.
- Gate: the mixed-format corpus completes import, view/edit, undo, save/reopen, and version restore with expected fidelity. A spreadsheet-driven model updates after a supported document edit and invalidates dependent CAM correctly.

### FeatureScript 1:1 compatibility and developer UX

The requirement is compatibility with Onshape's own std source, rather than a separate approximating library. Onshape's [standard-library documentation](https://cad.onshape.com/FsDoc/library.html) describes a modeling context and built-in operations beneath that source, while its [import documentation](https://cad.onshape.com/FsDoc/top-level.html) specifies versioned std imports. Loading the source is one layer of compatibility; the underlying language and modeling behavior also need conformance evidence.

- Pin the initial reference std version and checksum; the repository currently bundles version 3083. Execute the unmodified source, preserve its license, and retain compatible older versions needed by saved documents. Establish a deliberate update pipeline for later upstream versions, with conformance results and migration checks before promotion.
- Inventory every exported API and reachable host built-in. Track implemented, conforming, failing, and untested behavior at overload/operation level, including version-dependent branches. No no-op, placeholder success, silently substituted native std, or skipped test can count toward parity.
- Expand language conformance beyond parsing: value semantics, maps/arrays, units, type tags/predicates, overload resolution, imports/shadowing, annotations, preconditions, exceptions/status, and version behavior. Validate editing logic, manipulators, tables, and feature-panel behavior where the std exposes them.
- Qualify modeling built-ins, sketch constraints, query evaluation, attributes, stable entity identity/history, sheet-metal behavior, evaluation functions, and operation failure behavior. Query/topology checks must accompany mass/volume checks: equal volume alone cannot establish compatible custom-feature behavior.
- Build differential fixtures running identical FeatureScript inputs in a legitimate Onshape reference environment and this runtime. Compare values, status, query membership, geometric invariants, references after subsequent edits, and documented tolerance-sensitive outcomes. Keep reference provenance and std version with each fixture; secure reproducible reference access early.
- Define 1:1 as source/API and observable behavioral compatibility for the declared std versions, including documented numerical tolerances. Byte-identical BREP output is not the conformance oracle. Any observable gap remains a release blocker or an explicit product-owner change to the requirement; do not silently narrow parity to the existing example suite.
- Pair this work with version-aware autocomplete and documentation, go-to-definition, useful syntax/runtime errors, examples, a responsive editor, import management, custom-feature installation, and direct navigation between an error and the affected geometry. Bound execution and provide cancellation/isolation for user-written code.
- Gate: all inventoried supported-version APIs and language behaviors have evidence, the differential corpus and representative external custom features pass, and a user can write/install/edit a feature with the expected std imports and parameter UI, then save, branch, merge, and reopen it reproducibly. Publish the remaining uncertainty honestly; untested behavior cannot substantiate a blanket parity claim.

### Easy expansion and extension maintenance

- Document stable contracts for feature handlers, CAM operations/posts, importers, workspaces, parameter UI, serialization/migrations, and extension registration/disposal. Define which APIs are stable and which remain internal.
- Provide small external examples with build/debug instructions and useful type errors. Give extensions scoped access to lifecycle services, dependency tracking, jobs, undo, and storage rather than relying on arbitrary global mutation.
- Add dependency checks for workspace imports and pure entry points. Verify that enabling, disabling, failing, and upgrading an extension cannot corrupt a saved project or leave subscriptions/jobs behind.
- Pair this work with an understandable install/update flow, discoverable custom tools, actionable load errors, and preserved project state when an extension is absent.
- Gate: a developer adds a custom feature, operation or post, and importer through documented contracts without patching core; the examples survive an application upgrade and clean unload. A saved project with a missing extension remains recoverable.

**Exit criteria**

- Every required area in the first-release scope has its supported feature/format/configuration matrix, reference project, automated journey, and independently checked output. Manufacturing workflows also have the required trial evidence.
- The declared geometric error budget holds against the reference geometry.
- An upstream edit invalidates output and the user can regenerate and review it without rebuilding the setup manually.
- A new user can complete the workflow with the prescribed help, and repeated user trials show no unresolved critical interaction trap.
- The integrated reference project passes: design and version a PCB, drive a 3D enclosure with parameters and a compatible FeatureScript feature, create sheet-metal and machined parts, create drawings and manufacturing outputs, maintain the BOM/document files, branch and merge a design change, restore a prior version, and regenerate all affected outputs from correct inputs.

## Milestone 5 Validate the release candidate in real work

**Engineering work**

- Run a controlled beta on actual projects in the qualified scope, including reopen/migration, offline links, recovery, and long sessions.
- Test the declared browser, graphics, and input-device matrix using the production build. Publish supported combinations and tested limits.
- Extend the existing bounded diagnostics where available with job revisions, model validity, build provenance, and timing. Export a useful bug bundle without credentials or project content unless explicitly included by the user.
- Prepare reproducible release artifacts and a rollout/rollback procedure that preserves document compatibility. A rollback must not reopen newer files destructively.
- Give every residual issue an owner, severity, affected workflow, and recovery/workaround description.

**UX work**

- Refine onboarding, sample projects, tool discovery, defaults, shortcuts, and contextual help using beta observations.
- Check keyboard access, focus visibility, screen labels, contrast, compact layouts, and consistent terminology in the qualified workflows.
- Publish the practical workflow guides, supported-feature matrix, limitations, and migration/recovery help alongside the release.

**Exit criteria**

- No unresolved blocker or high-severity correctness, data-loss, or interaction defect remains in the qualified scope.
- Every qualified workflow passes the release corpus on the declared environment matrix.
- At least two consecutive release-candidate validation runs pass the same acceptance suite. These runs supplement, rather than replace, real project and manufacturing trials.
- Any remaining lower-severity issue has an understood impact and acceptable recovery for the released workflow.
- All required first-release areas pass their gates. Additional capabilities outside the agreed matrix may remain clearly experimental; required areas cannot use that label to bypass qualification.

## Initial performance and UX acceptance targets

These are proposed budgets to calibrate in Milestone 0 on declared hardware and representative projects. Treat measured results and user experience as release evidence; do not claim these targets are already met.

| Measure | Initial target | Validation |
| --- | --- | --- |
| Command or generation acknowledgment | Visible feedback within 100 ms at the 95th percentile | Browser timing on the reference corpus |
| Background CAM responsiveness | Basic input feedback within 100 ms at the 95th percentile; viewport at least 30 FPS during interaction on the medium reference project | Timing and frame traces with CAM running |
| Ordinary small-part feature edit | Updated geometry within 1 second at the 95th percentile | Repeated reference feature edits |
| Longer computation | Visible status and progress where measurable; cancellation or a clear stop state | Browser jobs with interruption and supersession |
| Save and recovery | No loss of the last committed revision in injected failures; tested recovery of the working checkpoint | Storage-abort, quota, reload, and recovery tests |
| Geometry accuracy | Within the explicitly allocated total machining error budget | Independent analytic/reference surface checks |
| Performance regression | Investigate sustained degradation above 15 percent from the accepted baseline on controlled repeated runs | Dedicated benchmark job and raw timing records |
| Core workflow usability | No unresolved critical task failure in the prescribed sketch/edit/save/fabrication journeys | Moderated task trials and browser acceptance tests |

Record startup payload and ready-to-model time before setting startup thresholds. Publish project size and hardware assumptions with performance claims. Set explicit task-completion targets after the initial usability trials establish a baseline.

## First implementation backlog

Start the engineering and UX columns together. The rows describe deliverables, not current completion status.

| Order | Engineering deliverable | UX deliverable | Required evidence |
| --- | --- | --- | --- |
| 1 | Integrate current sidebar work; enforce build/lint/test CI | Validate Features/Parts resizing, selection, menus, configuration and layout retention | Passing CI and one saved/reopened modeling journey |
| Alongside 1 | Inventory PCB domain/import requirements and all pinned-std APIs/built-ins; establish reference access | Walk through board creation and custom-feature authoring; record missing interactions | PCB data-contract proposal, std compatibility ledger, reference fixtures and a ranked gap backlog |
| 2 | Evaluation state and immutable revision snapshots | Feature failure and outdated-preview states with recovery actions | Failed rebuild and recovery browser tests |
| 3 | CAM placement/dependency invalidation | Clear Changed status and reason posting is unavailable | Move, parent move, stock edit, undo, suppression and deletion tests |
| 4 | Revision-safe async publication and job lifecycle | Immediate generation feedback, cancel and stable preview | Mid-run edit, supersession and document-close tests |
| 5 | Final-shape disposal and lifecycle repair | Stable selection and view during repeated edits | Ownership tests and repeated edit/close resource measurements |
| 6 | Separate machining tessellation and independent accuracy tests | Explicit precision settings with useful guidance | Analytic sphere/curved-surface and end-to-end error-budget checks |
| 7 | Transaction completion, recovery checkpoint and migration groundwork | Save status, recover/compare/discard and editor-buffer recovery | Failure injection and old-project round trips |
| 8 | Lazy optional modules and first pure CAM worker | Responsive viewport and progress during generation | Before/after reference timings and cancellation checks |

Milestone 2 and independent startup work can overlap after the shared contracts are agreed. Start PCB and FeatureScript gap inventories immediately, then develop their first vertical slices against the shared contracts. Milestone 4 qualification needs trustworthy revisions, persistence, and accuracy; its workstreams need not run serially. Beta trials can start for individual qualified workflows, while the first full production release waits for every required area and the integrated reference project to pass.

## References for implementation

- [Audit regression probes](/tmp/cad-audit-scratch/camFreshness.test.ts) and [probe results](/tmp/cad-audit-head-probes.log). These temporary artifacts should become permanent focused regression tests during implementation.
- [Current interaction comparison](onshape-ui-comparison.md).
- [Project archive format](project-format.md).
- [CAM generator](../packages/cam/src/context/generator.ts), [parametric body evaluation](../packages/parametric/src/parametricBodyNode.ts), and [feature cache ownership](../packages/parametric/src/features/bodyTimeline.ts).
- [Playwright browser test servers](https://playwright.dev/docs/test-webserver) and [visual comparisons](https://playwright.dev/docs/test-snapshots).
- [Worker buffer transfer](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) and [IndexedDB transaction completion](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event).
- [Onshape std APIs and context behavior](https://cad.onshape.com/FsDoc/library.html), [versioned FeatureScript imports](https://cad.onshape.com/FsDoc/top-level.html), and [KiCad PCB workflow reference](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html).
