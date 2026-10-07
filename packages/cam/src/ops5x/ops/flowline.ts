// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamOperationContext, CamOperationHandler } from "../../model/operation";
import type { CamOperationData } from "../../model/setup";
import { FaceSampler, polylineLength, type SurfacePoint, sampleRange, sampleRuns } from "../surface";
import {
    COMMON_PARAMETERS,
    type CommonParams,
    ContactPlacer,
    commonDefaults,
    finishToolpath,
    fiveAxisMachine,
    linkPasses,
    num,
    type Pass,
    readCommon,
    str,
} from "./common";
import { ORIENTATION_PARAMETERS, surfacePasses, zigzag } from "./surfaceNormal";

/**
 * Flowline: passes along the iso-parametric curves of each picked face — along U (V steps
 * across) or along V — spaced by the stepover measured on the surface, with the tool axis
 * along the surface normal plus lead and tilt. Points outside a trimmed face split the pass.
 */
export const FLOWLINE_5X_TYPE = "flowline5x";

interface FlowlineParams extends CommonParams {
    readonly direction: "u" | "v";
    readonly stepover: number;
    readonly zigzag: boolean;
    readonly lead: number;
    readonly tilt: number;
}

function readFlowline(operation: CamOperationData, context: CamOperationContext): FlowlineParams {
    const params = operation.params;
    return {
        ...readCommon(operation, context),
        direction: str(params, "direction", "u"),
        stepover: Math.max(
            1e-3,
            num(params, "stepover", context.tool.cutting.stepover ?? context.tool.diameter / 4),
        ),
        zigzag: params["zigzag"] !== false,
        lead: num(params, "lead", 0),
        tilt: num(params, "tilt", 0),
    };
}

/** The contact passes of one face along its iso curves (chords within `tolerance`). */
export function flowlineContacts(
    sampler: FaceSampler,
    direction: "u" | "v",
    stepover: number,
    maxStep: number,
    tolerance: number,
): Result<SurfacePoint[][]> {
    const bounds = sampler.uvBounds();
    if (!bounds.isOk) return Result.err(bounds.error);
    const { u1, u2, v1, v2 } = bounds.value;
    const [a1, a2, c1, c2] = direction === "u" ? [u1, u2, v1, v2] : [v1, v2, u1, u2];
    const at = (along: number, across: number) =>
        direction === "u" ? sampler.at(along, across) : sampler.at(across, along);
    const probe = 32;
    const acrossLength = Math.max(
        ...[0, 0.5, 1].map((f) =>
            polylineLength(sampleRange(c1, c2, probe, (c) => at(a1 + (a2 - a1) * f, c).point)),
        ),
    );
    const alongLength = Math.max(
        ...[0, 0.5, 1].map((f) =>
            polylineLength(sampleRange(a1, a2, probe, (a) => at(a, c1 + (c2 - c1) * f).point)),
        ),
    );
    const passes = Math.max(1, Math.ceil(acrossLength / stepover));
    const steps = Math.max(1, Math.ceil(alongLength / maxStep));
    const out: SurfacePoint[][] = [];
    for (const across of sampleRange(c1, c2, passes, (c) => c)) {
        const inside = (along: number) => {
            const point = at(along, across);
            return sampler.contains(point.point) ? point : undefined;
        };
        out.push(...sampleRuns(a1, a2, steps, inside, tolerance));
    }
    return Result.ok(out);
}

export const flowlineHandler: CamOperationHandler = {
    type: FLOWLINE_5X_TYPE,
    label: "Flowline",
    category: "5axis",
    machineKinds: ["mill"],
    selects: ["face"],
    defaults: (_machine, tool) => ({
        ...commonDefaults(tool),
        direction: "u",
        stepover: tool?.cutting.stepover ?? (tool ? tool.diameter / 4 : 1),
        zigzag: true,
        lead: 0,
        tilt: 0,
    }),
    parameters: () => [
        {
            key: "direction",
            label: "Passes along",
            kind: "enum",
            options: [
                { value: "u", label: "U" },
                { value: "v", label: "V" },
            ],
        },
        { key: "stepover", label: "Stepover", kind: "length", min: 0 },
        ...ORIENTATION_PARAMETERS,
        ...COMMON_PARAMETERS,
    ],
    generate(operation, context) {
        const machine = fiveAxisMachine(context);
        if (!machine.isOk) return Result.err(machine.error);
        const params = readFlowline(operation, context);
        const faces = context.selectedFaces();
        if (faces.length === 0) return Result.err(`${operation.name}: pick the faces to follow`);
        const placer = new ContactPlacer(context, params);
        const passes: Pass[] = [];
        for (const [index, face] of faces.entries()) {
            const sampler = new FaceSampler(face);
            try {
                const contacts = flowlineContacts(
                    sampler,
                    params.direction,
                    params.stepover,
                    params.maxStep,
                    params.tolerance,
                );
                if (!contacts.isOk)
                    return Result.err(`${operation.name}: face ${index + 1}: ${contacts.error}`);
                const cut = surfacePasses(
                    zigzag(contacts.value, params.zigzag),
                    params.lead,
                    params.tilt,
                    placer,
                );
                if (!cut.isOk) return Result.err(`${operation.name}: ${cut.error}`);
                passes.push(...cut.value);
            } finally {
                sampler.dispose();
            }
        }
        return finishToolpath(operation, context, linkPasses(passes, params), params, machine.value);
    },
};
