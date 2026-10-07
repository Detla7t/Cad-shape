// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Secret header values (API keys, bearer tokens) for this browser session only: kept in memory,
 * keyed by the source's node id — never in the document, the undo history, the version history
 * or a saved file, unless the source opts in to `storeSecrets`. A reload forgets them.
 */
const store = new Map<string, Record<string, string>>();

export function sessionSecrets(nodeId: string): Readonly<Record<string, string>> {
    return store.get(nodeId) ?? {};
}

/** Sets (or, with an empty value, clears) one secret. */
export function setSessionSecret(nodeId: string, name: string, value: string): void {
    const next = { ...(store.get(nodeId) ?? {}) };
    if (value === "") delete next[name];
    else next[name] = value;
    if (Object.keys(next).length === 0) store.delete(nodeId);
    else store.set(nodeId, next);
}

export function mergeSessionSecrets(nodeId: string, secrets: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(secrets)) setSessionSecret(nodeId, name, value);
}

export function clearSessionSecrets(nodeId: string): void {
    store.delete(nodeId);
}
