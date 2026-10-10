// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, type IView, PubSub } from "@chili3d/core";
import { rs } from "@rstest/core";
import { showActionMenu } from "../src/project/nodeContextMenu";
import { printView, showDocumentTabMenu } from "../src/ribbon/documentTabMenu";

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

function fakeView(name = "Bracket") {
    const closed: string[] = [];
    const view = {
        document: { name, close: async () => void closed.push(name) },
        toImage: () => "data:image/png;base64,AAAA",
    } as unknown as IView;
    return { view, closed };
}

afterEach(() => {
    document.body.querySelectorAll('[role="menu"]').forEach((el) => el.remove());
    rs.restoreAllMocks();
});

test("the tab menu makes the document active and offers save, save to, print, export, settings and close", async () => {
    const { view, closed } = fakeView();
    let active: IView | undefined;
    const app = {
        get activeView() {
            return active;
        },
        set activeView(value: IView | undefined) {
            active = value;
        },
    } as unknown as IApplication;
    const published: unknown[][] = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation(((...args: unknown[]) => {
        published.push(args);
    }) as typeof PubSub.default.pub);

    showDocumentTabMenu(app, view, 40, 30);
    expect(active).toBe(view);
    expect(menu()?.getAttribute("aria-label")).toBe("Bracket tab");
    expect(items().map((item) => item.textContent)).toEqual([
        "Save",
        "Save to…",
        "Print…",
        "Export…",
        "Document settings…",
        "Close",
    ]);
    // Separators before the settings and the close entries.
    expect(menu()?.querySelectorAll("hr")).toHaveLength(2);

    items()[0].click();
    await Promise.resolve();
    expect(published.at(-1)).toEqual(["executeCommand", "doc.save"]);
    expect(menu()).toBeNull();

    showDocumentTabMenu(app, view, 40, 30);
    items()[4].click();
    await Promise.resolve();
    expect(published.at(-1)).toEqual(["openPreferences", view.document, "document"]);

    showDocumentTabMenu(app, view, 40, 30);
    items()[5].click();
    await Promise.resolve();
    expect(closed).toEqual(["Bracket"]);
});

test("print opens a page with the view's image that prints itself; a blocked window is reported", () => {
    const { view } = fakeView("Plate <1>");
    const written: string[] = [];
    const page = {
        document: { write: (html: string) => void written.push(html), close: () => {} },
    } as unknown as Window;
    const open = rs.spyOn(window, "open").mockReturnValue(page);
    printView(view);
    expect(open).toHaveBeenCalledWith("", "_blank", "noopener");
    expect(written[0]).toContain('<img src="data:image/png;base64,AAAA"');
    expect(written[0]).toContain('onload="window.print()"');
    expect(written[0]).toContain("<title>Plate 1</title>");

    open.mockReturnValue(null);
    const errors: unknown[][] = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation(((...args: unknown[]) => {
        errors.push(args);
    }) as typeof PubSub.default.pub);
    printView(view);
    expect(errors).toEqual([["displayError", "The browser blocked the print window."]]);
});

test("an action menu runs the chosen action, closes, and closes on Escape or an outside click", async () => {
    const ran: string[] = [];
    showActionMenu(
        [
            { id: "a", label: "First", run: () => void ran.push("a") },
            { id: "b", label: "Second", icon: "save", separatorBefore: true, run: () => void ran.push("b") },
        ],
        10,
        10,
        { label: "Options" },
    );
    expect(menu()?.getAttribute("aria-label")).toBe("Options");
    expect(items()[1].querySelector("svg")).not.toBeNull();
    items()[1].click();
    await Promise.resolve();
    expect(ran).toEqual(["b"]);
    expect(menu()).toBeNull();

    showActionMenu([{ id: "a", label: "First", run: () => {} }], 10, 10);
    menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeNull();

    showActionMenu([{ id: "a", label: "First", run: () => {} }], 10, 10);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
});
