# Modules, loading and repositories

## How the suite loads today

`AppBuilder` starts every module's load (`import()` plus its WebAssembly) the moment `use*()`
is called and runs the inits in order. Since 9 October 2026 a module that throws while
loading or initializing no longer takes the suite down: `build()` catches it, logs it, records
it in `moduleFailures` and shows a toast once the window is up; the other modules keep
going. Only the kernel, the renderer and the storage are required (`ensureNecessary`).

Every module is already its own chunk — the documents, CAM, data, assembly, fabrication
and the Feature Studio editor load lazily — and the element views (drawings, spreadsheets,
the database manager, the FeatureScript IDE) load their libraries only when their tab opens.

## One repository or several?

Recommendation: **stay in one repository** for now, and split a module out only when it has
a release cadence of its own.

- The modules share one type program, one test runner and one lint; a cross-cutting change
  (a new core interface such as `IDependentNode` or `qualityState`) lands in one commit with
  its users. Across repositories that is a publish-and-bump cycle per change.
- Isolation is a property of the *loading*, not of the repository: the builder's per-module
  try/catch, lazy chunks and iframe-embedded editors (see `docs/office-editors.md`) give the
  "a broken area does not kill the suite" behaviour without moving code.
- Each package already has its own `package.json`; publishing them from here (a changeset
  flow) is possible when an internal tool needs to depend on, say, `@chili3d/drawing` alone.

Split out when: a module is maintained by a different team on a different schedule, is used
by other products without the rest of the suite, or has a build (Rust, Emscripten) that
slows everyone else's checkout. The Rust kernels (`rust/`) and the OCCT glue (`cpp/`) are
the first candidates, as their outputs are checked-in artifacts anyway.
