// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    canonicalSerializedTypeId,
    FolderNode,
    type IDocument,
    InternalClassName,
    NodeUtils,
    type Serialized,
    Serializer,
    serializable,
    serialize,
    serializedTypeId,
    XYZ,
} from "../src";
import { TestDocument } from "../test-utils";

interface TestObjectOptions {
    k1: string;
}

@serializable()
class TestObject {
    protected k2: string = "k2";
    public k3: string = "k3";

    @serialize()
    private k1: string;
    @serialize()
    private k4: string = "k4";
    @serialize()
    protected k5: string = "k5";
    @serialize()
    public k6: string = "k6";

    constructor(options: TestObjectOptions) {
        this.k1 = options.k1;
    }

    serialize(): Serialized {
        return Serializer.serializeObject(this);
    }
}

test("should serialize and deserialize an object", () => {
    const obj = new TestObject({ k1: "111" });
    const s = obj.serialize();
    expect(s[InternalClassName]).toBe("TestObject");
    expect(s["k1"]).toBe("111");
    expect(s["k4"]).toBe("k4");
    expect(s["k5"]).toBe("k5");
    expect(s["k6"]).toBe("k6");
    // fields without @serialize() are not serialized
    expect("k2" in s).toBe(false);
    expect("k3" in s).toBe(false);

    s["k1"] = "222";
    s["k4"] = "changed";
    const obj2 = Serializer.deserializeObject({} as any, s);
    expect(obj2).toBeInstanceOf(TestObject);
    expect(obj2.k1).toBe("222");
    expect(obj2.k4).toBe("changed");
});

test("should serialize and deserialize nodes", async () => {
    const doc: IDocument = new TestDocument() as any;

    const n1 = new FolderNode({ document: doc, name: "n1" });
    const n2 = new FolderNode({ document: doc, name: "n2" });
    const n3 = new FolderNode({ document: doc, name: "n3" });
    const n4 = new FolderNode({ document: doc, name: "n4" });
    n1.add(n2, n3);
    n2.add(n4);
    const s = NodeUtils.serializeNode(n1);

    const n11: any = await NodeUtils.deserializeNode(doc, s);
    expect(n11.firstChild.name).toBe("n2");
    expect(n11.firstChild.nextSibling.name).toBe("n3");
    expect(n11.firstChild.firstChild.name).toBe("n4");
});

@serializable()
class InnerValue {
    @serialize()
    public value: number;

    constructor(options: { value: number }) {
        this.value = options.value;
    }
}

@serializable()
class OuterValue {
    @serialize()
    public name: string = "";
    @serialize()
    public count: number = 0;
    @serialize()
    public flag: boolean = false;
    @serialize()
    public inner?: InnerValue;
    @serialize()
    public list: InnerValue[] = [];

    constructor(options: Partial<OuterValue>) {
        Object.assign(this, options);
    }
}

describe("serializeObject", () => {
    test("should serialize primitives, nested objects and arrays with class markers", () => {
        const outer = new OuterValue({
            name: "root",
            count: 2,
            flag: true,
            inner: new InnerValue({ value: 1 }),
            list: [new InnerValue({ value: 2 }), new InnerValue({ value: 3 })],
        });

        const s = Serializer.serializeObject(outer);

        expect(s[InternalClassName]).toBe("OuterValue");
        expect(s["name"]).toBe("root");
        expect(s["count"]).toBe(2);
        expect(s["flag"]).toBe(true);
        expect(s["inner"]).toEqual({ [InternalClassName]: "InnerValue", value: 1 });
        expect(s["list"]).toEqual([
            { [InternalClassName]: "InnerValue", value: 2 },
            { [InternalClassName]: "InnerValue", value: 3 },
        ]);
    });

    test("should throw for an unregistered class", () => {
        class UnregisteredValue {}
        expect(() => Serializer.serializeObject(new UnregisteredValue())).toThrow(
            "Type UnregisteredValue is not registered, please add the @serializable() decorator.",
        );
    });

    test("should serialize Float32Array via the registered custom serializer", () => {
        const s = Serializer.serializeObject(new Float32Array([1.5, -2, 3.25]));

        expect(s[InternalClassName]).toBe("Float32Array");
        expect(s["buffer"]).toEqual([1.5, -2, 3.25]);
    });

    test("should throw for a function-valued property", () => {
        @serializable()
        class FunctionValue {
            @serialize()
            public fn: unknown;

            constructor(options: { fn: unknown }) {
                this.fn = options.fn;
            }
        }

        expect(() => Serializer.serializeObject(new FunctionValue({ fn: () => 1 }))).toThrow(
            /Unsupported serialized object/,
        );
    });
});

