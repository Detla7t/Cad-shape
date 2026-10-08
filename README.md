# Chili3D

A browser-based 3D CAD application for online model design and editing.

![Screenshot](./screenshots/screenshot.png)

## Overview

[Chili3D](https://chili3d.com) is an [open-source](https://github.com/xiangechen/chili3d) browser-based 3D CAD (Computer-Aided Design) application built with TypeScript. It achieves near-native performance by compiling OpenCascade (OCCT) to WebAssembly and integrating with Three.js, enabling powerful online modeling, editing, and rendering — all without requiring local installation.

You can access Chili3D online at:

- Official website: [chili3d.com](https://chili3d.com)
- Cloudflare deployment: [chili3d.pages.dev](https://chili3d.pages.dev)

## Features

### Modeling Tools

- **Basic Shapes**: Create boxes, cylinders, cones, spheres, pyramids, torus, and more
- **2D Sketching**: Draw lines, arcs, circles, ellipses, rectangles, polygons, and Bézier curves
- **Advanced Operations**:
    - Boolean operations (union, difference, intersection)
    - Extrusion and revolution
    - Sweeping and lofting
    - Offset surfaces and thick solid
    - Linear and circular arrays
    - Shape checking and repair

### Snapping and Tracking

- **Object Snapping**: Precisely snap to geometric features (points, edges, faces)
- **Workplane Snapping**: Snap to the current workplane for accurate planar operations
- **Axis Tracking**: Create objects along tracked axes for precise alignment
- **Feature Point Detection**: Automatically detect and snap to key geometric features
- **Tracking Visualization**: Visual guides showing tracking lines and reference points

### Editing Tools

- **Modification**: Chamfer, fillet, trim, break, split, sew, simplify
- **Transformation**: Move, rotate, mirror, linear array, circular array
- **Advanced Editing**:
    - Feature removal
    - Sub-shape manipulation
    - Explode compound objects

### Measurement Tools

- Measure angles and lengths
- Calculate the sum of length, area, and volume

### Document Management

- Create, open, and save documents
- Full undo/redo stack with transaction history
- Import/export of industry-standard formats (STEP, IGES, BREP, STL)

### User Interface

- Office-style ribbon interface with contextual command organization
- Hierarchical assembly management with flexible grouping capabilities
- Dynamic workplane support
- 3D viewport with camera controls and camera position recall
- Command context panel integrated into the viewport

### Plugin System

Chili3D supports a runtime plugin system with dynamic loading via URL parameters (`?plugin=`). Example plugins include:

- **helloworld-js** / **helloworld-ts** — Demo plugins showcasing the plugin API
- **macro** — Create, edit, and run macros to automate repetitive tasks
- **visual-programming** — Visual programming with a node-based editor (powered by Rete.js)

### Localization

- **Multi-Language Support**: Built-in internationalization (i18n) with seamless locale switching
- **Current Languages**: Chinese (zh-cn), English (en), Portuguese — Brazil (pt-br)
- Contributions for additional languages are welcome

## Architecture

Chili3D uses an npm workspace monorepo under `packages/` with an interface-driven, pluggable backend architecture:

```
web ──> builder ──> app ──> core
                  ──> i18n ──> core
                  ──> three ──> core
                  ──> ui ──> core + element
                  ──> wasm ──> core
                  ──> storage ──> core

element ──> core
```

- **`core`** — Abstract interfaces (`IShape`, `IShapeFactory`), math (`XYZ`, `Matrix4`, `Plane`), document model, reactive data (`Observable`, `Binding`, `PubSub`), `Result<T,E>`, transactions/undo/redo, commands, serialization, plugin system, service container, UI abstractions
- **`wasm`** — Concrete `ShapeFactory` calling into OCCT via Emscripten bindings
- **`three`** — Three.js viewport, camera controller, visual objects, highlighter, outline pass, gizmo, mesh export
- **`element`** — Custom reactive DOM elements (radio groups, expanders, data converters)
- **`ui`** — Application chrome: main window, ribbon/toolbar, property panels, project tree, dialogs, toast, status bar
- **`app`** — Concrete `Application`, body node classes, command implementations, `CommandService`, `HotkeyService`
- **`builder`** — `AppBuilder` with a fluent `.useIndexedDB().useWasmOcc().useThree().useUI().build()` chain and default ribbon layout
- **`i18n`** — Locale data (en, zh-cn, pt-br)
- **`storage`** — IndexedDB persistence layer
- **`web`** — Entry point: calls `AppBuilder`, shows loading screen, parses URL parameters

## Technology Stack

- **Frontend**: TypeScript, Three.js (0.184)
- **3D Kernel**: OpenCascade 8.0.0 (OCCT) compiled to WebAssembly via Emscripten
- **Bundler**: Rspack 2
- **Linting & Formatting**: Biome (TypeScript), clang-format (C++)
- **Testing**: Rstest + Happy-DOM
- **Package Manager**: npm workspaces

## Changelog

You can view the full changelog [here](https://github.com/xiangechen/chili3d/releases).

For Chinese users, you can also browse the [media](https://space.bilibili.com/539380032/lists/3108412?type=season).

## Getting Started

### Prerequisites

- Node.js
- npm

### Installation

1. Clone the repository

    ```bash
    git clone https://github.com/xiangechen/chili3d.git
    cd chili3d
    ```

2. Install dependencies

    ```bash
    npm install
    ```

### Development

Start the development server:

```bash
npm run dev   # Launches at http://localhost:8080
```

### Building

Build the application:

```bash
npm run build
```

### TypeScript compiler selection

Type checking and declaration generation prefer [ts-rust](https://github.com/pingdotgg/ts-rust)
(`tsc-rs` 0.1.0). Automatic failover tries Go TypeScript, then the retained TypeScript 6 compiler
if a compiler is unavailable, crashes, or exceeds the two-minute timeout. TypeScript diagnostics
fail the check immediately; automatic failover never hides type errors. Each run logs its compiler
and any fallback reason. Rspack/SWC continues to bundle and emit browser JavaScript.

```bash
npm run typecheck          # Rust → Go → TypeScript 6, on compiler failure only
npm run typecheck:rust     # Require Rust, no fallback
npm run typecheck:go       # Require Go, no fallback
npm run typecheck:legacy   # Require the previous TypeScript 6 compiler
npm run typecheck:offline  # Default selection with external networking disabled
npm run build:types -- --compiler go # Select the declaration compiler explicitly
CHILI_TS_COMPILER=legacy npm run dev # Use the retained checker during development
CHILI_TS_COMPILER=go npm run build   # Use Go for application and plugin builds
```

`CHILI_TS_COMPILER=auto|rust|go|legacy` applies to checking, dev, builds, and declarations;
the `--compiler` flag overrides it for `typecheck` and `build:types`. Use `npm run dev` for watched
checking. The build waits for type checking and displays errors in Rspack's diagnostics/overlay.
The watcher also tracks checked files outside the browser's module graph, such as tests.
CI checks with all three compilers explicitly.

Rust currently ships Linux x64 and macOS arm64 binaries; other platforms automatically try Go.
The Go package is installed under the `typescript-go` alias, pinned to
`7.1.0-dev.20260929.1`, the upstream snapshot recommended by ts-rust. `typescript` remains at
version 6 for the legacy compiler and tools using its compiler API. Use the scripts above instead
of a bare `tsc`, since both TypeScript packages export that bin name. Updating ts-rust should include
reviewing its recommended Go version and rerunning all three checks and compiler tests.
Native executables are stored in npm platform packages; no runtime download or Rust/Go toolchain
is needed. `offline:prepare` caches them and tests each supported compiler after a fresh offline install.

### WASM Build (Optional)

The prebuilt WASM module is included in the repository. If you want to build it from source:

1. Set up WebAssembly dependencies (one-time setup):

    ```bash
    npm run setup:wasm
    ```

2. Build the WebAssembly module:

    ```bash
    npm run build:wasm
    ```

### Testing & Linting

```bash
npm run test    # Run all tests (Rstest + Happy-DOM)
npm run testc   # Tests with coverage
npm run check   # Biome lint + auto-fix
npm run format  # Biome + clang-format across all files
```

### Offline development and testing

The app ships its assets locally: OCCT and Rust WASM, Onshape std 3083, icons, fonts,
PDF character maps/fonts/decoders, thumbnail images, and the macro editor including its worker.
PDF support files and thumbnails are checked in with source URLs, licenses and SHA-256 hashes
in `public/vendor/assets.lock.json`. `npm run assets:check` verifies them without downloading.
After intentionally upgrading PDF.js/Ace or replacing the thumbnail sources, run
`npm run assets:refresh` while connected and review the changed assets and manifest.

With Node 24 and dependencies installed, prepare a reusable npm cache once:

```bash
npm run offline:prepare   # Cache locked dependencies in .offline/npm-cache; verify a fresh offline install
npm run offline:verify    # Repeat the fresh-install check using only the stored cache
npm run test:offline      # Full suite with external networking disabled
npm run test:onshape:offline # Replay the captured Onshape reference cases locally
npm run build:offline     # Build the app and plugins without external networking
npm run preview:offline   # Serve dist on 127.0.0.1:8096; browser CSP blocks external asset/API loads
```

The strict offline commands use Linux `unshare` and `ip`, with an isolated network namespace
that retains only loopback for local-server tests. They fail if isolation is unavailable;
the host network and other developers' sessions are unaffected. Keep `.offline/npm-cache`
alongside the checkout to reinstall dependencies with
`npm ci --offline --ignore-scripts --cache .offline/npm-cache`. The cache is specific to the
prepared platform and lockfile; run preparation again after dependency changes. Node and
native build toolchains must already be installed. Normal application tests use checked-in WASM.
For native Rust tests, with Cargo, rustc and a C linker installed, run
`npm run offline:prepare:rust` once to store locked crate sources in `.offline/rust-vendor`
and verify them, then use `npm run test:rust:offline`. Keep `.offline/rust-config.toml`
with that directory; Cargo verifies the vendored crates against their upstream checksums.

Captured Onshape results and their source hashes are stored under
`packages/parametric/test/featurescript/fixtures/conformance/`; replay needs no Onshape login.
Generating new Onshape reference results, following external video links, and refreshing
user-configured remote data sources still require their services. Saved data snapshots remain
available offline. The offline preview deliberately disables browser caching to test a cold load.

### Docker

You can also deploy with Docker:

```bash
docker compose up -d   # Builds and serves the app at http://localhost:8080
```

### 3D Printing with PrusaSlicer (optional)

A CAM Studio printer setup slices in the browser with the built-in slicer, or with your installed
[PrusaSlicer](https://www.prusa3d.com/prusaslicer/) through a small local bridge (the "PrusaSlicer (local)"
operation). Both read the same PrusaSlicer print / filament / printer presets; "Open in PrusaSlicer" exports the
job as a PrusaSlicer project (`.3mf`) instead.

Start the bridge on the computer that has PrusaSlicer (Node.js 18+, no extra packages):

```bash
node scripts/prusa-slicer-bridge.mjs                         # http://127.0.0.1:7781, runs `prusa-slicer`
node scripts/prusa-slicer-bridge.mjs --slicer "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"
node scripts/prusa-slicer-bridge.mjs --slicer "C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer-console.exe"
node scripts/prusa-slicer-bridge.mjs --origin https://your-chili3d-host   # allow a deployed app (dev origins are allowed)
```

`PRUSA_SLICER`, `CHILI3D_BRIDGE_PORT` and `CHILI3D_ORIGINS` (comma-separated) set the same options. The bridge
listens on 127.0.0.1 only, answers `GET /health` with the PrusaSlicer version, and for `POST /slice` runs
`prusa-slicer --export-gcode --dont-arrange --load job.ini --output job.gcode job.3mf` in a temporary directory
and returns the G-code. Set the operation's "Bridge URL" (or the machine's `prusaSlicerBridgeUrl` option) when it
runs elsewhere.

## Code Style

- **TypeScript**: Biome for linting and formatting — 4-space indent, 110-char line width, double quotes, semicolons always
- **C++**: clang-format with WebKit style
- Interfaces prefixed with `I` (`IShape`, `ICommand`)
- `camelCase` functions/variables, `PascalCase` classes, `UPPER_SNAKE_CASE` constants
- Type-only imports: `import type { IFoo } from "..."`
- Pre-commit hooks via simple-git-hooks + lint-staged

## Contributing

We welcome contributions! Please feel free to submit pull requests or open issues.

Before submitting a PR, run `npm run check` to ensure your code passes linting.

## Contact

- **Discussions**: Join our [GitHub discussions](https://github.com/xiangechen/chili3d/discussions) for general chat or questions
- **Issues**: Use [GitHub issues](https://github.com/xiangechen/chili3d/issues) to report suggestions or bugs
- **Email**: Contact us privately at xiangetg@msn.cn

## License

Distributed under the GNU Affero General Public License v3.0 (AGPL-3.0). For commercial licensing options, contact xiangetg@msn.cn.

Full license details: [LICENSE](LICENSE)

The C++ WASM module (`cpp/`) is licensed under LGPL-3.0.

## Analytics Notice

Chili3D uses [Microsoft Clarity](https://clarity.microsoft.com) for growth analytics. To disable data collection, remove the Clarity script from `public/index.html`.

## Disclaimer

This software is provided "AS IS," and the authors and contributors hereby disclaim all express and implied warranties. The user shall bear full responsibility for any and all risks and potential consequences arising from the use of this software. Such risks and consequences include, but are not limited to:

1. Data loss, system failures, or any direct or indirect damages;
2. Conduct violating applicable laws or regulations resulting from software usage and its consequences;
3. All liabilities arising from the software's use for illegal purposes or activities.
