// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ComponentContext, ComponentFolderNode, FolderNode } from "@chili3d/core";
import { TestDocument, TestStepNode } from "@chili3d/core/test-utils";
import { TreeGroup } from "../src/project/tree/treeItemGroup";
import { mustQuery } from "./_helpers/domHelpers";

// Happy-DOM's append routes through the overridable appendChild (see tree.test.ts): the
// group's constructor appends its own container, which the override would nest into `items`.
const originalAppendChild = TreeGroup.prototype.appendChild;
TreeGroup.prototype.appendChild = function <T extends Node>(this: TreeGroup, child: T): T {
    if (child instanceof Element && child.contains(this.items)) {
        return HTMLElement.prototype.appendChild.call(this, child) as T;
    }
    return originalAppendChild.call(this, child) as T;
};

test("a plain folder has no activate ring: only a component is a component", () => {
    const document = new TestDocument();
    const folder = new FolderNode({ document, name: "Group" });
    document.modelManager.addNode(folder);
    const row = new TreeGroup(document, folder);
    globalThis.document.body.append(row);
    try {
        expect(row.querySelector('button[aria-label="Activate component"]')).toBeNull();
        ComponentContext.activate(document, folder);
        expect(ComponentContext.activeOf(document)).toBeUndefined();
        expect(document.modelManager.currentNode).toBeUndefined();
    } finally {
        row.remove();
        document.dispose();
    }
});

test("a component's activate ring makes it the component being worked in; a second click goes back", () => {
    const document = new TestDocument();
    const sub = new ComponentFolderNode({ document, name: "Sub" });
    sub.add(new TestStepNode(document, "S"));
    document.modelManager.addNode(sub);
    const row = new TreeGroup(document, sub);
    globalThis.document.body.append(row);
    try {
        const ring = mustQuery<HTMLButtonElement>(row, 'button[aria-label="Activate component"]');
        expect(ring.getAttribute("aria-pressed")).toBe("false");
        ring.click();
        expect(ComponentContext.activeOf(document)).toBe(sub);
        expect(document.modelManager.currentNode).toBe(sub);
        expect(ring.getAttribute("aria-pressed")).toBe("true");
        // New nodes go into the active folder.
        const node = new TestStepNode(document, "New");
        document.modelManager.addNode(node);
        expect(node.parent).toBe(sub);

        ring.click();
        expect(ComponentContext.activeOf(document)).toBeUndefined();
        expect(document.modelManager.currentNode).toBeUndefined();
        expect(ring.getAttribute("aria-pressed")).toBe("false");
    } finally {
        row.remove();
        document.dispose();
    }
});
