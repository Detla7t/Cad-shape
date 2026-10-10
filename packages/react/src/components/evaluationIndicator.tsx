// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type EvaluationKind,
    type EvaluationState,
    evaluationLabel,
    evaluationTooltip,
    type IApplication,
    type IDisposable,
    type IEvaluationStateSource,
    sameEvaluationState,
} from "@chili3d/core";
import { type MouseEvent, useCallback, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { mountIsland, type ReactIsland } from "../island";
import style from "./evaluationIndicator.module.css";

/**
 * The one presentation of evaluation state (`EvaluationState` from core): an icon AND a text
 * label — never colour alone — with the reason or error in the tooltip. Part Studio feature
 * lists and the CAM Studio's operation list both show it, so "failed", "out of date" and
 * "computing" read the same everywhere.
 *
 * - `badge` (default) — compact, for list rows; with an `action` a failed badge is a button.
 * - `banner` — a full-width line with the message spelled out and the action as a button,
 *   for the state of a whole body or setup.
 */

export interface EvaluationAction {
    readonly label: string;
    readonly run: () => void;
}

export interface EvaluationIndicatorOptions {
    readonly variant?: "badge" | "banner";
    /** Render nothing while ready (lists where "fine" is the unmarked default). */
    readonly hideReady?: boolean;
    /** Render only failures (a banner that only speaks up when something broke). */
    readonly onlyFailed?: boolean;
    /** Offered on a failed state — "Edit feature" opens the failing feature. */
    readonly action?: EvaluationAction;
}

export interface EvaluationIndicatorProps extends EvaluationIndicatorOptions {
    readonly state: EvaluationState | undefined;
}

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

function iconPaths(kind: EvaluationKind) {
    switch (kind) {
        case "ready":
            return <path d="M2.2 6.4 4.8 9 9.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />;
        case "computing":
            return (
                <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            );
        case "changed":
            return (
                <>
                    <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M6 3.3V6l1.9 1.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </>
            );
        case "failed":
            return (
                <>
                    <path d="M6 1 11.3 10.6H.7Z" fill="currentColor" />
                    <path d="M6 4.3v3.3M6 8.6v1" stroke="var(--evaluation-icon-contrast, #ffffff)" />
                </>
            );
    }
}

/** Decorative: the text label next to it carries the meaning. */
function StateIcon({ kind }: { kind: EvaluationKind }) {
    return (
        <svg
            className={join(style.icon, kind === "computing" && style.spin)}
            viewBox="0 0 12 12"
            width={12}
            height={12}
            aria-hidden="true"
            focusable="false"
        >
            {iconPaths(kind)}
        </svg>
    );
}

export function EvaluationIndicator(props: EvaluationIndicatorProps) {
    const { state, variant = "badge", hideReady, onlyFailed, action } = props;
    if (state === undefined) return null;
    if ((hideReady || onlyFailed) && state.kind === "ready") return null;
    if (onlyFailed && state.kind !== "failed") return null;
    const label = evaluationLabel(state);
    const tooltip = evaluationTooltip(state);
    const offered = state.kind === "failed" ? action : undefined;
    const run = (event: MouseEvent) => {
        event.stopPropagation();
        offered?.run();
    };
    if (variant === "banner") {
        return (
            <div className={style.banner} data-evaluation={state.kind} title={tooltip}>
                <StateIcon kind={state.kind} />
                <span className={style.label}>{label}</span>
                <span className={style.message}>{tooltip}</span>
                {offered === undefined ? null : (
                    <button type="button" className={style.action} onClick={run}>
                        {offered.label}
                    </button>
                )}
            </div>
        );
    }
    const content = (
        <>
            <StateIcon kind={state.kind} />
            <span className={style.label}>{label}</span>
        </>
    );
    return offered === undefined ? (
        <span className={style.badge} data-evaluation={state.kind} title={tooltip}>
            {content}
        </span>
    ) : (
        <button
            type="button"
            className={join(style.badge, style.badgeButton)}
            data-evaluation={state.kind}
            title={`${tooltip}\n${offered.label}`}
            aria-label={`${label}: ${tooltip}. ${offered.label}`}
            onClick={run}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            {content}
        </button>
    );
}

/** The current state of a live source, re-rendering only when the state really changes. */
export function useEvaluationState(source: IEvaluationStateSource | undefined): EvaluationState | undefined {
    const last = useRef<
        { source: IEvaluationStateSource | undefined; state: EvaluationState | undefined } | undefined
    >(undefined);
    const subscribe = useCallback(
        (notify: () => void) => (source === undefined ? () => {} : source.subscribe(notify)),
        [source],
    );
    const read = () => {
        const next = source?.state();
        const previous = last.current;
        if (previous !== undefined && previous.source === source && sameEvaluationState(previous.state, next))
            return previous.state;
        last.current = { source, state: next };
        return next;
    };
    return useSyncExternalStore(subscribe, read, read);
}

export interface LiveEvaluationIndicatorProps extends EvaluationIndicatorOptions {
    readonly source: IEvaluationStateSource | undefined;
}

/** `EvaluationIndicator` following a live source. */
export function LiveEvaluationIndicator({ source, ...options }: LiveEvaluationIndicatorProps) {
    return <EvaluationIndicator {...options} state={useEvaluationState(source)} />;
}

/**
 * Mounts a live indicator into a legacy (custom-element) host. The first render is flushed
 * synchronously, so the row it sits in is complete when the caller returns.
 */
export function mountEvaluationIndicator(
    host: Element,
    source: IEvaluationStateSource,
    options: EvaluationIndicatorOptions = {},
    application?: IApplication,
): ReactIsland {
    let island: ReactIsland | undefined;
    flushSync(() => {
        island = mountIsland(host, <LiveEvaluationIndicator {...options} source={source} />, application);
    });
    return island!;
}

/**
 * Indicators of a legacy list that re-renders all its rows (the CAM operation tree, a feature
 * list): `element(key, …)` returns the same host element — and React root — for a key across
 * renders, re-rendered with the new source and options; `sweep()` after a render unmounts the
 * keys it did not ask for.
 */
export class EvaluationIndicators implements IDisposable {
    private readonly entries = new Map<string, { host: HTMLElement; island: ReactIsland }>();
    private readonly used = new Set<string>();

    constructor(
        private readonly hostClass?: string,
        private readonly application?: IApplication,
    ) {}

    element(
        key: string,
        source: IEvaluationStateSource,
        options: EvaluationIndicatorOptions = {},
    ): HTMLElement {
        this.used.add(key);
        const node = <LiveEvaluationIndicator {...options} source={source} />;
        const entry = this.entries.get(key);
        if (entry !== undefined) {
            flushSync(() => entry.island.render(node));
            return entry.host;
        }
        const host = document.createElement("span");
        host.className = join(style.host, this.hostClass);
        let island: ReactIsland | undefined;
        flushSync(() => {
            island = mountIsland(host, node, this.application);
        });
        this.entries.set(key, { host, island: island! });
        return host;
    }

    /** Unmounts the indicators not requested since the previous sweep. */
    sweep(): void {
        for (const [key, entry] of [...this.entries]) {
            if (this.used.has(key)) continue;
            entry.island.dispose();
            entry.host.remove();
            this.entries.delete(key);
        }
        this.used.clear();
    }

    dispose(): void {
        for (const entry of this.entries.values()) entry.island.dispose();
        this.entries.clear();
        this.used.clear();
    }
}