@serializable()
class BaseValue {
    @serialize()
    public baseProp: string = "base";

    constructor(options: { baseProp?: string }) {
        if (options.baseProp !== undefined) this.baseProp = options.baseProp;
    }
}

@serializable()
class ChildValue extends BaseValue {
    @serialize()
    public childProp: string = "child";

    constructor(options: { baseProp?: string; childProp?: string }) {
        super(options);
        if (options.childProp !== undefined) this.childProp = options.childProp;
    }
}

describe("prototype chain", () => {
    test("should serialize @serialize properties inherited from the base class", () => {
        const s = Serializer.serializeObject(new ChildValue({ baseProp: "b", childProp: "c" }));

        expect(s[InternalClassName]).toBe("ChildValue");
        expect(s["baseProp"]).toBe("b");
        expect(s["childProp"]).toBe("c");
    });
});

describe("deserialize", () => {
    test("should roundtrip nested objects and arrays to class instances", () => {
        const outer = new OuterValue({
            name: "root",
            count: 2,
            flag: true,
            inner: new InnerValue({ value: 1 }),
            list: [new InnerValue({ value: 2 }), new InnerValue({ value: 3 })],
        });

        const restored = Serializer.deserializeObject({} as any, Serializer.serializeObject(outer));

        expect(restored).toBeInstanceOf(OuterValue);
        expect(restored.name).toBe("root");
        expect(restored.count).toBe(2);
        expect(restored.flag).toBe(true);
        expect(restored.inner).toBeInstanceOf(InnerValue);
        expect(restored.inner.value).toBe(1);
        expect(restored.list).toHaveLength(2);
        expect(restored.list[0]).toBeInstanceOf(InnerValue);
        expect(restored.list[0].value).toBe(2);
        expect(restored.list[1].value).toBe(3);
    });

    test("should roundtrip Float32Array via the registered custom deserializer", () => {
        const original = new Float32Array([1.5, -2, 3.25]);
        const restored = Serializer.deserializeObject({} as any, Serializer.serializeObject(original));

        expect(restored).toBeInstanceOf(Float32Array);
        expect(Array.from(restored as Float32Array)).toEqual([1.5, -2, 3.25]);
    });

    test("should throw when the serialized class name is not registered", () => {
        expect(() => Serializer.deserializeInstance({ [InternalClassName]: "NoSuchClass", a: 1 })).toThrow(
            /NoSuchClass cannot be deserialize/,
        );
    });

    test("should warn and return the data as-is when the class marker is missing", () => {
        const spy = rs.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const raw = { a: 1 };
            expect(Serializer.deserializeInstance(raw)).toBe(raw);
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test("deserialValue should map null/undefined to undefined and keep primitives", () => {
        const doc = {} as any;

        expect(Serializer.deserialValue(doc, null)).toBeUndefined();
        expect(Serializer.deserialValue(doc, undefined)).toBeUndefined();
        expect(Serializer.deserialValue(doc, 42)).toBe(42);
        expect(Serializer.deserialValue(doc, "text")).toBe("text");
        expect(Serializer.deserialValue(doc, [1, "a", null])).toEqual([1, "a", undefined]);
    });
});

describe("edge cases", () => {
    // Suspected src bug: there is no cycle detection in serializePropertyValue,
    // so a circular reference recurses until the call stack overflows.
    test("should currently throw a RangeError for circular references", () => {
        @serializable()
        class CircularValue {
            @serialize()
            public self?: CircularValue;

            constructor(options: { self?: CircularValue }) {
                this.self = options.self;
            }
        }

        const a = new CircularValue({});
        a.self = a;

        expect(() => Serializer.serializeObject(a)).toThrow(RangeError);
    });

    // Suspected src bug: typeof null === "object" routes null into serializeObject,
    // which dereferences null.constructor and throws a TypeError.
    test("should currently throw a TypeError for a null property value", () => {
        @serializable()
        class NullValue {
            @serialize()
            public data: string | null = null;

            constructor(options: { data: string | null }) {
                this.data = options.data;
            }
        }

        expect(() => Serializer.serializeObject(new NullValue({ data: null }))).toThrow(TypeError);
    });
});

describe("stable serialized type ids", () => {
    @serializable({ id: "test.Widget", aliases: ["OldWidget", "LegacyWidget"] })
    class RenamedWidget_x1 {
        @serialize()
        public size: number;

        constructor(options: { size: number }) {
            this.size = options.size;
        }
    }

    test("writes the declared id, not the runtime class name", () => {
        const s = Serializer.serializeObject(new RenamedWidget_x1({ size: 3 }));
        expect(s[InternalClassName]).toBe("test.Widget");
        expect(serializedTypeId(new RenamedWidget_x1({ size: 1 }))).toBe("test.Widget");
        expect(serializedTypeId(RenamedWidget_x1)).toBe("test.Widget");
    });

    test.each(["test.Widget", "OldWidget", "LegacyWidget"])("reads %s as the class", (name) => {
        const widget = Serializer.deserializeObject({} as IDocument, { [InternalClassName]: name, size: 7 });
        expect(widget).toBeInstanceOf(RenamedWidget_x1);
        expect(widget.size).toBe(7);
        expect(canonicalSerializedTypeId(name)).toBe("test.Widget");
    });

    test("the runtime class name is not an identifier when an id is declared", () => {
        expect(canonicalSerializedTypeId("RenamedWidget_x1")).toBeUndefined();
        expect(() =>
            Serializer.deserializeObject({} as IDocument, {
                [InternalClassName]: "RenamedWidget_x1",
                size: 1,
            }),
        ).toThrow(/cannot be deserialize/);
    });

    test("survives minification: the written id does not depend on the class name", () => {
        // What a mangling build does to a class name after its decorator ran.
        @serializable({ id: "test.Mangled" })
        class Readable {
            @serialize()
            public value = 1;
        }
        Object.defineProperty(Readable, "name", { value: "a" });
        expect(Serializer.serializeObject(new Readable())[InternalClassName]).toBe("test.Mangled");
    });

    test("core classes keep their class names as ids (what saved documents hold)", () => {
        expect(serializedTypeId(XYZ)).toBe("XYZ");
        expect(serializedTypeId(FolderNode)).toBe("FolderNode");
        expect(serializedTypeId(Float32Array)).toBe("Float32Array");
    });

    test("an undecorated class has no id and does not serialize", () => {
        class Plain {}
        expect(serializedTypeId(new Plain())).toBeUndefined();
        expect(() => Serializer.serializeObject(new Plain())).toThrow(/not registered/);
    });

    test("an alias already taken by another class is skipped with a warning", () => {
        const warn = rs.spyOn(console, "warn").mockImplementation(() => {});
        try {
            @serializable({ id: "test.Other", aliases: ["OldWidget"] })
            class Other {
                @serialize()
                public size = 0;
            }
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("OldWidget"));
            expect(serializedTypeId(Other)).toBe("test.Other");
            expect(canonicalSerializedTypeId("OldWidget")).toBe("test.Widget");
        } finally {
            warn.mockRestore();
        }
    });
});
