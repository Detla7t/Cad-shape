// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DocumentElementRegistry,
    type ElementKind,
    type FloatPanelOptions,
    FolderNode,
    type IDocument,
    type IElementView,
    type INode,
    nextElementName,
    PubSub,
    VariableStudioNode,
} from "../src";
import { TestDocument } from "../test-utils";

const studioKind: ElementKind = {
    kind: "variableStudio",
    icon: "icon-tag",
    display: "elements.variableStudio",
    isElement: (node) => node instanceof VariableStudioNode,
};

function addStudio(document: TestDocument, name: string, parent = document.modelManager.rootNode) {
    const studio = new VariableStudioNode({ document, name });
    parent.add(studio);
    return studio;
}

function fakeView(): IElementView & { dispose: ReturnType<typeof rs.fn> } {
    return { element: document.createElement("div"), dispose: rs.fn() };
}

describe("DocumentElementRegistry", () => {
    test("lists a document's element nodes in model-tree order, folders included", () => {
        const registry = new DocumentElementRegistry();
        registry.registerKind(studioKind);
        const doc = new TestDocument();
        const first = addStudio(doc, "A");
        const folder = new FolderNode({ document: doc, name: "group" });
        doc.modelManager.rootNode.add(folder);
        const nested = addStudio(doc, "B", folder);
        const last = addStudio(doc, "C");

        const elements = registry.elementsOf(doc);
        expect(elements.map((element) => element.node)).toEqual([first, nested, last]);
        expect(elements.every((element) => element.kind === studioKind)).toBe(true);
        expect(registry.kindOf(folder)).toBeUndefined();
    });

    test("a kind kept out of the model tree hides its nodes from the Features tree only", () => {
        const registry = new DocumentElementRegistry();
        registry.registerKind({ ...studioKind, kind: "attachedFile", inModelTree: false });
        const doc = new TestDocument();
        const file = addStudio(doc, "Drawing 1");
        const folder = new FolderNode({ document: doc, name: "Folder" });
        doc.modelManager.rootNode.add(folder);
        expect(registry.hiddenInTree(file)).toBe(true);
        expect(registry.hiddenInTree(folder)).toBe(false);
        expect(registry.elementsOf(doc).map((item) => item.node)).toEqual([file]);
        registry.registerKind({ ...studioKind, kind: "attachedFile" });
        expect(registry.hiddenInTree(file)).toBe(false);
    });

    test("re-registering a kind or a view replaces it, and disposing unregisters", () => {
        const registry = new DocumentElementRegistry();
        const changed = rs.fn();
        registry.onChanged(changed);
        registry.registerKind(studioKind);
        registry.registerKind({ ...studioKind, icon: "icon-macro" });
        expect(registry.kinds.map((kind) => kind.icon)).toEqual(["icon-macro"]);

        const doc = new TestDocument();
        const studio = addStudio(doc, "A");
        const first = fakeView();
        const second = fakeView();
        registry.registerView("variableStudio", () => first);
        const replacement = registry.registerView("variableStudio", () => second);
        expect(registry.createView(studio, doc)).toBe(second);

        replacement.dispose();
        expect(registry.createView(studio, doc)).toBeUndefined();
        expect(changed).toHaveBeenCalledTimes(5);
    });

    test("opens through the host when one is up", () => {
        const registry = new DocumentElementRegistry();
        registry.registerKind(studioKind);
        const openElement = rs.fn((_document: IDocument, _node: INode) => true);
        const showPartStudio = rs.fn((_document: IDocument) => {});
        registry.setHost({ openElement, showPartStudio });
        const doc = new TestDocument();
        const studio = addStudio(doc, "A");

        registry.open(doc, studio);
        registry.showPartStudio(doc);

        expect(openElement).toHaveBeenCalledWith(doc, studio);
        expect(showPartStudio).toHaveBeenCalledWith(doc);
    });

    test("without a host, opens the view in one floating panel per element, disposed on close", () => {
        const registry = new DocumentElementRegistry();
        registry.registerKind(studioKind);
        const view = fakeView();
        registry.registerView("variableStudio", () => view);
        const opened: FloatPanelOptions[] = [];
        const capture = (options: FloatPanelOptions) => {
            opened.push(options);
        };
        PubSub.default.sub("showFloatPanel", capture);
        try {
            const doc = new TestDocument();
            const studio = addStudio(doc, "A");
            registry.open(doc, studio);
            registry.open(doc, studio);

            expect(opened).toHaveLength(1);
            expect(opened[0].content).toBe(view.element);
            expect(opened[0].title).toBe("elements.variableStudio");
            expect(opened[0].document).toBe(doc);

            opened[0].onClose?.();
            expect(view.dispose).toHaveBeenCalledTimes(1);
            registry.open(doc, studio);
            expect(opened).toHaveLength(2);
        } finally {
            PubSub.default.remove("showFloatPanel", capture);
        }
    });

    test("double-clicking an element node opens it", () => {
        const registry = new DocumentElementRegistry();
        registry.registerKind(studioKind);
        const openElement = rs.fn((_document: IDocument, _node: INode) => true);
        registry.setHost({ openElement, showPartStudio: rs.fn((_document: IDocument) => {}) });
        const doc = new TestDocument();
        const studio = addStudio(doc, "A");
        const folder = new FolderNode({ document: doc, name: "group" });

        PubSub.default.pub("nodeDoubleClicked", folder);
        expect(openElement).not.toHaveBeenCalled();
        PubSub.default.pub("nodeDoubleClicked", studio);
        expect(openElement).toHaveBeenCalledWith(doc, studio);
        registry.setHost(undefined);
    });
});

describe("nextElementName", () => {
    test("counts past the names any node already has", () => {
        const doc = new TestDocument();
        expect(nextElementName(doc, "Variable Studio")).toBe("Variable Studio 1");
        addStudio(doc, "Variable Studio 1");
        doc.modelManager.rootNode.add(new FolderNode({ document: doc, name: "Variable Studio 2" }));
        expect(nextElementName(doc, "Variable Studio")).toBe("Variable Studio 3");
    });
});
