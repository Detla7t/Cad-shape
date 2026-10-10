// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Constants, DocumentLibrary, type IWindow, PubSub } from "@chili3d/core";
import { createMockApplication, createMockDocument, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { Home } from "../src/home/home";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function click(root: ParentNode, name: string) {
    const control = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.getAttribute("aria-label") === name || item.textContent === name,
    );
    expect(control).not.toBeUndefined();
    control!.click();
}
async function fixture() {
    const records = new Map<string, unknown>([
        [`${Constants.RecentTable}/a`, { id: "a", name: "Bracket", date: 10, image: "", branch: "Design" }],
        [`${Constants.RecentTable}/b`, { id: "b", name: "Cylinder", date: 20, image: "" }],
    ]);
    const app = createMockApplication({
        storage: {
            get: async (_db, table, id) => structuredClone(records.get(`${table}/${id}`)),
            put: async (_db, table, id, value) => {
                records.set(`${table}/${id}`, structuredClone(value));
                return true;
            },
            page: async (_db, table, page) =>
                page === 0
                    ? [...records]
                          .filter(([key]) => key.startsWith(`${table}/`))
                          .map(([, value]) => structuredClone(value))
                    : [],
        },
    });
    Object.defineProperty(app, "mainWindow", { value: document.body as unknown as IWindow });
    const home = new Home(app);
    await home.render();
    return { home, app, records };
}
afterEach(() => {
    document.querySelectorAll("chili-home, dialog").forEach((item) => {
        item.remove();
    });
    rs.restoreAllMocks();
});

test("row trash action keeps the document closed, preserves organization, and restores it from Trash", async () => {
    const { home, app } = await fixture();
    const open = rs.spyOn(app, "openDocument");
    const library = new DocumentLibrary(app.storage);
    await library.update("a", { labels: ["ready"], folderId: "parts" });
    const row = home.querySelector('tr[data-document-id="a"]');
    expect(row).not.toBeNull();
    click(row!, "Send to trash");
    await flush();
    expect(home.querySelector('tr[data-document-id="a"]')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    click(home, "Trash");
    const trash = home.querySelector('tr[data-document-id="a"]');
    expect(trash).not.toBeNull();
    click(trash!, "Restore");
    await flush();
    expect(home.querySelectorAll("tbody tr")).toHaveLength(0);
    click(home, "Owned by me");
    expect(home.querySelectorAll("tbody tr")).toHaveLength(2);
    const metadata = (await library.list()).documents.find((item) => item.id === "a")!.metadata;
    expect(metadata.labels).toEqual(["ready"]);
    expect(metadata.folderId).toBe("parts");
    expect(metadata.trashedAt).toBeUndefined();
});

test("label edits are explicit drafts, persist on Apply, and filter/search the document list", async () => {
    const { home, app } = await fixture();
    const library = new DocumentLibrary(app.storage);
    const label = await library.createLabel("Ready");
    // Refresh through the same event raised by a document save.
    PubSub.default.pub("documentSaved", createMockDocument());
    await flush();
    const row = home.querySelector('tr[data-document-id="a"]');
    expect(row).not.toBeNull();
    click(row!, "Label");
    let dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    let check = dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(check).not.toBeNull();
    check!.click();
    click(dialog!, "Cancel");
    expect((await library.list()).documents[0].metadata.labels).toEqual([]);
    click(row!, "Label");
    dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    check = dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(check).not.toBeNull();
    check!.click();
    click(dialog!, "Apply");
    await flush();
    expect((await library.list()).documents[0].metadata.labels).toEqual([label.id]);
    const search = home.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    search!.value = "Ready";
    search!.dispatchEvent(new Event("input"));
    expect(home.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(home.querySelector("tbody tr")!.getAttribute("data-document-id")).toBe("a");
    home.remove();
    const reopened = new Home(app);
    await reopened.render();
    click(reopened, "Ready");
    expect(reopened.querySelectorAll("tbody tr")).toHaveLength(1);
});

test("opening an existing document activates its view and records last opened without creating a second view", async () => {
    const { home, app } = await fixture();
    const first = createMockDocument();
    Object.defineProperty(first, "id", { value: "a" });
    const second = createMockDocument();
    Object.defineProperty(second, "id", { value: "b" });
    const firstView = createMockView({ document: first });
    const secondView = createMockView({ document: second });
    app.views.push(firstView, secondView);
    app.activeView = secondView;
    const open = rs.spyOn(app, "openDocument");
    const row = home.querySelector('tr[data-document-id="a"]');
    expect(row).not.toBeNull();
    click(row!, "Bracket");
    await flush();
    expect(app.activeView).toBe(firstView);
    expect(app.views.length).toBe(2);
    expect(open).not.toHaveBeenCalled();
    expect((await new DocumentLibrary(app.storage).list()).documents[0].metadata.lastOpened).toBeGreaterThan(
        20,
    );
});
