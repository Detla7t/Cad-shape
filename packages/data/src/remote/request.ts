// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { DataHeader } from "../model/definition";

/** What a remote load needs besides the definition. */
export interface RemoteContext {
    /** Secret header values by header name (the session store, see `secrets.ts`). */
    readonly secrets: Readonly<Record<string, string>>;
    /** Defaults to the global `fetch` at call time. */
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
}

/** The request headers: plain values as written, secret ones from the session store. */
export function requestHeaders(
    headers: readonly DataHeader[],
    secrets: Readonly<Record<string, string>>,
): Result<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const header of headers) {
        const name = header.name.trim();
        if (name === "") continue;
        const value = header.secret === true ? secrets[header.name] : header.value;
        if (value === undefined || value === "") {
            if (header.secret === true) {
                return Result.err(`Enter the value of "${name}" — it is kept for this session only`);
            }
            continue;
        }
        result[name] = value;
    }
    return Result.ok(result);
}

/** An http(s) URL, or the reason it is not one. */
export function checkUrl(url: string): Result<URL> {
    const trimmed = url.trim();
    if (trimmed === "") return Result.err("Enter the URL to read from");
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return Result.err(`Not a URL: ${trimmed}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return Result.err(`Only http and https URLs can be read: ${trimmed}`);
    }
    return Result.ok(parsed);
}

/**
 * Fetches `url`, turning a network failure (most often the server not allowing this page's
 * origin — browsers hide which) and an HTTP error status into readable errors.
 */
export async function fetchChecked(
    url: string,
    init: RequestInit,
    context: RemoteContext,
): Promise<Result<Response>> {
    const fetcher = context.fetch ?? globalThis.fetch;
    let response: Response;
    try {
        response = await fetcher(url, { ...init, signal: context.signal });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let host = url;
        try {
            host = new URL(url).host;
        } catch {}
        return Result.err(
            `Could not reach ${host}: ${message}. The server must allow requests from this page (CORS).`,
        );
    }
    if (!response.ok) {
        let detail = "";
        try {
            detail = (await response.text()).trim().slice(0, 300);
        } catch {}
        const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
        return Result.err(`${url} answered ${status}${detail === "" ? "" : `: ${detail}`}`);
    }
    return Result.ok(response);
}

/** A response body as JSON, or the reason it is not. */
export async function responseJson(response: Response): Promise<Result<unknown>> {
    const text = await response.text();
    try {
        return Result.ok(JSON.parse(text));
    } catch {
        return Result.err(`The answer is not JSON: ${text.trim().slice(0, 120)}`);
    }
}
