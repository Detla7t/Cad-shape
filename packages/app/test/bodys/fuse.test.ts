// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Result } from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { beforeEach, describe, expect, rs, test } from "@rstest/core";
import { FuseNode } from "../../src/bodys/fuse";
import { createMockShape, setupShapeFactoryMock } from "./_utils";

describe("FuseNode", () => {
    let doc: IDocument;
    let bottom: any;
    let top: any;

    beforeEach(() => {
        doc = createMockDocument();
        bottom = createMockShape();
        top = createMockShape();
    });

    describe("constructor", () => {
        test("should initialize bottom and top", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            expect(node.bottom).toBe(bottom);
            expect(node.top).toBe(top);
        });

        test("should set name from display()", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            expect(node.name).toBe("body.fuse1");
        });
    });

    describe("display", () => {
        test("should return body.fuse", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            expect(node.display()).toBe("body.fuse");
        });
    });

    describe("getters", () => {
        test("should return bottom and top", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            expect(node.bottom).toBe(bottom);
            expect(node.top).toBe(top);
        });
    });

    describe("setters", () => {
        test("setting bottom should update value", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            const newBottom = createMockShape();
            try {
                node.bottom = newBottom as any;
            } catch (_e) {
                // regenerating from mock shapes may fail; setProperty already stored the value
            }
            expect(node.bottom).toBe(newBottom);
        });

        test("setting top should update value", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            const newTop = createMockShape();
            try {
                node.top = newTop as any;
            } catch (_e) {
                // regenerating from mock shapes may fail; setProperty already stored the value
            }
            expect(node.top).toBe(newTop);
        });
    });

    describe("onPropertyChanged", () => {
        test("should emit on bottom change", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            const handler = rs.fn((_property: string) => {});
            node.onPropertyChanged(handler);
            try {
                node.bottom = createMockShape() as any;
            } catch (_e) {
                // regenerating from mock shapes may fail
            }
            expect(handler.mock.calls.map((c) => c[0])).toContain("bottom");
        });

        test("should emit on top change", () => {
            const node = new FuseNode({ document: doc, bottom, top });
            const handler = rs.fn((_property: string) => {});
            node.onPropertyChanged(handler);
            try {
                node.top = createMockShape() as any;
            } catch (_e) {
                // regenerating from mock shapes may fail
            }
            expect(handler.mock.calls.map((c) => c[0])).toContain("top");
        });
    });

    describe("generateShape", () => {
        test("should fuse the bottom shape with the top shape", () => {
            const fused = createMockShape();
            const booleanFuse = rs.fn((_bottom: unknown[], _top: unknown[], _simplify: boolean) =>
                Result.ok(fused),
            );
            setupShapeFactoryMock({ booleanFuse });
            const node = new FuseNode({ document: doc, bottom, top });
            expect(node.generateShape().unchecked()).toBe(fused);
            expect(booleanFuse.mock.calls.at(-1)).toEqual([[bottom], [top], true]);
        });
    });
});
