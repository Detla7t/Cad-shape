// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    Constants,
    FolderNode,
    type IApplication,
    type IView,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { createMockApplication, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { Document } from "../../src/document";
import { AutosaveService } from "../../src/services/autosaveService";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("AutosaveService", () => {
    let app: IApplication;
    let document: Document;
    let service: AutosaveService;
    let saves: { auto: boolean | undefined }[];
    const previous = Config.instance.preferences;

    beforeEach(() => {
        app = createMockApplication();
        document = new Document(app, "autosaved");
        app.documents.add(document);
        saves = [];
        rs.spyOn(document, "save").mockImplementation(async (options) => {
            saves.push({ auto: options?.auto });
        });
        service = new AutosaveService(20);
        service.register(app);
        service.start();
        PubSub.default.pub("activeViewChanged", createMockView({ document }) as IView);
    });

    afterEach(() => {
        service.stop();
        Config.instance.preferences = previous;
        document.dispose();
    });

    function edit(name: string) {
        Transaction.execute(document, "add", () =>
            document.modelManager.rootNode.add(new FolderNode({ document, name })),
        );
    }

    test("a burst of changes becomes one recovery save after the idle delay", async () => {
        edit("A");
        edit("B");
        expect(saves).toEqual([]);
        await tick(60);
        expect(saves).toEqual([{ auto: true }]);
        edit("C");
        await tick(60);
        expect(saves).toHaveLength(2);
    });

    test("the preference turns autosave off, and stopping the service drops pending saves", async () => {
        Config.instance.preferences = { ...previous, autosave: false };
        edit("A");
        await tick(60);
        expect(saves).toEqual([]);
        Config.instance.preferences = { ...previous, autosave: true };
        edit("B");
        service.stop();
        await tick(60);
        expect(saves).toEqual([]);
        expect(service.documents).toEqual([]);
    });

    test("a closed document is no longer followed", async () => {
        PubSub.default.pub("documentClosed", document);
        expect(service.documents).toEqual([]);
        edit("A");
        await tick(60);
        expect(saves).toEqual([]);
    });
});

describe("Document recovery saves", () => {
    test("an autosave keeps the stored thumbnail and publishes documentAutosaved, not documentSaved", async () => {
        const app = createMockApplication();
        const document = new Document(app, "doc");
        const view = createMockView({ document });
        let rendered = 0;
        view.toThumbnail = () => {
            rendered++;
            return "data:image/png;base64,fresh";
        };
        app.views.push(view);
        (app as { activeView?: IView }).activeView = view;
        app.storage.get = async (_db, table) =>
            table === Constants.RecentTable ? { image: "data:image/png;base64,stored" } : undefined;
        const writes: { table: string; value: unknown }[] = [];
        app.storage.put = async (_db, table, _id, value) => {
            writes.push({ table, value });
            return true;
        };
        const events: string[] = [];
        const onSaved = () => events.push("saved");
        const onAutosaved = () => events.push("autosaved");
        PubSub.default.sub("documentSaved", onSaved);
        PubSub.default.sub("documentAutosaved", onAutosaved);
        try {
            await document.save({ auto: true });
            expect(rendered).toBe(0);
            expect(writes.find((w) => w.table === Constants.RecentTable)?.value).toMatchObject({
                image: "data:image/png;base64,stored",
            });
            expect(writes.some((w) => w.table === Constants.DocumentTable)).toBe(true);
            expect(events).toEqual(["autosaved"]);
            await document.save();
            expect(rendered).toBe(1);
            expect(events).toEqual(["autosaved", "saved"]);
        } finally {
            PubSub.default.remove("documentSaved", onSaved);
            PubSub.default.remove("documentAutosaved", onAutosaved);
            document.dispose();
        }
    });
});
