#!/usr/bin/env node
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The PrusaSlicer bridge grew into the desktop bridge (`desktop-bridge.mjs`: it also saves and
 * opens exported files in desktop programs). This name keeps working with the same options.
 */

import { pathToFileURL } from "node:url";
import { main } from "./desktop-bridge.mjs";

export * from "./desktop-bridge.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
