// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, Constants, DocumentLibrary, type DocumentUnits, documentUnits } from "@chili3d/core";
import { createMockApplication, createMockDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { showNewDocumentDialog } from "../src/home/newDocumentDialog";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const preferences = structuredClone(Config.instance.preferences);
afterEach(() => {
    document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
    Config.instance.preferences = structuredClone(preferences);
    rs.restoreAllMocks();
});
function button(dialog: HTMLDialogElement, name: string) {
    const result = [...dialog.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === name || b.textContent === name,
    );
    expect(result).not.toBeUndefined();
    return result!;
}
function control<T extends HTMLInputElement | HTMLSelectElement>(dialog: HTMLDialogElement, name: string): T {
    const result = dialog.querySelector<T>(`[aria-label="${name}"]`);
    expect(result).not.toBeNull();
    return result!;
}
function setup() {
    const records = new Map<string, unknown>();
    const app = createMockApplication({
        storage: {
            page: async (_db, table, page) =>
                page === 0
                    ? [...records]
                          .filter(([key]) => key.startsWith(`${table}/`))
                          .map(([, value]) => structuredClone(value))
                    : [],
            get: async (_db, table, id) => structuredClone(records.get(`${table}/${id}`)),
            put: async (_db, table, id, value) => {
                records.set(`${table}/${id}`, structuredClone(value));
                return true;
            },
        },
    });
    const doc = createMockDocument({ application: app, id: "new-document" });
    const create = rs
        .spyOn(app, "newDocument")
        .mockImplementation(async (_name: string, units?: DocumentUnits) => {
            doc.userData = { displayUnits: units };
            return doc;
        });
    const save = rs.spyOn(doc, "save").mockResolvedValue(undefined);
    return { app, doc, create, save, records, library: new DocumentLibrary(app.storage) };
}

test("starts with the user's units and cancel does not create a document or change preferences", async () => {
    const { app, create } = setup();
    Config.instance.preferences = {
        ...preferences,
        defaultUnits: { length: "in", angle: "rad", lengthPrecision: 4, anglePrecision: 3 },
    };
    const dialog = await showNewDocumentDialog(app);
    expect(control(dialog, "Length units").value).toBe("in");
    expect(control(dialog, "Angle units").value).toBe("rad");
    control(dialog, "Length units").value = "cm";
    button(dialog, "Cancel").click();
    expect(create).not.toHaveBeenCalled();
    expect(Config.instance.preferences.defaultUnits.length).toBe("in");
    expect(document.querySelector("dialog")).toBeNull();
});

test("creates and saves the chosen name, units, labels and location without changing account defaults", async () => {
    const { app, doc, create, save, library, records } = setup();
    const folder = await library.createFolder("Projects");
    const label = await library.createLabel("Workshop");
    await library.createLabel("Other");
    const dialog = await showNewDocumentDialog(app);
    control(dialog, "Document name").value = "  Cylinder  ";
    control(dialog, "Length units").value = "in";
    control(dialog, "Angle units").value = "rad";
    const search = control<HTMLInputElement>(dialog, "Search labels");
    search.value = "work";
    search.dispatchEvent(new Event("input"));
    const checks = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checks).toHaveLength(1);
    checks[0].click();
    button(dialog, "Open folder Projects").click();
    expect(dialog.querySelector('[aria-label="Document location"]')!.textContent).toContain("Projects");
    button(dialog, "Create document").click();
    await flush();
    expect(create).toHaveBeenCalledWith("Cylinder", {
        ...preferences.defaultUnits,
        length: "in",
        angle: "rad",
    });
    expect(doc.name).toBe("Cylinder");
    expect(documentUnits(doc).length).toBe("in");
    expect(save).toHaveBeenCalledTimes(1);
    expect(records.get(`${Constants.LibraryTable}/document:new-document`)).toMatchObject({
        folderId: folder.id,
        labels: [label.id],
    });
    expect(Config.instance.preferences.defaultUnits).toEqual(preferences.defaultUnits);
    expect(document.querySelector("dialog")).toBeNull();
});

test("a failed save stays visible and retries the same document", async () => {
    const { app, save, create } = setup();
    save.mockRejectedValueOnce(new Error("Storage is full"));
    const dialog = await showNewDocumentDialog(app);
    button(dialog, "Create document").click();
    await flush();
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe("Storage is full");
    expect(dialog.isConnected).toBe(true);
    button(dialog, "Create document").click();
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(dialog.isConnected).toBe(false);
});
