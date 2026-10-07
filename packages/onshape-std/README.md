# @chili3d/onshape-std

Onshape's FeatureScript standard library — the modules a Feature Studio imports as
`onshape/std/<name>.fs` — packed into one gzipped JSON asset that the app loads at startup.
Feature Studios then run on the real std (see `packages/parametric/src/featurescript/onshape/`):
std's own source, bottoming out in the `@` built-ins this app implements.

- `std/onshape-std-3083.json.gz` — `{ version, license, files: { "<module>.fs": source } }`
  for std version 3083 (276 modules).
- `std/LICENSE.txt` — the std's MIT license (Copyright (c) 2013-Present PTC Inc.).

To move to another std version, unpack it (a directory of `.fs` files, e.g. an
`onshape/std` export or a std mirror checkout) and run

```bash
node scripts/bundle-onshape-std.mjs <std-dir> <version> packages/onshape-std/std/onshape-std-<version>.json.gz
```

then point `src/index.ts` (import and `ONSHAPE_STD_VERSION`) and the parametric test helper
(`packages/parametric/test/featurescript/_helpers/onshapeStd.ts`) at the new file. The
`onshapeStd*.test.ts` suites in `packages/parametric` are the conformance bar.
