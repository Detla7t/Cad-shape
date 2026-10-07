// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamStudioNode } from "../camStudioNode";
import {
    type MachineKind,
    type MachineProfileData,
    machineProfile,
    machineProfiles,
    registerMachineProfile,
} from "../model/machine";
import generic3Axis from "./profiles/generic-3-axis.json";
import generic5AxisTrunnion from "./profiles/generic-5-axis-trunnion.json";
import genericLaser from "./profiles/generic-laser.json";
import genericPlasma from "./profiles/generic-plasma.json";
import genericWaterjet from "./profiles/generic-waterjet.json";
import genericWireEdm from "./profiles/generic-wire-edm.json";
import grblRouter from "./profiles/grbl-router.json";
import haasUmc500 from "./profiles/haas-umc500.json";
import haasVf2 from "./profiles/haas-vf2.json";
import tormach1100mx from "./profiles/tormach-1100mx.json";
import { userMachines } from "./userLibrary";

export * from "./profileJson";
export * from "./userLibrary";

/**
 * The built-in machine library — plain JSON profiles (`profiles/*.json`), registered when
 * the CAM module loads: mills from a generic Fanuc 3-axis to a Haas UMC-500 trunnion, a
 * GRBL router, and the 2D cutters (waterjet, plasma, laser) and a wire EDM, each with a few
 * default tools. A document's own profiles and the browser's library sit on top of them.
 */
export const BUILT_IN_MACHINES: readonly MachineProfileData[] = [
    generic3Axis,
    haasVf2,
    haasUmc500,
    tormach1100mx,
    grblRouter,
    generic5AxisTrunnion,
    genericWaterjet,
    genericPlasma,
    genericLaser,
    genericWireEdm,
] as unknown as MachineProfileData[];

export function registerBuiltInMachines(): void {
    for (const profile of BUILT_IN_MACHINES) registerMachineProfile(profile);
}

registerBuiltInMachines();

/** Where a profile comes from, most specific first. */
export type MachineSource = "document" | "user" | "library";

export interface MachineChoice {
    readonly profile: MachineProfileData;
    readonly source: MachineSource;
}

/**
 * The profile `id` names for a studio's setups: the document's own copy, else the
 * browser's library, else the registered library (built-ins and other modules' printers).
 */
export function resolveMachine(studio: CamStudioNode | undefined, id: string): MachineChoice | undefined {
    const own = studio?.machines.find((profile) => profile.id === id);
    if (own !== undefined) return { profile: own, source: "document" };
    const user = userMachines.get(id);
    if (user !== undefined) return { profile: user, source: "user" };
    const library = machineProfile(id);
    return library === undefined ? undefined : { profile: library, source: "library" };
}

/** Every profile a studio can pick, deduplicated by id (the most specific wins), by name. */
export function availableMachines(studio: CamStudioNode | undefined, kind?: MachineKind): MachineChoice[] {
    const byId = new Map<string, MachineChoice>();
    for (const profile of machineProfiles(kind)) byId.set(profile.id, { profile, source: "library" });
    for (const profile of userMachines.list()) byId.set(profile.id, { profile, source: "user" });
    for (const profile of studio?.machines ?? []) byId.set(profile.id, { profile, source: "document" });
    return [...byId.values()]
        .filter((choice) => kind === undefined || choice.profile.kind === kind)
        .sort((a, b) => a.profile.name.localeCompare(b.profile.name));
}
