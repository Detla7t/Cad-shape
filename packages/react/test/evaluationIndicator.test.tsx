// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EvaluationState, I18n, type IEvaluationStateSource } from "@chili3d/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    EvaluationIndicator,
    EvaluationIndicators,
    LiveEvaluationIndicator,
    mountEvaluationIndicator,
    useEvaluationState,
} from "../src";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A source whose state the test sets; `set` notifies like a rebuild would. */
function controllable(initial: EvaluationState | undefined) {
    let state = initial;
    const listeners = new Set<() => void>();
    const source: IEvaluationStateSource & { set(next: EvaluationState | undefined): void; reads: number } = {
        reads: 0,
        state: () => {
            source.reads++;
            return state;
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(next) {
            state = next;
            for (const listener of [...listeners]) listener();
        },
    };
    return { source, listeners };
}

const failed: EvaluationState = {
    kind: "failed",
    message: "Edge not found after rebuild",
    lastGoodShown: true,
    at: "fillet",
};

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
    act(() => root.render(node));
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("EvaluationIndicator", () => {
    test.each([
        ["ready", { kind: "ready" }, "evaluation.ready"],
        ["computing", { kind: "computing" }, "evaluation.computing"],
        ["changed", { kind: "changed", reason: "The tool changed" }, "evaluation.changed"],
        ["failed", failed, "evaluation.failed"],
    ] as const)("%s shows an icon and a text label", (kind, state, label) => {
        render(<EvaluationIndicator state={state as EvaluationState} />);
        const badge = host.querySelector(`[data-evaluation="${kind}"]`);
        expect(badge).not.toBeNull();
        expect(badge!.querySelector("svg")).not.toBeNull();
        expect(badge!.textContent).toBe(I18n.translate(label));
    });

    test("the tooltip carries the reason, the error and that the last good result is shown", () => {
        render(<EvaluationIndicator state={{ kind: "changed", reason: "The tool changed" }} />);
        expect(host.querySelector("[data-evaluation]")!.getAttribute("title")).toBe("The tool changed");
        render(<EvaluationIndicator state={failed} />);
        expect(host.querySelector("[data-evaluation]")!.getAttribute("title")).toBe(
            `Edge not found after rebuild\n${I18n.translate("evaluation.lastGoodShown")}`,
        );
    });

    test("hideReady and onlyFailed leave nothing for the states they hide; no state renders nothing", () => {
        render(<EvaluationIndicator state={{ kind: "ready" }} hideReady />);
        expect(host.childElementCount).toBe(0);
        render(<EvaluationIndicator state={{ kind: "changed", reason: "x" }} onlyFailed />);
        expect(host.childElementCount).toBe(0);
        render(<EvaluationIndicator state={undefined} />);
        expect(host.childElementCount).toBe(0);
        render(<EvaluationIndicator state={{ kind: "changed", reason: "x" }} hideReady />);
        expect(host.querySelector('[data-evaluation="changed"]')).not.toBeNull();
    });

    test("a failed badge with an action is a button that runs it, other states ignore the action", () => {
        const run = rs.fn(() => {});
        const rowClick = rs.fn(() => {});
        render(
            // biome-ignore lint/a11y: stands in for a legacy tree row that handles clicks itself
            <div onClick={rowClick}>
                <EvaluationIndicator state={failed} action={{ label: "Edit feature", run }} />
            </div>,
        );
        const button = host.querySelector<HTMLButtonElement>('button[data-evaluation="failed"]');
        expect(button).not.toBeNull();
        expect(button!.getAttribute("aria-label")).toContain("Edit feature");
        act(() => button!.click());
        expect(run).toHaveBeenCalledTimes(1);
        // The row under it (a tree row that selects or expands) does not get the click.
        expect(rowClick).not.toHaveBeenCalled();

        render(
            <EvaluationIndicator state={{ kind: "changed", reason: "x" }} action={{ label: "Edit", run }} />,
        );
        expect(host.querySelector("button")).toBeNull();
    });

    test("the banner spells out the message and offers the action as a button", () => {
        const run = rs.fn(() => {});
        render(
            <EvaluationIndicator state={failed} variant="banner" action={{ label: "Edit feature", run }} />,
        );
        const banner = host.querySelector('[data-evaluation="failed"]');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toContain("Edge not found after rebuild");
        expect(banner!.textContent).toContain(I18n.translate("evaluation.lastGoodShown"));
        const button = banner!.querySelector("button");
        expect(button?.textContent).toBe("Edit feature");
        act(() => button!.click());
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe("live indicators", () => {
    test("LiveEvaluationIndicator follows its source and unsubscribes on unmount", () => {
        const { source, listeners } = controllable({ kind: "ready" });
        render(<LiveEvaluationIndicator source={source} />);
        expect(host.querySelector('[data-evaluation="ready"]')).not.toBeNull();
        act(() => source.set({ kind: "computing" }));
        expect(host.querySelector('[data-evaluation="computing"]')).not.toBeNull();
        act(() => source.set(failed));
        expect(host.querySelector('[data-evaluation="failed"]')).not.toBeNull();
        expect(listeners.size).toBe(1);
        render(null);
        expect(listeners.size).toBe(0);
    });

    test("useEvaluationState re-renders on a new state only, not on an equal fresh object", () => {
        const { source } = controllable({ kind: "changed", reason: "same" });
        const seen: (EvaluationState | undefined)[] = [];
        function Probe() {
            seen.push(useEvaluationState(source));
            return null;
        }
        render(<Probe />);
        expect(seen).toHaveLength(1);
        act(() => source.set({ kind: "changed", reason: "same" }));
        expect(seen).toHaveLength(1);
        act(() => source.set({ kind: "changed", reason: "other" }));
        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual({ kind: "changed", reason: "other" });
    });

    test("mountEvaluationIndicator renders synchronously into a legacy host", () => {
        const legacy = document.createElement("span");
        const { source, listeners } = controllable(failed);
        const island = mountEvaluationIndicator(legacy, source, { hideReady: true });
        expect(legacy.querySelector('[data-evaluation="failed"]')).not.toBeNull();
        act(() => source.set({ kind: "ready" }));
        expect(legacy.childElementCount).toBe(0);
        act(() => island.dispose());
        expect(listeners.size).toBe(0);
    });

    test("EvaluationIndicators keeps one host per key across renders and sweeps the rest", () => {
        const pool = new EvaluationIndicators("row-status");
        const a = controllable({ kind: "ready" });
        const b = controllable(failed);
        const hostA = pool.element("a", a.source);
        const hostB = pool.element("b", b.source);
        expect(hostA.className).toContain("row-status");
        expect(hostA.querySelector('[data-evaluation="ready"]')).not.toBeNull();
        expect(hostB.querySelector('[data-evaluation="failed"]')).not.toBeNull();
        pool.sweep();

        // The next render asks for "a" only: same element, new options; "b" is unmounted.
        expect(pool.element("a", a.source, { hideReady: true })).toBe(hostA);
        expect(hostA.childElementCount).toBe(0);
        pool.sweep();
        expect(b.listeners.size).toBe(0);
        expect(a.listeners.size).toBe(1);
        act(() => pool.dispose());
        expect(a.listeners.size).toBe(0);
    });
});
