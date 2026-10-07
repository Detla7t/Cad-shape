// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { ToolpathData } from "../model/toolpath";
import { type GcodeStats, printerGcodeStats } from "./gcode/parse";

/**
 * Client of the local PrusaSlicer bridge (`scripts/prusa-slicer-bridge.mjs`): a small Node
 * HTTP server on the user's machine that runs the installed `prusa-slicer` CLI. The app posts
 * the job's 3MF project and INI; the bridge answers with the G-code.
 *
 * Protocol: `GET /health` → `{ ok, slicer, version }`; `POST /slice` with JSON
 * `{ model: <base64>, modelName: "job.3mf" | "part.stl", config: <ini text>, arrange?: boolean }`
 * → `{ ok: true, gcode, log }` or `{ ok: false, error, log }` (HTTP 4xx/5xx).
 */

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7781";

export interface BridgeSliceRequest {
    readonly model: Uint8Array;
    readonly modelName: string;
    readonly config: string;
    /** Let PrusaSlicer arrange the objects instead of keeping their placement. */
    readonly arrange?: boolean;
}

export interface BridgeSliceResult {
    readonly gcode: string;
    readonly log: string;
}

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

const trimUrl = (url: string) => url.replace(/\/+$/, "");

export async function bridgeHealth(
    url = DEFAULT_BRIDGE_URL,
): Promise<Result<{ slicer: string; version: string }>> {
    try {
        const response = await fetch(`${trimUrl(url)}/health`);
        const body = (await response.json()) as {
            ok?: boolean;
            slicer?: string;
            version?: string;
            error?: string;
        };
        if (!response.ok || !body.ok) return Result.err(body.error ?? `bridge answered ${response.status}`);
        return Result.ok({ slicer: body.slicer ?? "", version: body.version ?? "" });
    } catch (error) {
        return Result.err(
            `PrusaSlicer bridge not reachable at ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Slices through the bridge; errors (unreachable, slicer failure) are results. */
export async function sliceWithBridge(
    url: string,
    request: BridgeSliceRequest,
    signal?: AbortSignal,
): Promise<Result<BridgeSliceResult>> {
    let response: Response;
    try {
        response = await fetch(`${trimUrl(url)}/slice`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: toBase64(request.model),
                modelName: request.modelName,
                config: request.config,
                arrange: request.arrange === true,
            }),
            signal,
        });
    } catch (error) {
        return Result.err(
            `PrusaSlicer bridge not reachable at ${url} (start it with "node scripts/prusa-slicer-bridge.mjs"): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    let body: { ok?: boolean; gcode?: string; log?: string; error?: string };
    try {
        body = await response.json();
    } catch {
        return Result.err(`PrusaSlicer bridge answered ${response.status} without JSON`);
    }
    if (!response.ok || !body.ok || typeof body.gcode !== "string") {
        const log = body.log ? `\n${body.log.trim().split("\n").slice(-12).join("\n")}` : "";
        return Result.err(`PrusaSlicer failed: ${body.error ?? `HTTP ${response.status}`}${log}`);
    }
    return Result.ok({ gcode: body.gcode, log: body.log ?? "" });
}

/**
 * A toolpath carrying a slicer's program: the G-code verbatim as one raw move (what the
 * printer posts write unchanged), with the slicer's statistics. `printerPreviewMoves(toolpath)`
 * expands it into drawable moves.
 */
export function gcodeToolpath(
    gcode: string,
    toolId: string,
    label: string,
): { toolpath: ToolpathData; stats: GcodeStats } {
    return {
        toolpath: { toolId, label, moves: [{ kind: "raw", code: gcode }] },
        stats: printerGcodeStats(gcode),
    };
}
