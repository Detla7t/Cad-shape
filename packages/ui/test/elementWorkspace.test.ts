// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    type DialogButton,
    type I18nKeys,
    type IApplication,
    type IDisposable,
    type IDocument,
    Id,
    type ISelection,
    type IView,
    Node,
    openElement,
    PubSub,
    registerElementKind,
    registerElementView,
    serializable,
    showPartStudio,
    Transaction,
    type VariableData,
    VariableStudioNode,
} from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import { mustQuery } from "./_helpers/domHelpers";

rs.mock("../src/elements/elements.module.css", () => ({
    strip: "el-strip",
    add: "el-add",
    addIcon: "el-add-icon",
    tabs: "el-tabs",
    tab: "el-tab",
    active: "el-active",
    icon: "el-icon",
    name: "el-name",
    rename: "el-rename",
    menu: "el-menu",
    menuItem: "el-menu-item",
    menuIcon: "el-menu-icon",
    disabled: "el-disabled",
    frame: "el-frame",
    placeholder: "el-placeholder",
    confirm: "el-confirm",
    variableStudio: "el-variable-studio",
    studioHeader: "el-studio-header",
    studioIcon: "el-studio-icon",
    studioTitle: "el-studio-title",
    studioHint: "el-studio-hint",
    studioBody: "el-studio-body",
}));

rs.mock("../src/property/variables/variablesEditor.module.css", () => ({
    root: "v-root",
    table: "v-table",
    rows: "v-rows",
    row: "v-row",
    newRow: "v-new-row",
    header: "v-header",
    cell: "v-cell",
    field: "v-field",
    value: "v-value",
    nameCell: "v-name-cell",
    marker: "v-marker",
    hasNote: "v-has-note",
    notePopup: "v-note-popup",
    noteInput: "v-note-input",
    error: "v-error",
    errorRow: "v-error-row",
    warningRow: "v-warning-row",
    actions: "v-actions",
    iconButton: "v-icon-button",
    danger: "v-danger",
}));

import { ElementWorkspace, PART_STUDIO_ID } from "../src/elements/elementWorkspace";
import "../src/elements/variableStudioElement";

/** A node kind standing in for a Feature Studio: an element whose view the test controls. */
@serializable()
class ScriptNode extends Node {
    constructor(options: { document: IDocument; name: string; id?: string }) {
        super(options.document, options.name, options.id ?? Id.generate());
    }
    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}
}

interface FakeView {
    readonly element: HTMLElement;
    readonly node: ScriptNode;
    readonly dispose: ReturnType<typeof rs.fn>;
    readonly activated: ReturnType<typeof rs.fn>;
}

let views: FakeView[] = [];
let registrations: IDisposable[] = [];

beforeEach(() => {
    views = [];
    registrations = [
        registerElementKind({
            kind: "script",
            icon: "icon-macro",
            display: "featurescript.studio",
            isElement: (node) => node instanceof ScriptNode,
            newCommand: "featurescript.newStudio",
        }),
        registerElementView("script", (node) => {
            const element = document.createElement("div");
            element.textContent = `editor of ${node.name}`;
            const view = { element, node: node as ScriptNode, dispose: rs.fn(), activated: rs.fn() };
            views.push(view);
            return view;
        }),
    ];
});

const workspaces: ElementWorkspace[] = [];

afterEach(() => {
    for (const workspace of workspaces.splice(0)) workspace.disconnect();
    for (const registration of registrations) registration.dispose();
    document.body.innerHTML = "";
});

/** An application whose `activeView` setter announces the change, as the real one does. */
function application(): IApplication {
    const app = createMockApplication();
    let active: IView | undefined;
    Object.defineProperty(app, "activeView", {
        configurable: true,
        get: () => active,
        set: (view: IView | undefined) => {
            active = view;
            PubSub.default.pub("activeViewChanged", view);
        },
    });
    return app;
}

function addDocument(app: IApplication): { document: TestDocument; view: IView } {
    const selection = { clearSelection: rs.fn() } as unknown as ISelection;
    const doc = new TestDocument({ application: app, selection });
    const view = { document: doc } as unknown as IView;
    app.views.push(view);
    return { document: doc, view };
}

function setup() {
    const app = application();
    const { document: doc, view } = addDocument(app);
    const partStudio = document.createElement("div");
    const viewArea = document.createElement("div");
    const workspace = new ElementWorkspace(app, partStudio, viewArea);
    workspaces.push(workspace);
    document.body.append(partStudio, viewArea, workspace.strip);
    app.activeView = view;
    workspace.connect();
    return { app, doc, view, workspace, partStudio, viewArea, strip: workspace.strip };
}

