// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ICollectionChanged, IPropertyChanged, PubSubEventMap } from "@chili3d/core";
import { PubSub } from "@chili3d/core";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Hooks that let React components read Chili3d's reactive model. Core keeps state in
 * `Observable`s (property changes), `ObservableCollection`s (collection changes) and the
 * `PubSub` bus; each hook subscribes through `useSyncExternalStore`, so a component re-renders
 * exactly when what it reads changes, and concurrent rendering never tears.
 */

/** The current value of `source[property]`, re-rendering when that property changes. */
export function useObservable<T extends IPropertyChanged, K extends keyof T>(source: T, property: K): T[K];
export function useObservable<T extends IPropertyChanged, K extends keyof T>(
    source: T | undefined,
    property: K,
): T[K] | undefined;
export function useObservable<T extends IPropertyChanged, K extends keyof T>(
    source: T | undefined,
    property: K,
): T[K] | undefined {
    const subscribe = useCallback(
        (notify: () => void) => {
            if (source === undefined) return () => {};
            const handler = (changed: keyof T) => {
                if (changed === property) notify();
            };
            source.onPropertyChanged(handler);
            return () => source.removePropertyChanged(handler);
        },
        [source, property],
    );
    const read = () => source?.[property];
    return useSyncExternalStore(subscribe, read, read);
}

interface Snapshot<T> {
    readonly source: unknown;
    readonly items: readonly T[];
}

/**
 * The items of an observable collection (`ObservableCollection`, a node list…) as an array that
 * stays the same object until the collection changes — safe to pass to memoized children.
 */
export function useCollection<T>(source: (ICollectionChanged & { items(): T[] }) | undefined): readonly T[] {
    const snapshot = useRef<Snapshot<T>>({ source: undefined, items: [] });
    const subscribe = useCallback(
        (notify: () => void) => {
            if (source === undefined) return () => {};
            const handler = () => {
                snapshot.current = { source, items: source.items() };
                notify();
            };
            source.onCollectionChanged(handler);
            return () => source.removeCollectionChanged(handler);
        },
        [source],
    );
    const read = () => {
        if (snapshot.current.source !== source) {
            snapshot.current = { source, items: source?.items() ?? [] };
        }
        return snapshot.current.items;
    };
    return useSyncExternalStore(subscribe, read, read);
}

/**
 * Calls `handler` for every `event` published on the bus while the component is mounted. The
 * latest `handler` is always the one called, so it may close over fresh props and state.
 */
export function usePubSub<K extends keyof PubSubEventMap>(
    event: K,
    handler: PubSubEventMap[K],
    bus: PubSub = PubSub.default,
): void {
    const latest = useRef(handler);
    latest.current = handler;
    useEffect(() => {
        const forward = ((...args: unknown[]) =>
            (latest.current as (...a: unknown[]) => void)(...args)) as PubSubEventMap[K];
        bus.sub(event, forward);
        return () => bus.remove(event, forward);
    }, [event, bus]);
}
