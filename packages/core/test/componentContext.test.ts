// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "../src/foundation/pubsub";
import { ComponentContext } from "../src/model/componentContext";
import { ComponentFolderNode, isComponentFolder } from "../src/model/componentFolderNode";
import { FolderNode } from "../src/model/folderNode";
import { Serializer } from "../src/serialize";
import { TestDocument } from "../test-utils";

describe("ComponentContext", () => {
    test("only a component activates; a plain folder is ignored and the root deactivates", () => {
        const document = new TestDocument();
        const folder = new FolderNode({ document, name: "Group" });
        const component = new ComponentFolderNode({ document, name: "Component 1" });
        document.modelManager.addNode(folder, component);
        const changes: unknown[] = [];
        const handler = (_doc: unknown, active: unknown) => changes.push(active);
        PubSub.default.sub("activeComponentChanged", handler);
        try {
            ComponentContext.activate(document, folder);
            expect(ComponentContext.activeOf(document)).toBeUndefined();
            expect(changes).toEqual([]);
            ComponentContext.activate(document, component);
            expect(ComponentContext.activeOf(document)).toBe(component);
            expect(document.modelManager.currentNode).toBe(component);
            expect(changes).toEqual([component]);
            ComponentContext.activate(document, document.modelManager.rootNode);
            expect(ComponentContext.activeOf(document)).toBeUndefined();
            expect(changes).toEqual([component, undefined]);
        } finally {
            PubSub.default.remove("activeComponentChanged", handler);
            document.dispose();
        }
    });

    test("back to the parent climbs past plain folders to the nearest component", () => {
        const document = new TestDocument();
        const outer = new ComponentFolderNode({ document, name: "Outer" });
        const group = new FolderNode({ document, name: "Group" });
        const inner = new ComponentFolderNode({ document, name: "Inner" });
        group.add(inner);
        outer.add(group);
        document.modelManager.addNode(outer);
        try {
            ComponentContext.activate(document, inner);
            ComponentContext.activateParent(document);
            expect(ComponentContext.activeOf(document)).toBe(outer);
            ComponentContext.activateParent(document);
            expect(ComponentContext.activeOf(document)).toBeUndefined();
        } finally {
            document.dispose();
        }
    });

    test("a component is a folder with the cube icon, saved by its own class", () => {
        const document = new TestDocument();
        const component = new ComponentFolderNode({ document, name: "Component 1" });
        expect(isComponentFolder(component)).toBe(true);
        expect(isComponentFolder(new FolderNode({ document, name: "Group" }))).toBe(false);
        expect(component.icon).toBe("icon-component");
        expect(component.display()).toBe("body.component");
        const data = Serializer.serializeObject(component);
        expect(data["__cla$$__"]).toBe("ComponentFolderNode");
        const copy = Serializer.deserializeObject(document, data);
        expect(copy).toBeInstanceOf(ComponentFolderNode);
        expect((copy as ComponentFolderNode).name).toBe("Component 1");
        document.dispose();
    });
});
