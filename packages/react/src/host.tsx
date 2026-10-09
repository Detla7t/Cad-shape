// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "@chili3d/core";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { ApplicationProvider } from "./application";

/**
 * Boots the application into a DOM element and resolves with it — typically an `AppBuilder`
 * chain ending in `.useUI(container).build()`.
 */
export type ApplicationBoot = (container: HTMLElement) => Promise<IApplication>;

interface Booted {
    readonly promise: Promise<IApplication>;
    /** What the application rendered into the first container (its main window). */
    elements: Element[];
    /** Where the application shows now: the latest mounted host. */
    container: HTMLElement;
}

/**
 * An application is a page-wide singleton (`getCurrentApplication`, global commands, one
 * IndexedDB connection) and cannot be torn down: it boots once per boot function and moves
 * into whichever host mounted last (Strict Mode remounts, route changes).
 */
const booted = new WeakMap<ApplicationBoot, Booted>();

function boot(start: ApplicationBoot, container: HTMLElement): Booted {
    const existing = booted.get(start);
    if (existing !== undefined) {
        existing.container = container;
        if (existing.elements.length > 0) container.append(...existing.elements);
        return existing;
    }
    const entry: Booted = {
        container,
        elements: [],
        promise: start(container).then((app) => {
            entry.elements = Array.from(container.children);
            if (entry.container !== container) entry.container.append(...entry.elements);
            return app;
        }),
    };
    booted.set(start, entry);
    return entry;
}

export interface ChiliHostProps {
    readonly boot: ApplicationBoot;
    /** Called once the application is ready (on every mount, with the same application). */
    readonly onReady?: (application: IApplication) => void | Promise<void>;
    readonly onError?: (error: unknown) => void;
    /** Shown over the host while the application boots. */
    readonly fallback?: ReactNode;
    /** Rendered inside `ApplicationProvider` once booted: React panels that use the application. */
    readonly children?: ReactNode;
    readonly className?: string;
    readonly style?: CSSProperties;
}

/**
 * Hosts the Chili3d application inside a React tree: the legacy custom-element UI renders into
 * this component's element, and `children` get the booted application through context.
 */
export function ChiliHost(props: ChiliHostProps) {
    const container = useRef<HTMLDivElement>(null);
    const [application, setApplication] = useState<IApplication>();
    const { boot: start, onReady, onError } = props;

    useEffect(() => {
        const element = container.current;
        if (element === null) return;
        let active = true;
        boot(start, element)
            .promise.then(async (app) => {
                if (!active) return;
                setApplication(app);
                await onReady?.(app);
            })
            .catch((error: unknown) => {
                if (active) onError?.(error);
            });
        return () => {
            active = false;
        };
    }, [start, onReady, onError]);

    return (
        <>
            <div ref={container} className={props.className} style={props.style} />
            {application === undefined ? props.fallback : null}
            {application !== undefined && props.children !== undefined ? (
                <ApplicationProvider application={application}>{props.children}</ApplicationProvider>
            ) : null}
        </>
    );
}
