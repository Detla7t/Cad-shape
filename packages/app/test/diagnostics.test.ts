// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    DocumentVersionControl,
    FolderNode,
    type IView,
    Observable,
    OperationLog,
    PubSub,
    property,
    Transaction,
} from "@chili3d/core";
import { createMockApplication, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { applicationState, installDiagnostics } from "../src/diagnostics";
import { Document } from "../src/document";
import { commandParameters } from "../src/services/commandService";

beforeEach(() => {
    rs.spyOn(console, "error").mockImplementation(() => {});
    rs.spyOn(console, "warn").mockImplementation(() => {});
    rs.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
    OperationLog.clear();
    rs.restoreAllMocks();
});

test("installing diagnostics stamps the session and turns user-facing and unhandled errors into events", () => {
    const app = createMockApplication();
    const diagnostics = installDiagnostics(app);
    try {
        expect(OperationLog.sessionContext).toMatchObject({ appVersion: expect.any(String) });
        PubSub.default.pub("displayError", "Rectangle sides are too small");
        globalThis.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
        const [ui, unhandled] = OperationLog.snapshot();
        expect(ui).toMatchObject({
            operation: "ui.error",
            outcome: "error",
            context: { message: "Rectangle sides are too small" },
            state: { documents: 0, views: 0 },
        });
        expect(unhandled).toMatchObject({ operation: "app.unhandledError", outcome: "error" });
        expect(unhandled.error?.message).toBe("boom");
    } finally {
        diagnostics.dispose();
    }
    PubSub.default.pub("displayError", "after dispose");
    expect(OperationLog.snapshot()).toHaveLength(2);
});

test("every event carries the document, history head, selection, view and preferences", () => {
    const app = createMockApplication();
    const document = new Document(app, "Bracket");
    const control = DocumentVersionControl.create(document);
    const view = createMockView({ document });
    (app as { activeView?: IView }).activeView = view;
    app.views.push(view);
    app.documents.add(document);
    try {
        Transaction.execute(document, "add", () =>
            document.modelManager.rootNode.add(new FolderNode({ document, name: "A" })),
        );
        control.flush();
        document.selection.setSelectedNodes(document.modelManager.findNodes(), false);
        const state = applicationState(app);
        expect(state).toMatchObject({
            documentId: document.id,
            documentName: "Bracket",
            lengthUnit: "mm",
            nodes: 1,
            undoDepth: 1,
            redoDepth: 0,
            branch: "Main",
            head: control.head,
            pendingOperations: 1,
            views: 1,
            documents: 1,
            cameraType: view.cameraController.cameraType,
            snap: Config.instance.enableSnap,
            autosave: Config.instance.preferences.autosave,
        });
        expect(state["selectedNodes"]).toBe(1);
    } finally {
        control.dispose();
        document.dispose();
    }
});

test("command parameters are recorded as scalar param fields", () => {
    class Fake extends Observable {
        @property("common.name")
        get depth() {
            return this.getPrivateValue("depth", 25);
        }
        set depth(value: number) {
            this.setProperty("depth", value);
        }
        @property("common.name")
        get operation() {
            return this.getPrivateValue("operation", "option.command.operation.new");
        }
        set operation(value: string) {
            this.setProperty("operation", value);
        }
        @property("common.name")
        get symmetric() {
            return this.getPrivateValue("symmetric", false);
        }
        set symmetric(value: boolean) {
            this.setProperty("symmetric", value);
        }
        @property("common.name")
        get shape() {
            return { heavy: true };
        }
        @property("common.confirm")
        readonly confirm = () => {};
    }
    expect(commandParameters(new Fake())).toEqual({
        "param.depth": 25,
        "param.operation": "option.command.operation.new",
        "param.symmetric": false,
        "param.shape": "[object Object]",
    });
});
