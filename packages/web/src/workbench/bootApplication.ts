// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// biome-ignore-all lint/correctness/useHookAtTopLevel: AppBuilder's use*() are builder methods, not React hooks.

import { AppBuilder } from "@chili3d/builder";
import type { IApplication } from "@chili3d/core";

/** The full workbench: every module, rendered into `container`. */
export function bootApplication(container: HTMLElement): Promise<IApplication> {
    // prettier-ignore
    return new AppBuilder()
        .useIndexedDB()
        .useWasmOcc()
        .useParametric()
        .useCam()
        .useData()
        .useAssembly()
        .useDocuments()
        .useFabrication()
        .useThree()
        .useUI(container)
        .build();
}
