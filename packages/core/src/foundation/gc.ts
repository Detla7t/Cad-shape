// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, isDisposable } from "./disposable";

export interface Deletable {
    delete(): void;
}

export function isDeletable(value: unknown): value is Deletable {
    const candidate = value as { delete?: unknown } | null | undefined;
    return typeof candidate?.delete === "function" && candidate.delete.length === 0;
}

export const gc = <R>(action: (collect: <T extends Deletable | IDisposable>(resource: T) => T) => R): R => {
    const resources = new Set<Deletable | IDisposable>();

    const collectResource = <T extends Deletable | IDisposable>(resource: T) => {
        resources.add(resource);
        return resource;
    };

    try {
        return action(collectResource);
    } finally {
        for (const resource of resources) {
            if (isDeletable(resource)) {
                resource.delete();
            } else if (isDisposable(resource)) {
                resource.dispose();
            }
        }
        resources.clear();
    }
};
