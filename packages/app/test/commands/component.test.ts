// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ComponentContext, ComponentFolderNode, type IApplication } from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { NewComponent } from "../../src/commands/component";

test("New component adds a component, inside the active one, and activates it", async () => {
    const app = createMockApplication();
    const document = new TestDocument({ application: app });
    (app as { activeView?: unknown }).activeView = { document };
    try {
        await new NewComponent().execute(app as IApplication);
        const first = document.modelManager.findNodes(
            (n) => n instanceof ComponentFolderNode,
        )[0] as ComponentFolderNode;
        expect(first).toBeInstanceOf(ComponentFolderNode);
        expect(first.name).toBe("body.component1");
        expect(first.parent).toBe(document.modelManager.rootNode);
        expect(ComponentContext.activeOf(document)).toBe(first);
        expect(document.history.undoCount()).toBe(1);

        await new NewComponent().execute(app as IApplication);
        const second = document.modelManager
            .findNodes((n) => n instanceof ComponentFolderNode)
            .find((n) => n !== first) as ComponentFolderNode;
        expect(second.parent).toBe(first);
        expect(ComponentContext.activeOf(document)).toBe(second);
    } finally {
        document.dispose();
    }
});
