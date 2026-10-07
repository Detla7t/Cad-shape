# The `.chili3d` project file

A Chili3D project is a **zip archive with a manifest**. It replaces the old `.cd` file (one
JSON blob), which still opens. Code: `packages/core/src/project/` (format, pure
`packProject` / `unpackProject`), `packages/app/src/project/projectFile.ts` (zip I/O,
open/save of a live document).

## Layout

```
manifest.json              what is inside (always first)
document.json              the serialized document (Document.serialize()), pretty-printed
featurestudios/<name>.fs   one plain-text FeatureScript file per Feature Studio
data/<name>.snapshot.json  a Data Source's cached tables (JSON, one table row per line)
data/<name>.<ext>          a Data Source's attached file (.csv, .xlsx, .sqlite, …), its real bytes
thumbnail.png              image of the view when saved (optional)
geometry/<node>.brep       BREP caches of shape nodes (optional, off by default, NOT authoritative)
history/                   reserved for the version-control system (owned by its provider)
<prefix>/...               folders of other registered entry providers
```

Paths use `/`, are relative, never contain `..`. Text files are UTF-8.

## manifest.json

```jsonc
{
  "format": "chili3d-project",
  "formatVersion": 1,
  "app": { "name": "Chili3D", "version": "0.7.1" },
  "createdAt": "2026-10-07T12:00:00.000Z",     // kept across saves
  "modifiedAt": "2026-10-07T12:30:00.000Z",
  "document": { "id": "…", "name": "Duct job", "version": "0.7.1" },  // version = document schema
  "featureScript": { "std": "onshape", "version": 3083 },  // only when Onshape's std is in use
  "elements": [                                  // the document's tabs
    { "id": "<root node id>", "kind": "partStudio", "name": "Duct job" },
    { "id": "…", "kind": "featureStudio", "name": "Seams", "path": "featurestudios/Seams.fs" },
    { "id": "…", "kind": "variableStudio", "name": "Variables" }  // any other sceneless node
  ],
  "files": [                                     // every entry except the manifest
    { "path": "document.json", "size": 1234, "sha256": "…", "role": "document" },
    { "path": "featurestudios/Seams.fs", "size": 210, "sha256": "…", "role": "source" },
    { "path": "thumbnail.png", "size": 9876, "sha256": "…", "role": "thumbnail" },
    { "path": "geometry/Body.brep", "size": 4567, "sha256": "…", "role": "cache", "authoritative": false },
    { "path": "history/refs.json", "size": 80, "sha256": "…", "role": "extension" }
  ],
  "extensions": [                                // folders written by entry providers
    { "prefix": "history/", "name": "version-history", "version": 1, "files": ["objects.pack", "refs.json"] }
  ],
  "geometry": { "authoritative": false, "entries": [{ "nodeId": "…", "name": "Body", "path": "geometry/Body.brep" }] }
}
```

`role` is one of `document`, `source`, `thumbnail`, `cache`, `extension`.

## Text-sourced elements

A node class may register a string property to live in its own file
(`registerProjectSourceElement({ className, kind, field, folder, extension })`). Feature
Studios do: in `document.json` their `source` becomes `{ "$file": "featurestudios/Seams.fs" }`
and the `.fs` file is the single source of truth, re-inlined on load (byte for byte, line
endings included). File names are the element name made file-safe and unique
case-insensitively (`Bracket.fs`, `bracket (2).fs`). The reader re-inlines **any**
`{ "$file": … }` node property, so new element kinds need no reader change.

A class may externalize several properties (one registration each; `projectSourceElementSpecs`).
A Data Source keeps its cached tables (`snapshotJson`) and its attachment as files under
`data/`: `extensionOf(node)` names the attachment after its file type, `skipEmpty` keeps an empty
property inline, and `encoding: "base64"` marks a property holding binary content as base64 —
the archive stores the raw bytes and the reference says so, `{ "$file": "data/Shop.sqlite",
"$encoding": "base64" }`, so the reader base64-encodes them back. Secret values (API keys) are
never in these files: a Data Source serializes them only when it opted in to storing them.

## Reading rules

- Refused (error, nothing loads): not a zip; no `manifest.json`; manifest not JSON or not an
  object; `format` ≠ `chili3d-project`; `formatVersion` not a positive integer or newer than the
  reader's; `elements`/`files`/`extensions` present but not lists; no or invalid
  `document.json`; a `$file` reference to a missing entry, or to a non-UTF-8 one without
  `"$encoding": "base64"`.
- Warnings only: a listed file whose size/sha-256 differs (a hand-edited `.fs` is legitimate),
  a listed optional file that is missing.
- Unknown entries and unknown manifest fields are ignored (forward compatibility).
  `formatVersion` changes only for changes an older reader cannot safely ignore.
- Caches under `geometry/` are never read back; Chili3D always rebuilds from the features.
- `document.version` is checked by the document loader as for `.cd` files.

## Extension folders (`ProjectEntryProvider`)

Other modules keep data in the project without touching the writer or reader:

```ts
import { registerProjectEntryProvider, type ProjectEntryProvider } from "@chili3d/core";

interface ProjectEntryProvider {
    readonly prefix: string;        // e.g. "history/" — must end in "/", not a reserved folder
    readonly name?: string;         // listed in manifest.extensions
    readonly version?: number;
    readonly exclusive?: boolean;   // true: write() is the folder's complete content
    write(document: IDocument): Promise<Record<string, Uint8Array | string>>;   // on save
    read(document: IDocument, entries: Record<string, Uint8Array>): Promise<void>; // on open
}
```

- `write` runs after `document.json` is produced; keys are paths relative to the prefix (a
  key that already starts with the prefix is accepted). `read` runs after the document is
  loaded, with the folder's entries keyed relative to the prefix (`{}` when there are none).
- Entries loaded from the file that `write` does not produce again are carried over unless
  the provider is `exclusive`.
- A folder with no registered provider (e.g. `history/` opened without the version-control
  module, or a newer module's folder) is kept verbatim from open to save, manifest entry
  included. If `read` throws, the folder is likewise kept verbatim and `write` is skipped
  for that document. A throwing `write` fails the save with a message. A provider registered
  after the file was opened gets `read` with the loaded entries just before its first `write`.
- `history/` is recognized even if the manifest does not list it.

## Why a zip with a manifest

One JSON file cannot hold binary data (thumbnails, BREP caches, packed history) without
base64 bloat, and it buries FeatureScript in escaped strings that do not diff. SQLite would
give queries and incremental writes, but needs a WASM engine and produces opaque binary
files that neither diff nor open without tools. OPC/3MF-style packages are zips too, but
their `[Content_Types].xml` and relationship parts add ceremony without benefit for a
single-application format; a JSON manifest carries the same index (with sizes and hashes)
and is what the rest of the codebase speaks. A zip opens with any OS tool, stores each part
independently (text compressed, PNG stored), lets other modules add folders without
coordination, and leaves the sources as plain `.fs` files.
