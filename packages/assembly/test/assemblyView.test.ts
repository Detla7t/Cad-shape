// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FolderNode, type IVisual } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { setLinkService } from "../src/link/linkRegistry";
import { AssemblyNode } from "../src/model/assemblyNode";
import type { AssemblyInstanceData, MateData } from "../src/model/assemblyTypes";
import { AssemblyView } from "../src/ui/assemblyView";

/**
 * The assembly tab without a 3D view (the mock visual factory has none): lists, badges,
 * diagnostics and the toolbar's edits, which are undo steps on the assembly.
 */

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function setup() {
    setLinkService(undefined);
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as unknown as IVisual;
    doc.modelManager.rootNode = new FolderNode({ document: doc, name: "Doc", id: "root" });
    const instances: AssemblyInstanceData[] = [
        {
            id: "a",
            name: "Gone <1>",
            source: { kind: "part", nodeId: "missing" },
            transform: identity,
            grounded: true,
        },
        {
            id: "b",
            name: "Linked <1>",
            source: {
                kind: "link",
                link: {
                    documentId: "elsewhere",
                    nodeId: "n",
                    version: { kind: "version", name: "V3" },
                    resolvedCommit: "abc1234def",
                    documentName: "Library",
                    versionLabel: "V3",
                },
            },
            transform: identity,
        },
    ];
    const frame = { origin: [0, 0, 0] as const, zAxis: [0, 0, 1] as const, xAxis: [1, 0, 0] as const };
    const mates: MateData[] = [
        {
            id: "m",
            name: "Fastened 1",
            type: "fastened",
            a: { instanceId: "a", ...frame },
            b: { instanceId: "b", ...frame },
        },
    ];
    const assembly = new AssemblyNode({ document: doc, name: "Assembly 1", instances, mates });
    doc.modelManager.addNode(assembly);
    const view = new AssemblyView(assembly, doc);
    document.body.append(view.element);
    return { doc, assembly, view };
}

function button(view: AssemblyView, label: string): HTMLButtonElement {
    const found = [...view.element.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
}

function row(view: AssemblyView, name: string): HTMLElement {
    const found = [...view.element.querySelectorAll("div")].find(
        (d) => d.firstElementChild?.firstChild?.textContent === name,
    );
    expect(found).toBeDefined();
    return found!;
}

describe("assembly view", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("lists instances with their source, state and badges, and the mates", () => {
        const { view } = setup();
        const text = view.element.textContent ?? "";
        expect(text).toContain("Gone <1>");
        expect(text).toContain("Library · V3");
        expect(text).toContain("assembly.status.missing");
        expect(text).toContain("assembly.status.pending");
        expect(text).toContain("assembly.mateType.fastened · Fastened 1");
        expect(text).toContain("Gone <1> ↔ Linked <1>");
        // Without geometry the solver still reports the free instance's freedom.
        // Solved, the fastened mate leaves the linked instance no freedom.
        expect(text).toContain("assembly.dof0");
        expect(text).toContain("assembly.solved");
        view.dispose();
    });

    test("Fix toggles the selected instance's grounding as one undo step", async () => {
        const { doc, assembly, view } = setup();
        row(view, "Linked <1>").click();
        const fix = button(view, "assembly.fix");
        expect(fix.disabled).toBe(false);
        fix.click();
        expect(assembly.instance("b")?.grounded).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(button(view, "assembly.unfix").disabled).toBe(false);
        doc.history.undo();
        expect(assembly.instance("b")?.grounded).toBeUndefined();
        view.dispose();
    });

    test("deleting an instance drops its mates too", () => {
        const { doc, assembly, view } = setup();
        row(view, "Gone <1>").click();
        button(view, "assembly.delete").click();
        expect(assembly.instances.map((x) => x.id)).toEqual(["b"]);
        expect(assembly.mates).toEqual([]);
        doc.history.undo();
        expect(assembly.instances.map((x) => x.id)).toEqual(["a", "b"]);
        expect(assembly.mates.map((m) => m.id)).toEqual(["m"]);
        view.dispose();
    });

    test("the Mate button enters connector picking; Escape leaves it", () => {
        const { view } = setup();
        const mate = button(view, "assembly.mate");
        mate.click();
        expect(view.element.textContent).toContain("assembly.pickFirst");
        const viewport = view.element.querySelector("[tabindex]") as HTMLElement;
        expect(viewport).not.toBeNull();
        viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(view.element.textContent).not.toContain("assembly.pickFirst");
        view.dispose();
    });

    test("a selected mate shows its editor; an offset edit is one undo step and re-solves", async () => {
        const { doc, assembly, view } = setup();
        row(view, "assembly.mateType.fastened · Fastened 1").click();
        const inputs = [...view.element.querySelectorAll<HTMLInputElement>("input[type=number]")];
        expect(inputs).toHaveLength(2); // offset and rotation; a fastened mate has no limits
        inputs[0].value = "4";
        inputs[0].dispatchEvent(new Event("change"));
        expect(assembly.mates[0].offset).toEqual({ z: 4 });
        // Solved: the linked instance sits 4 mm off the grounded one's connector.
        expect(assembly.instance("b")!.transform[14]).toBeCloseTo(4, 6);
        doc.history.undo();
        expect(assembly.mates[0].offset).toBeUndefined();
        expect(assembly.instance("b")!.transform[14]).toBeCloseTo(0, 6);
        view.dispose();
    });

    test("the element exposes its view for scripts", () => {
        const { view } = setup();
        expect((view.element as HTMLElement & { assemblyView?: AssemblyView }).assemblyView).toBe(view);
        expect(view.screenPoint([0, 0, 0])).toBeUndefined();
        view.dispose();
    });
});