function add<T extends Node>(doc: TestDocument, node: T): T {
    Transaction.execute(doc, "add", () => doc.modelManager.addNode(node));
    return node;
}

const tabs = (strip: HTMLElement) => [...strip.querySelectorAll<HTMLElement>(".el-tab")];
const tabNames = (strip: HTMLElement) => tabs(strip).map((tab) => tab.textContent);
const tabOf = (strip: HTMLElement, id: string) => mustQuery<HTMLElement>(strip, `[data-element-id="${id}"]`);
const activeTab = (strip: HTMLElement) => mustQuery<HTMLElement>(strip, ".el-active").dataset["elementId"];
const isHidden = (element: HTMLElement) => element.style.display === "none";

function rightClick(element: HTMLElement): HTMLElement {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 500 }));
    return mustQuery<HTMLElement>(document.body, ".el-menu");
}

function menuItem(menu: HTMLElement, label: I18nKeys): HTMLElement {
    const item = [...menu.querySelectorAll<HTMLElement>(".el-menu-item")].find(
        (candidate) => candidate.textContent === label,
    );
    expect(item).toBeDefined();
    return item as HTMLElement;
}

describe("the element tab strip", () => {
    test("lists the Part Studio, then the document's elements in model-tree order", () => {
        const { doc, strip } = setup();
        add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        add(doc, new VariableStudioNode({ document: doc, name: "Variable Studio 1" }));

        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1", "Variable Studio 1"]);
        expect(tabs(strip).map((tab) => tab.dataset["kind"])).toEqual([
            "partStudio",
            "script",
            "variableStudio",
        ]);
        expect(activeTab(strip)).toBe(PART_STUDIO_ID);
    });

    test("follows nodes being added, renamed and removed — and undo of each", async () => {
        const { doc, strip } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1"]);

        Transaction.execute(doc, "rename", () => {
            script.name = "Bracket";
        });
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Bracket"]);
        await doc.history.undo();
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1"]);

        Transaction.execute(doc, "remove", () => script.parent?.remove(script));
        expect(tabNames(strip)).toEqual(["elements.partStudio1"]);
        await doc.history.undo();
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1"]);

        // Undoing the creation itself takes the tab away again.
        await doc.history.undo();
        await doc.history.undo();
        expect(tabNames(strip)).toEqual(["elements.partStudio1"]);
    });

    test("is hidden while no document is open", () => {
        const { app, strip } = setup();
        expect(isHidden(strip)).toBe(false);
        app.activeView = undefined;
        expect(isHidden(strip)).toBe(true);
        expect(tabs(strip)).toHaveLength(0);
    });
});

