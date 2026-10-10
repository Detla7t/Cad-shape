// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication, IView } from "@chili3d/core";
import { TestDocument, TestFeatureListNode } from "@chili3d/core/test-utils";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandWindow } from "../src/console/commandWindow";
import { ConsoleEngine } from "../src/console/consoleEngine";
import { mustQuery } from "./_helpers/domHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function fixture() {
    const document = new TestDocument();
    document.modelManager.addNode(new TestFeatureListNode(document, "Bracket", [{ id: "f1" }]));
    document.variables.setItems([{ id: "v1", name: "width", type: "length", expression: "40 mm" }]);
    const view = { document, cameraController: {}, update: () => {} } as unknown as IView;
    const engine = new ConsoleEngine({ activeView: view } as unknown as IApplication);
    const closed: number[] = [];
    act(() => root.render(<CommandWindow engine={engine} onClose={() => closed.push(1)} />));
    return { engine, closed };
}

const input = () => mustQuery<HTMLInputElement>(host, 'input[aria-label="Command line"]');
function type(text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input(), text);
        input().dispatchEvent(new Event("input", { bubbles: true }));
    });
}
function key(name: string) {
    act(() => {
        input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    });
}
const flush = () => act(async () => {});

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

test("the input sits on top; typing lists suggestions with syntax and description, Tab accepts, the explanation follows", () => {
    fixture();
    const pane = mustQuery<HTMLElement>(host, 'section[aria-label="Command window"]');
    expect(pane.querySelector('[role="combobox"]')).toBe(input());
    // Nothing typed: no suggestions, an invitation in the explanation.
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.textContent).toContain("HELP lists them all");

    type("loo");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.querySelector("span")?.textContent)).toEqual(["LOOKUP"]);
    expect(options[0].textContent).toContain("LOOKUP <search>");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    const about = mustQuery<HTMLElement>(host, 'section[aria-label="About lookup"]');
    expect(about.querySelector("h4")?.textContent).toBe("LOOKUP");
    expect(about.textContent).toContain("--limit <n>");
    expect(about.textContent).toContain("LOOKUP endcap --exact");

    key("Tab");
    expect(input().value).toBe("LOOKUP ");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
});

test("an expression previews under the line; Enter runs it into the log and the preview pane", async () => {
    const { engine } = fixture();
    type("width / 2");
    expect(mustQuery<HTMLElement>(host, "[data-preview]").textContent).toBe("= 20.00 mm");
    key("Enter");
    await flush();
    expect(input().value).toBe("");
    expect(engine.history.map((entry) => entry.input)).toEqual(["width / 2"]);
    const log = mustQuery<HTMLElement>(host, '[role="log"]');
    expect(log.textContent).toContain("width / 2");
    expect(log.textContent).toContain("-> 20.00 mm");
    expect(mustQuery<HTMLElement>(host, 'section[aria-label="Preview"]').textContent).toContain(
        "-> 20.00 mm",
    );

    type("lookup bracket");
    key("Enter");
    await flush();
    const preview = mustQuery<HTMLElement>(host, 'section[aria-label="Preview"]');
    expect(preview.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(preview.textContent).toContain("Bracket");
    // The history tab keeps only what changed or ran a tool; the console keeps everything.
    act(() => mustQuery<HTMLButtonElement>(host, 'button[role="tab"]:nth-child(2)').click());
    expect(mustQuery<HTMLElement>(host, '[role="log"]').getAttribute("aria-label")).toBe("History");
    expect(mustQuery<HTMLElement>(host, '[role="log"]').textContent).toContain("width / 2");
    expect(mustQuery<HTMLElement>(host, '[role="log"]').textContent).not.toContain("lookup bracket");
});

test("arrows recall earlier lines when no suggestion is open; Escape clears, then closes", async () => {
    const { closed } = fixture();
    type("= 1 + 1");
    key("Enter");
    await flush();
    key("ArrowUp");
    expect(input().value).toBe("= 1 + 1");
    key("ArrowDown");
    expect(input().value).toBe("");
    type("abc");
    key("Escape");
    expect(input().value).toBe("");
    expect(closed).toEqual([]);
    key("Escape");
    expect(closed).toEqual([1]);
});
