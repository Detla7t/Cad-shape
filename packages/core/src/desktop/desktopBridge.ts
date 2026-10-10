// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { fileExtension } from "../fileFormat";
import { Result } from "../foundation/result";
import { bytesToBase64 } from "../foundation/utils/base64";
import type { DownloadedFile } from "../foundation/utils/download";

/**
 * Client of the local desktop bridge (`scripts/desktop-bridge.mjs`): a small Node HTTP server on
 * the user's machine that saves exported files and opens them in desktop programs (the system's
 * default program, or one it found — FreeCAD, PrusaSlicer, …), shows them in the file manager and
 * slices with PrusaSlicer for the CAM Studio.
 *
 * Protocol: `GET /health` → `DesktopBridgeInfo`; `POST /open` with `{ file: <base64>, name, app? }`
 * → `{ ok, path, app: { id, name } }`; `POST /reveal` with `{ path }`. Errors are results.
 */

export const DEFAULT_DESKTOP_BRIDGE_URL = "http://127.0.0.1:7781";

/** A desktop program the bridge can launch. */
export interface DesktopApp {
    readonly id: string;
    readonly name: string;
    /** File types it opens (lower-case, no dot); null = any. */
    readonly extensions: readonly string[] | null;
    readonly command?: string;
}

export interface DesktopBridgeInfo {
    readonly url: string;
    /** The bridge machine's platform: "linux", "darwin", "win32". */
    readonly platform: string;
    /** Where opened exports are saved. */
    readonly exportsDir: string;
    /** File types `/open` accepts (lower-case, no dot). */
    readonly openable: readonly string[];
    readonly apps: readonly DesktopApp[];
    /** The PrusaSlicer command and its version line, when the bridge can run one. */
    readonly slicer?: { readonly command: string; readonly version: string };
}

/** Where a file opens: the system's default program, or one of the bridge's apps by id. */
export type DesktopTarget = "default" | string;

export interface DesktopOpened {
    /** The saved file on the bridge machine. */
    readonly path: string;
    readonly app: { readonly id: string; readonly name: string };
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** The bridge's spelling of a file type: the lower-case extension without the dot. */
const extensionOf = (name: string) => fileExtension(name).slice(1);

/** Whether the bridge opens files of this name's type. */
export function canOpenOnDesktop(info: DesktopBridgeInfo, name: string): boolean {
    return info.openable.includes(extensionOf(name));
}

/** The bridge's apps that open this file type (apps without an extension list open anything). */
export function desktopAppsFor(info: DesktopBridgeInfo, name: string): DesktopApp[] {
    if (!canOpenOnDesktop(info, name)) return [];
    const extension = extensionOf(name);
    return info.apps.filter((app) => app.extensions === null || app.extensions.includes(extension));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
        const body = (await response.json()) as unknown;
        return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Asks the bridge what it offers. Unreachable (nothing listening, another origin, a timeout) is
 * an error result.
 */
export async function probeDesktopBridge(
    url = DEFAULT_DESKTOP_BRIDGE_URL,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<Result<DesktopBridgeInfo>> {
    const base = trimUrl(url);
    const signal =
        options.signal ??
        (options.timeoutMs !== undefined && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(options.timeoutMs)
            : undefined);
    let response: Response;
    try {
        response = await fetch(`${base}/health`, { signal });
    } catch (error) {
        return Result.err(`desktop bridge not reachable at ${base}: ${describe(error)}`);
    }
    const body = await readJson(response);
    if (!response.ok || body["ok"] !== true) {
        return Result.err(
            typeof body["error"] === "string" ? body["error"] : `desktop bridge answered ${response.status}`,
        );
    }
    const apps = Array.isArray(body["apps"]) ? (body["apps"] as unknown[]) : [];
    const openable = Array.isArray(body["openable"]) ? (body["openable"] as unknown[]) : [];
    const version = body["version"];
    return Result.ok({
        url: base,
        platform: typeof body["platform"] === "string" ? body["platform"] : "",
        exportsDir: typeof body["exportsDir"] === "string" ? body["exportsDir"] : "",
        openable: openable.filter((ext): ext is string => typeof ext === "string"),
        apps: apps
            .filter((app): app is Record<string, unknown> => typeof app === "object" && app !== null)
            .filter((app) => typeof app["id"] === "string" && typeof app["name"] === "string")
            .map((app) => ({
                id: app["id"] as string,
                name: app["name"] as string,
                extensions: Array.isArray(app["extensions"])
                    ? (app["extensions"] as unknown[]).filter((e): e is string => typeof e === "string")
                    : null,
                command: typeof app["command"] === "string" ? app["command"] : undefined,
            })),
        slicer:
            typeof version === "string" && typeof body["slicer"] === "string"
                ? { command: body["slicer"], version }
                : undefined,
    });
}

/** Sends the file to the bridge, which saves it and opens it in `target`. */
export async function openOnDesktop(
    url: string,
    file: DownloadedFile,
    target: DesktopTarget = "default",
    signal?: AbortSignal,
): Promise<Result<DesktopOpened>> {
    const base = trimUrl(url);
    let response: Response;
    try {
        const bytes = new Uint8Array(await file.blob.arrayBuffer());
        response = await fetch(`${base}/open`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: bytesToBase64(bytes), name: file.name, app: target }),
            signal,
        });
    } catch (error) {
        return Result.err(`desktop bridge not reachable at ${base}: ${describe(error)}`);
    }
    const body = await readJson(response);
    const app = body["app"];
    if (
        !response.ok ||
        body["ok"] !== true ||
        typeof body["path"] !== "string" ||
        typeof app !== "object" ||
        app === null
    ) {
        return Result.err(
            typeof body["error"] === "string" ? body["error"] : `desktop bridge answered ${response.status}`,
        );
    }
    const label = app as Record<string, unknown>;
    return Result.ok({
        path: body["path"],
        app: {
            id: typeof label["id"] === "string" ? label["id"] : target,
            name: typeof label["name"] === "string" ? label["name"] : target,
        },
    });
}

/** Shows a file the bridge saved in the file manager. */
export async function revealOnDesktop(
    url: string,
    path: string,
    signal?: AbortSignal,
): Promise<Result<void>> {
    const base = trimUrl(url);
    let response: Response;
    try {
        response = await fetch(`${base}/reveal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
            signal,
        });
    } catch (error) {
        return Result.err(`desktop bridge not reachable at ${base}: ${describe(error)}`);
    }
    const body = await readJson(response);
    if (!response.ok || body["ok"] !== true) {
        return Result.err(
            typeof body["error"] === "string" ? body["error"] : `desktop bridge answered ${response.status}`,
        );
    }
    return Result.ok(undefined);
}
