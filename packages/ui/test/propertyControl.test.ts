// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Combobox,
    type I18nKeys,
    type IDocument,
    type ModelManager,
    Texture,
    Transaction,
} from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { describe, expect, test } from "@rstest/core";
import { basicPropertyControl } from "../src/property/basicPropertyControl";
import { CheckProperty } from "../src/property/check";
import { ColorProperty } from "../src/property/colorProperty";
import { ComboboxProperty } from "../src/property/comboboxProperty";
import { propertyControl } from "../src/property/complexPropertyUtils";
import { InputProperty } from "../src/property/input";
import { MaterialProperty } from "../src/property/materialProperty";

rs.mock("../src/property/textureProperty", () => ({
    TextureProperty: rs
        .fn()
        .mockImplementation((document: IDocument, display: I18nKeys, texture: Texture) => ({
            display,
            texture,
            document,
        })),
}));

/**
 * Creates a test object with `onPropertyChanged` stub required by Binding.
 */
function createTestObj(props: Record<string, unknown> = {}) {
    return {
        ...props,
        onPropertyChanged: () => {},
        removePropertyChanged: () => {},
        clearPropertyChanged: () => {},
    };
}

const mockDocument = createMockDocument({
    modelManager: {
        materials: [{ id: "mat1" }, { id: "mat2" }],
    } as unknown as Partial<ModelManager>,
});

describe("propertyControl", () => {
    describe("guard clauses", () => {
        test("should return empty string when prop is undefined", () => {
            const result = propertyControl(mockDocument, [createTestObj()], undefined as never);
            expect(result).toBe("");
        });

        test("should return empty string when objects array is empty", () => {
            const result = propertyControl(mockDocument, [], {
                name: "test",
                type: "string",
                display: "test.label",
            } as never);
            expect(result).toBe("");
        });
    });

    describe("TextureProperty dispatch (mocked)", () => {
        test("should return TextureProperty when value is a Texture instance", () => {
            const texture = new Texture({ document: mockDocument });
            const obj = createTestObj({ texture });
            const result = propertyControl(mockDocument, [obj], {
                name: "texture",
                display: "test.texture",
            } as any) as any;

            expect(result.document).toBe(mockDocument);
            expect(result.texture).toBe(texture);
        });
    });

    describe("delegation to basicPropertyControl", () => {
        test("should return ColorProperty for color type", () => {
            const obj = createTestObj({ color: "#ff0000" });
            const result = propertyControl(mockDocument, [obj], {
                name: "color",
                type: "color",
                display: "test.color",
            } as any);
            expect(result).toBeInstanceOf(ColorProperty);
        });
    });
});

describe("basicPropertyControl", () => {
    describe("guard clauses", () => {
        test("should return empty string when prop is undefined", () => {
            const result = basicPropertyControl(mockDocument, [createTestObj()], undefined as never);
            expect(result).toBe("");
        });

        test("should return empty string when objects array is empty", () => {
            const result = basicPropertyControl(mockDocument, [], {
                name: "test",
                type: "string",
                display: "test.label",
            } as any);
            expect(result).toBe("");
        });
    });

    describe("type-based dispatch", () => {
        test("should return ColorProperty for color type", () => {
            const obj = createTestObj({ color: "#ff0000" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "color",
                type: "color",
                display: "test.color",
            } as any);
            expect(result).toBeInstanceOf(ColorProperty);
        });

        test("should return MaterialProperty for materialId type with single object", () => {
            const obj = createTestObj({ materialId: "mat1" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "materialId",
                type: "materialId",
                display: "test.material",
            } as any);
            expect(result).toBeInstanceOf(MaterialProperty);
        });

        test("should return InputProperty when materialId values differ", () => {
            const obj1 = createTestObj({ materialId: "mat1" });
            const obj2 = createTestObj({ materialId: "mat2" });
            const result = basicPropertyControl(mockDocument, [obj1, obj2], {
                name: "materialId",
                type: "materialId",
                display: "test.material",
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return InputProperty for string type values", () => {
            const obj = createTestObj({ name: "hello" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "name",
                display: "test.name",
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return InputProperty for number type values", () => {
            const obj = createTestObj({ count: 42 });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "count",
                display: "test.count",
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return InputProperty for object type values", () => {
            const obj = createTestObj({ config: { key: "value" } });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "config",
                display: "test.config",
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return CheckProperty for boolean type values", () => {
            const obj = createTestObj({ enabled: true });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "enabled",
                display: "test.enabled",
            } as any);
            expect(result).toBeInstanceOf(CheckProperty);
        });

        test("should return empty string for unsupported types", () => {
            const obj = createTestObj({ sym: Symbol("test") });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "sym",
                display: "test.sym",
            } as any);
            expect(result).toBe("");
        });
    });

    describe("canShowMaterialProperty logic", () => {
        test("should show MaterialProperty for single object", () => {
            const obj = createTestObj({ materialId: "mat1" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "materialId",
                type: "materialId",
                display: "mat.label",
            } as any);
            expect(result).toBeInstanceOf(MaterialProperty);
        });

        test("should show MaterialProperty for multiple objects with same materialId", () => {
            const objs = [createTestObj({ materialId: "mat1" }), createTestObj({ materialId: "mat1" })];
            const result = basicPropertyControl(mockDocument, objs, {
                name: "materialId",
                type: "materialId",
                display: "mat.label",
            } as any);
            expect(result).toBeInstanceOf(MaterialProperty);
        });

        test("should show InputProperty for multiple objects with different materialId", () => {
            const objs = [createTestObj({ materialId: "mat1" }), createTestObj({ materialId: "mat2" })];
            const result = basicPropertyControl(mockDocument, objs, {
                name: "materialId",
                type: "materialId",
                display: "mat.label",
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });
    });
});

describe("ComboboxProperty", () => {
    test("a property with a combobox edits through a select of its items and writes the chosen item", () => {
        const obj = createTestObj({ terminator: "dot" });
        const control = basicPropertyControl(mockDocument, [obj], {
            name: "terminator",
            display: "annotation.terminator",
            combobox: Combobox.from(["arrow", "dot", "none"], {
                convert: (value: string) => ({ unchecked: () => value.toUpperCase() }),
            } as never),
        } as never);
        expect(control).toBeInstanceOf(ComboboxProperty);
        const update = rs.fn();
        mockDocument.visual.update = update;
        const select = (control as ComboboxProperty).select;
        expect([...select.options].map((option) => option.textContent)).toEqual(["ARROW", "DOT", "NONE"]);
        expect(select.selectedIndex).toBe(1);
        const original = Transaction.execute;
        Transaction.execute = ((_doc: unknown, _name: string, action: () => void) =>
            action()) as typeof Transaction.execute;
        try {
            select.value = "2";
            select.dispatchEvent(new Event("change"));
        } finally {
            Transaction.execute = original;
        }
        expect((obj as Record<string, unknown>)["terminator"]).toBe("none");
        expect(update).toHaveBeenCalled();
    });
});