describe("switching elements", () => {
    test("a tab swaps the Part Studio for the element's full-size view, built once", () => {
        const { doc, strip, partStudio, viewArea } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        expect(isHidden(partStudio)).toBe(false);
        expect(isHidden(viewArea)).toBe(true);

        tabOf(strip, script.id).click();
        expect(activeTab(strip)).toBe(script.id);
        expect(isHidden(partStudio)).toBe(true);
        expect(isHidden(viewArea)).toBe(false);
        expect(views).toHaveLength(1);
        const frame = mustQuery<HTMLElement>(viewArea, `[data-element-id="${script.id}"]`);
        expect(frame.contains(views[0].element)).toBe(true);
        expect(isHidden(frame)).toBe(false);
        expect(views[0].activated).toHaveBeenCalledTimes(1);

        tabOf(strip, PART_STUDIO_ID).click();
        expect(isHidden(partStudio)).toBe(false);
        expect(isHidden(viewArea)).toBe(true);
        // Kept mounted, only hidden — a draft in it survives the switch.
        expect(viewArea.contains(views[0].element)).toBe(true);

        tabOf(strip, script.id).click();
        expect(views).toHaveLength(1);
        expect(views[0].activated).toHaveBeenCalledTimes(2);
    });

    test("only the active element's view is visible", () => {
        const { doc, strip, viewArea } = setup();
        const first = add(doc, new ScriptNode({ document: doc, name: "A" }));
        const second = add(doc, new ScriptNode({ document: doc, name: "B" }));
        tabOf(strip, first.id).click();
        tabOf(strip, second.id).click();
        const frames = [...viewArea.querySelectorAll<HTMLElement>(".el-frame")];
        expect(frames.map((frame) => [frame.dataset["elementId"], isHidden(frame)])).toEqual([
            [first.id, true],
            [second.id, false],
        ]);
    });

    test("deleting the open element disposes its view and falls back to the Part Studio", () => {
        const { doc, strip, partStudio } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        tabOf(strip, script.id).click();

        Transaction.execute(doc, "remove", () => script.parent?.remove(script));

        expect(views[0].dispose).toHaveBeenCalledTimes(1);
        expect(activeTab(strip)).toBe(PART_STUDIO_ID);
        expect(isHidden(partStudio)).toBe(false);
    });

    test("each document keeps its own active element across document switches", () => {
        const { app, doc, view, strip, partStudio } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        const other = addDocument(app);
        add(other.document, new VariableStudioNode({ document: other.document, name: "Variable Studio 1" }));
        tabOf(strip, script.id).click();

        app.activeView = other.view;
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Variable Studio 1"]);
        expect(activeTab(strip)).toBe(PART_STUDIO_ID);
        expect(isHidden(partStudio)).toBe(false);

        app.activeView = view;
        expect(activeTab(strip)).toBe(script.id);
        expect(isHidden(partStudio)).toBe(true);
    });

    test("openElement switches to the element's document and tab", () => {
        const { app, strip } = setup();
        const other = addDocument(app);
        const script = add(other.document, new ScriptNode({ document: other.document, name: "Elsewhere" }));

        openElement(other.document, script);

        expect(app.activeView).toBe(other.view);
        expect(activeTab(strip)).toBe(script.id);
    });

    test("double-clicking an element in the model tree opens its tab", () => {
        const { doc, strip } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        PubSub.default.pub("nodeDoubleClicked", script);
        expect(activeTab(strip)).toBe(script.id);
    });

    test("a command bringing the viewport forward shows the Part Studio again", () => {
        const { doc, strip, workspace, partStudio } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        tabOf(strip, script.id).click();
        workspace.showPartStudio();
        expect(activeTab(strip)).toBe(PART_STUDIO_ID);
        expect(isHidden(partStudio)).toBe(false);
    });

    test("showing another document's Part Studio applies when that document comes back", () => {
        const { app, doc, view, strip } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        tabOf(strip, script.id).click();
        const other = addDocument(app);
        app.activeView = other.view;

        showPartStudio(doc);
        expect(tabNames(strip)).toEqual(["elements.partStudio1"]);

        app.activeView = view;
        expect(activeTab(strip)).toBe(PART_STUDIO_ID);
    });
});

