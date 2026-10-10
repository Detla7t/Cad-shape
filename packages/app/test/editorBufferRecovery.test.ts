// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    Constants,
    EDITOR_DRAFTS_KEY,
    type EditorBufferRegistration,
    EditorBuffers,
    type EditorDraftData,
    FolderNode,
    type IApplication,
    type IDocument,
    type IEditorBuffer,
    type INode,
    type IStorage,
    type IView,
    PubSub,
    Result,
    type UnsavedDecision,
} from "@chili3d/core";
import { createMockApplication, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { Document } from "../src/document";
import { AutosaveService } from "../src/services/autosaveService";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Draft implements IEditorBuffer {
    readonly editor = "text";
    draft = "saved";
    committed = "saved";
    registration: EditorBufferRegistration | undefined;

    constructor(
        readonly document: IDocument,
        readonly node: INode,
    ) {}

    isDirty() {
        return this.draft !== this.committed;
    }
    async commit() {
        this.committed = this.draft;
        return Result.ok(undefined);
    }
    revert() {
        this.draft = this.committed;
    }
    snapshot(): EditorDraftData | undefined {
        return this.isDirty() ? { data: this.draft, selection: { anchor: 0, head: 1 } } : undefined;
    }
    restore(draft: EditorDraftData) {
        this.draft = draft.data;
    }
    type(text: string) {
        this.draft = text;
        this.registration?.changed();
    }
}

/** An in-memory storage keeping what the document writes. */
function memoryStorage(): IStorage & { rows: Map<string, unknown> } {
    const rows = new Map<string, unknown>();
    const key = (table: string, id: string) => `${table}/${id}`;
    return {
        rows,
        createDBIfNeeded: async () => {},
        get: async (_db: string, table: string, id: string) => structuredClone(rows.get(key(table, id))),
        put: async (_db: string, table: string, id: string, value: unknown) => {
            rows.set(key(table, id), structuredClone(value));
            return true;
        },
        delete: async (_db: string, table: string, id: string) => rows.delete(key(table, id)),
        page: async () => [],
    } as unknown as IStorage & { rows: Map<string, unknown> };
}

describe("editor buffers in the document's recovery", () => {
    let app: IApplication;
    let storage: ReturnType<typeof memoryStorage>;
    let document: Document;
    let node: FolderNode;
    let buffer: Draft;
    let answer: UnsavedDecision;
    let asked: string[][];

    beforeEach(() => {
        storage = memoryStorage();
        app = createMockApplication({ storage });
        document = new Document(app, "doc");
        app.documents.add(document);
        node = new FolderNode({ document, name: "Studio" });
        document.modelManager.rootNode.add(node);
        buffer = new Draft(document, node);
        buffer.registration = EditorBuffers.register(buffer);
        answer = "cancel";
        asked = [];
        EditorBuffers.setPrompt({
            unsaved: async (buffers) => {
                asked.push(buffers.map((item) => item.node.name));
                return answer;
            },
            recovered: async () => "restore",
        });
    });

    afterEach(() => {
        buffer.registration?.dispose();
        EditorBuffers.setPrompt(undefined);
        EditorBuffers.forget(document);
        if (app.documents.has(document)) document.dispose();
    });

    const stored = () =>
        storage.rows.get(`${Constants.DocumentTable}/${document.id}`) as Record<string, unknown>;

    test("a save stores the dirty drafts outside the serialized document, and opening hands them back", async () => {
        buffer.type("draft");
        await document.save({ auto: true });
        expect(stored()[EDITOR_DRAFTS_KEY]).toEqual([
            expect.objectContaining({
                nodeId: node.id,
                editor: "text",
                name: "Studio",
                data: "draft",
                selection: { anchor: 0, head: 1 },
            }),
        ]);
        expect(document.serialize()[EDITOR_DRAFTS_KEY]).toBeUndefined();

        buffer.registration?.dispose();
        const reopened = await Document.open(app, document.id);
        expect(reopened).toBeDefined();
        try {
            expect(EditorBuffers.recoveredOf(reopened!).map((draft) => draft.data)).toEqual(["draft"]);
        } finally {
            EditorBuffers.forget(reopened!);
            reopened!.dispose();
        }
    });

    test("closing with a dirty editor: Cancel keeps the document open", async () => {
        buffer.type("draft");
        await document.close();
        expect(asked).toEqual([["Studio"]]);
        expect(app.documents.has(document)).toBe(true);
        expect(buffer.draft).toBe("draft");
    });

    test("closing with a dirty editor: Save commits the draft and saves the document", async () => {
        buffer.type("draft");
        answer = "save";
        const confirm = rs.spyOn(window, "confirm");
        try {
            await document.close();
            expect(confirm).not.toHaveBeenCalled();
        } finally {
            confirm.mockRestore();
        }
        expect(buffer.committed).toBe("draft");
        expect(app.documents.has(document)).toBe(false);
        expect(stored()).toBeDefined();
        expect(stored()[EDITOR_DRAFTS_KEY]).toBeUndefined();
    });

    test("closing with a dirty editor: Discard drops the draft and the stored recovery copy", async () => {
        buffer.type("draft");
        await document.save({ auto: true });
        expect(stored()[EDITOR_DRAFTS_KEY]).toHaveLength(1);
        answer = "discard";
        await document.close();
        expect(buffer.draft).toBe("saved");
        expect(app.documents.has(document)).toBe(false);
        expect(stored()[EDITOR_DRAFTS_KEY]).toBeUndefined();
        expect(stored()["name"]).toBe("doc");
    });

    test("without dirty editors the close asks the usual save question", async () => {
        const confirm = rs.spyOn(window, "confirm").mockReturnValue(false);
        try {
            await document.close();
            expect(confirm).toHaveBeenCalledTimes(1);
        } finally {
            confirm.mockRestore();
        }
        expect(asked).toEqual([]);
        expect(app.documents.has(document)).toBe(false);
    });
});

describe("AutosaveService and editor drafts", () => {
    const previous = Config.instance.preferences;

    afterEach(() => {
        Config.instance.preferences = previous;
    });

    test("a draft edit schedules a recovery save, and leaving the page runs pending saves at once", async () => {
        Config.instance.preferences = { ...previous, autosave: true };
        const app = createMockApplication();
        const document = new Document(app, "doc");
        app.documents.add(document);
        const saves: (boolean | undefined)[] = [];
        rs.spyOn(document, "save").mockImplementation(async (options) => {
            saves.push(options?.auto);
        });
        const service = new AutosaveService(20);
        service.register(app);
        service.start();
        PubSub.default.pub("activeViewChanged", createMockView({ document }) as IView);
        const node = new FolderNode({ document, name: "Notes" });
        const buffer = new Draft(document, node);
        buffer.registration = EditorBuffers.register(buffer);
        try {
            saves.length = 0;
            buffer.type("a");
            buffer.type("ab");
            await tick(60);
            expect(saves).toEqual([true]);

            buffer.type("abc");
            window.dispatchEvent(new Event("pagehide"));
            expect(saves).toEqual([true, true]);
            await tick(60);
            expect(saves).toEqual([true, true]);

            // Back to clean: one more save drops the stored draft; a clean editor's further
            // notifications (cursor moves) save nothing.
            buffer.type("saved");
            await tick(60);
            expect(saves).toEqual([true, true, true]);
            buffer.registration.changed();
            await tick(60);
            expect(saves).toEqual([true, true, true]);
        } finally {
            buffer.registration.dispose();
            service.stop();
            document.dispose();
        }
    });
});
