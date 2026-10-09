// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, Observable, ObservableCollection, PubSub } from "@chili3d/core";
import type { Drawing } from "@chili3d/drawing";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    ChiliHost,
    DrawingView,
    LoadingScreen,
    mountIsland,
    useApplication,
    useCollection,
    useObservable,
    usePubSub,
} from "../src";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Counter extends Observable {
    get count(): number {
        return this.getPrivateValue("count", 0);
    }
    set count(value: number) {
        this.setProperty("count", value);
    }
    get label(): string {
        return this.getPrivateValue("label", "a");
    }
    set label(value: string) {
        this.setProperty("label", value);
    }
}

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

describe("observable hooks", () => {
    test("useObservable re-renders on its property only", () => {
        const counter = new Counter();
        let renders = 0;
        function View() {
            renders++;
            return <span>{useObservable(counter, "count")}</span>;
        }
        render(<View />);
        expect(host.textContent).toBe("0");
        act(() => {
            counter.count = 5;
        });
        expect(host.textContent).toBe("5");
        const before = renders;
        act(() => {
            counter.label = "b";
        });
        expect(renders).toBe(before);
    });

    test("useCollection follows adds and removes with a stable array between changes", () => {
        const collection = new ObservableCollection<string>("x");
        const seen: (readonly string[])[] = [];
        function View() {
            const items = useCollection(collection);
            seen.push(items);
            return <span>{items.join(",")}</span>;
        }
        render(<View />);
        act(() => collection.push("y"));
        expect(host.textContent).toBe("x,y");
        act(() => collection.remove("x"));
        expect(host.textContent).toBe("y");
        render(<View />);
        expect(seen.at(-1)).toBe(seen.at(-2));
    });

    test("usePubSub calls the latest handler and unsubscribes on unmount", () => {
        const bus = new PubSub();
        const calls: string[] = [];
        function View(props: { tag: string }) {
            usePubSub("displayError", (message) => calls.push(`${props.tag}:${message}`), bus);
            return null;
        }
        render(<View tag="first" />);
        render(<View tag="second" />);
        act(() => bus.pub("displayError", "boom"));
        expect(calls).toEqual(["second:boom"]);
        render(null);
        act(() => bus.pub("displayError", "again"));
        expect(calls).toEqual(["second:boom"]);
    });
});

describe("application host", () => {
    test("boots once, renders into its element and provides the application", async () => {
        const app = { name: "app" } as unknown as IApplication;
        const boot = rs.fn(async (container: HTMLElement) => {
            container.append(document.createElement("chili3d-test-window"));
            return app;
        });
        const ready = rs.fn((_app: IApplication) => {});
        function Probe() {
            return <i>{useApplication() === app ? "provided" : "missing"}</i>;
        }
        await act(async () =>
            root.render(
                <ChiliHost boot={boot} onReady={ready} fallback={<b>loading</b>}>
                    <Probe />
                </ChiliHost>,
            ),
        );
        expect(boot).toHaveBeenCalledTimes(1);
        expect(ready).toHaveBeenCalledWith(app);
        expect(host.querySelector("chili3d-test-window")).not.toBeNull();
        expect(host.textContent).toBe("provided");

        // A remount (Strict Mode, a route change) moves the same window into the new host.
        await act(async () => root.render(null));
        await act(async () => root.render(<ChiliHost boot={boot} />));
        expect(boot).toHaveBeenCalledTimes(1);
        expect(host.querySelector("chili3d-test-window")).not.toBeNull();
    });

    test("an island renders React into a legacy element and unmounts on dispose", () => {
        const element = document.createElement("div");
        const island = mountIsland(element, <p>first</p>);
        act(() => island.render(<p>second</p>));
        expect(element.textContent).toBe("second");
        act(() => island.dispose());
        expect(element.textContent).toBe("");
    });
});

describe("components", () => {
    test("DrawingView fits the drawing and dashes dashed layers", () => {
        const drawing: Drawing = {
            layers: [
                { name: "Cut", aci: 7, color: "#000" },
                { name: "Bend", aci: 1, color: "#f00", dashed: true },
            ],
            entities: [
                { kind: "line", layer: "Cut", a: [0, 0], b: [10, 0] },
                { kind: "arc", layer: "Bend", center: [5, 0], radius: 5, startAngle: 0, endAngle: 180 },
            ],
        };
        render(<DrawingView drawing={drawing} padding={1} title="Part" />);
        const svg = host.querySelector("svg");
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute("viewBox")).toBe("-1 -6 12 7");
        expect(host.querySelector('[data-layer="Bend"]')?.getAttribute("stroke-dasharray")).not.toBeNull();
        expect(host.querySelector('[data-layer="Cut"]')?.getAttribute("stroke-dasharray")).toBeNull();
        // Counter-clockwise from 0° to 180°, drawn inside the y-flip: SVG sweep-flag 1.
        expect(host.querySelector("path")?.getAttribute("d")).toMatch(/^M 10 0 A 5 5 0 0 1 0 [\d.e-]+$/);
    });

    test("LoadingScreen announces itself", () => {
        render(<LoadingScreen label="Booting" />);
        expect(host.querySelector('[role="status"]')?.textContent).toBe("Booting");
    });
});