describe("renaming, duplicating and deleting from the strip", () => {
    test("double-click renames in place — Enter commits one undo step, Escape cancels", async () => {
        const { doc, strip } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        const undoBefore = doc.history.undoCount();

        tabOf(strip, script.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const box = mustQuery<HTMLInputElement>(strip, "input.el-rename");
        expect(box.value).toBe("Script 1");
        box.value = "Bracket";
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        expect(script.name).toBe("Bracket");
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Bracket"]);
        expect(doc.history.undoCount()).toBe(undoBefore + 1);

        tabOf(strip, script.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const again = mustQuery<HTMLInputElement>(strip, "input.el-rename");
        again.value = "Ignored";
        again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(script.name).toBe("Bracket");
        expect(strip.querySelector("input")).toBeNull();
    });

    test("the Part Studio cannot be renamed, duplicated or deleted", () => {
        const { strip } = setup();
        const partStudio = tabOf(strip, PART_STUDIO_ID);
        partStudio.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(strip.querySelector("input")).toBeNull();

        const menu = rightClick(partStudio);
        const items = [...menu.querySelectorAll<HTMLElement>(".el-menu-item")];
        expect(items.map((item) => item.textContent)).toEqual([
            "common.rename",
            "elements.duplicate",
            "common.delete",
        ]);
        expect(items.every((item) => item.classList.contains("el-disabled"))).toBe(true);
        expect(items[0].title).toBe("elements.partStudio.fixed");
    });

    test("Duplicate copies the element next to it under a fresh name and opens the copy", async () => {
        const { doc, strip } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        add(doc, new ScriptNode({ document: doc, name: "Script 2" }));

        menuItem(rightClick(tabOf(strip, script.id)), "elements.duplicate").click();

        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1", "Script 1 copy", "Script 2"]);
        expect(tabs(strip)[2].classList.contains("el-active")).toBe(true);
        expect(document.querySelector(".el-menu")).toBeNull();

        await doc.history.undo();
        expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1", "Script 2"]);
        expect(activeTab(strip)).toBe(PART_STUDIO_ID);
    });

    test("Delete asks first, and undo brings the element back", async () => {
        const { doc, strip } = setup();
        const script = add(doc, new ScriptNode({ document: doc, name: "Script 1" }));
        const dialogs: { title: I18nKeys; content: HTMLElement; buttons: DialogButton[] }[] = [];
        const capture = (title: I18nKeys, content: HTMLElement, buttons?: DialogButton[] | (() => void)) => {
            dialogs.push({ title, content, buttons: buttons as DialogButton[] });
        };
        PubSub.default.sub("showDialog", capture);
        try {
            menuItem(rightClick(tabOf(strip, script.id)), "common.delete").click();
            expect(dialogs).toHaveLength(1);
            expect(dialogs[0].title).toBe("elements.delete.title");
            expect(dialogs[0].content.textContent).toBe(
                "elements.delete.confirm{0}".replace("{0}", "Script 1"),
            );
            // Nothing is deleted until the user confirms.
            expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1"]);

            const confirm = dialogs[0].buttons.find((button) => button.content === "common.confirm");
            expect(confirm).toBeDefined();
            await confirm?.onclick?.();
            expect(tabNames(strip)).toEqual(["elements.partStudio1"]);

            await doc.history.undo();
            expect(tabNames(strip)).toEqual(["elements.partStudio1", "Script 1"]);
        } finally {
            PubSub.default.remove("showDialog", capture);
        }
    });

    test("the + menu lists what can be created and runs its command", () => {
        const { strip } = setup();
        const executed: CommandKeys[] = [];
        const capture = (command: CommandKeys) => {
            executed.push(command);
        };
        PubSub.default.sub("executeCommand", capture);
        try {
            mustQuery<HTMLButtonElement>(strip, ".el-add").click();
            const menu = mustQuery<HTMLElement>(document.body, ".el-menu");
            const labels = [...menu.querySelectorAll(".el-menu-item")].map((item) => item.textContent);
            expect(labels).toContain("command.featurescript.newStudio");
            expect(labels).toContain("command.variable.newStudio");

            menuItem(menu, "command.variable.newStudio").click();
            expect(executed).toEqual(["variable.newStudio"]);
        } finally {
            PubSub.default.remove("executeCommand", capture);
        }
    });
});

describe("the Variable Studio element", () => {
    function variable(id: string, name: string, expression: string): VariableData {
        return { id, name, expression, type: "length" };
    }

    test("shows the variables editor bound to the studio, full-size", async () => {
        const { doc, strip, viewArea } = setup();
        const studio = add(
            doc,
            new VariableStudioNode({
                document: doc,
                name: "Variable Studio 1",
                items: [variable("s1", "w", "40"), variable("s2", "h", "w / 4")],
            }),
        );
        tabOf(strip, studio.id).click();

        const frame = mustQuery<HTMLElement>(viewArea, `[data-element-id="${studio.id}"]`);
        expect(mustQuery(frame, ".el-studio-title").textContent).toBe("Variable Studio 1");
        const rows = () => [...frame.querySelectorAll<HTMLElement>(".v-row")];
        expect(rows()).toHaveLength(2);
        const values = () => rows().map((row) => mustQuery<HTMLInputElement>(row, ".v-value").value);
        expect(values()).toEqual(["40", "10"]);

        // An edit made elsewhere (undo, another view) redraws the rows from the studio.
        Transaction.execute(doc, "edit", () => studio.setItems([variable("s1", "w", "80")]));
        expect(rows()).toHaveLength(1);
        await doc.history.undo();
        expect(values()).toEqual(["40", "10"]);
    });

    test("a studio row the parameter table shadows is marked, and keeps its own value", () => {
        const { doc, strip, viewArea } = setup();
        Transaction.execute(doc, "table", () => doc.variables.setItems([variable("t1", "w", "5")]));
        const studio = add(
            doc,
            new VariableStudioNode({
                document: doc,
                name: "Variable Studio 1",
                items: [variable("s1", "w", "40")],
            }),
        );
        tabOf(strip, studio.id).click();

        const row = mustQuery<HTMLElement>(viewArea, ".v-row");
        // The studio's row is not the shadowing one — the table's is (warning on the higher layer).
        expect(row.classList.contains("v-warning-row")).toBe(false);
        expect(mustQuery<HTMLInputElement>(row, ".v-value").value).toBe("40");
        expect(doc.variables.evaluate().warnings.get("t1")).toBe("Shadows w from Variable Studio 1");
    });
});
