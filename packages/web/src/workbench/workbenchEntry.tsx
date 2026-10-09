// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

"use client";

import { LoadingScreen } from "@chili3d/react";
import dynamic from "next/dynamic";

/**
 * The workbench only runs in the browser (WebAssembly, IndexedDB, WebGL): it is loaded on the
 * client and never rendered on the server; the static page shows the loading screen.
 */
export const WorkbenchEntry = dynamic(() => import("./workbench").then((module) => module.Workbench), {
    ssr: false,
    loading: () => <LoadingScreen />,
});
