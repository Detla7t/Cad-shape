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
thumbnail.png              image of the view when saved (optional)
geometry/<node>.brep       BREP caches of shape nodes (optional, off by default, NOT authoritative)
history/                   reserved for the version-control system (owned by its provider)
links/                     cached geometry of linked parts (`@chili3d/assembly`, see below)
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

## Reading rules

- Refused (error, nothing loads): not a zip; no `manifest.json`; manifest not JSON or not an
  object; `format` ≠ `chili3d-project`; `formatVersion` not a positive integer or newer than the
  reader's; `elements`/`files`/`extensions` present but not lists; no or invalid
  `document.json`; a `$file` reference to a missing or non-UTF-8 entry.
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

## Linked parts (`links/`)

A document that links parts of other documents (a linked part in its Part Studio, linked
instances in an assembly) stores the geometry those links currently show, so the file opens
— with its linked parts — where none of the sources exist. The links themselves stay in
`document.json` (source document id, node id, version spec, resolved commit); `links/` is
only their cache, written by the `link-cache` provider (exclusive):

```
links/index.json     { "format": "chili3d-links", "version": 1, "entries": [ {
                         "key": "<doc>@<commit>#<node>", "documentId", "documentName",
                         "commit", "nodeId", "nodeName", "kind": "part" | "assembly",
                         "versionLabel", "parts": [ { "name", "path": "1-1.brep",
                         "transform": [16 numbers], "faceIds"?, "edgeIds"?, "bomKey",
                         "sourceLabel" } ] } ] }
links/<n>-<m>.brep   one BREP per solid of each entry
```

On open the entries go into the link cache (memory and IndexedDB); a link whose source is
reachable then resolves as usual, one whose source is missing shows the cached geometry and a
broken-link state.

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
