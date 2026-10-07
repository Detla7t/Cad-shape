// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    applyDelta,
    canonicalJson,
    contentHash,
    diffLines,
    encodeDelta,
    lineHunks,
    lineStats,
    MemoryObjectStore,
    mergeText,
    resolveMergeChunks,
    sha256Hex,
    splitLines,
    unifiedDiff,
} from "../../src";

describe("sha256", () => {
    test.each([
        ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
        [
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ],
    ])("matches the FIPS 180-4 vector for %j", (input, expected) => {
        expect(sha256Hex(input)).toBe(expected);
    });

    test.each([
        ["a".repeat(1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"],
        ["é", "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"],
        // 55 and 56 bytes straddle the padding boundary (the length no longer fits the block).
        ["x".repeat(55), "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072"],
        ["x".repeat(56), "04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e"],
    ])("hashes multi-block, padding-edge and non-ASCII input (%#)", (input, expected) => {
        expect(sha256Hex(input)).toBe(expected);
    });
});

describe("canonical JSON and content hashes", () => {
    test("key order and undefined fields do not change the hash", () => {
        const a = { b: 1, a: [1, { y: 2, x: undefined, z: "s" }] };
        const b = { a: [1, { z: "s", y: 2 }], b: 1 };
        expect(canonicalJson(a)).toBe('{"a":[1,{"y":2,"z":"s"}],"b":1}');
        expect(contentHash(canonicalJson(a))).toBe(contentHash(canonicalJson(b)));
    });

    test("hashes are deterministic 128-bit hex ids", () => {
        const hash = contentHash('{"t":"json","v":42}');
        expect(hash).toMatch(/^[0-9a-f]{32}$/);
        expect(contentHash('{"t":"json","v":42}')).toBe(hash);
        expect(contentHash('{"t":"json","v":43}')).not.toBe(hash);
    });
});

describe("line diff", () => {
    test("splitLines keeps terminators", () => {
        expect(splitLines("a\nb\n\nc")).toEqual(["a\n", "b\n", "\n", "c"]);
        expect(splitLines("a\nb\n\nc").join("")).toBe("a\nb\n\nc");
    });

    test("finds the minimal edit script", () => {
        const a = ["a", "b", "c", "d", "e"];
        const b = ["a", "x", "c", "d", "y", "e"];
        const runs = diffLines(a, b);
        const deleted = runs.filter((r) => r.op === "del").reduce((n, r) => n + r.n, 0);
        const inserted = runs.filter((r) => r.op === "ins").reduce((n, r) => n + r.n, 0);
        expect(deleted).toBe(1);
        expect(inserted).toBe(2);
        expect(lineHunks(a, b)).toEqual([
            { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
            { aStart: 4, aEnd: 4, bStart: 4, bEnd: 5 },
        ]);
    });

    test("line stats and unified diff", () => {
        const before = "one\ntwo\nthree\nfour\n";
        const after = "one\n2\nthree\nfour\nfive\n";
        expect(lineStats(before, after)).toEqual({ added: 2, removed: 1 });
        const kinds = unifiedDiff(before, after).map((l) => `${l.kind}:${l.text}`);
        expect(kinds).toEqual([
            "context:one",
            "remove:two",
            "add:2",
            "context:three",
            "context:four",
            "add:five",
        ]);
    });

    test("random edits round-trip through a delta", () => {
        let seed = 7;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let round = 0; round < 30; round++) {
            const base = Array.from({ length: 40 }, (_, i) => `line ${Math.floor(random() * 10)} ${i}\n`);
            const target = base.flatMap((line) => {
                const r = random();
                if (r < 0.1) return [];
                if (r < 0.2) return [line, `inserted ${r}\n`];
                if (r < 0.3) return [`changed ${r}\n`];
                return [line];
            });
            const ops = encodeDelta(base.join(""), target.join(""));
            expect(applyDelta(base.join(""), ops)).toBe(target.join(""));
        }
    });
});

describe("diff3", () => {
    const base = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `${x}\n`).join("");

    test("changes to different lines merge cleanly", () => {
        const ours = base.replace("b\n", "B\n");
        const theirs = base.replace("f\n", "F\n");
        const chunks = mergeText(base, ours, theirs);
        expect(chunks.every((c) => c.kind === "ok")).toBe(true);
        expect(resolveMergeChunks(chunks)).toBe("a\nB\nc\nd\ne\nF\ng\n");
    });

    test("adjacent but separate replacements merge cleanly", () => {
        const ours = base.replace("c\n", "C\n");
        const theirs = base.replace("d\n", "D\n");
        expect(resolveMergeChunks(mergeText(base, ours, theirs))).toBe("a\nb\nC\nD\ne\nf\ng\n");
    });

    test("identical changes apply once", () => {
        const both = base.replace("c\n", "X\nY\n");
        const chunks = mergeText(base, both, both);
        expect(chunks.every((c) => c.kind === "ok")).toBe(true);
        expect(resolveMergeChunks(chunks)).toBe(both);
    });

    test("overlapping changes conflict and resolve per hunk", () => {
        const ours = base.replace("d\n", "ours\n");
        const theirs = base.replace("d\n", "theirs\n");
        const chunks = mergeText(base, ours, theirs);
        const conflicts = chunks.filter((c) => c.kind === "conflict");
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ base: ["d\n"], ours: ["ours\n"], theirs: ["theirs\n"] });
        expect(resolveMergeChunks(chunks)).toBe(ours);
        expect(resolveMergeChunks(chunks, ["theirs"])).toBe(theirs);
        expect(resolveMergeChunks(chunks, ["both"])).toBe(base.replace("d\n", "ours\ntheirs\n"));
    });

    test("insertions at the same spot conflict", () => {
        const ours = base.replace("c\n", "c\nours\n");
        const theirs = base.replace("c\n", "c\ntheirs\n");
        expect(mergeText(base, ours, theirs).filter((c) => c.kind === "conflict")).toHaveLength(1);
    });
});

describe("MemoryObjectStore", () => {
    test("deduplicates identical objects", () => {
        const store = new MemoryObjectStore();
        const a = store.put({ t: "json", v: { x: 1, y: 2 } });
        const b = store.put({ t: "json", v: { y: 2, x: 1 } });
        expect(a).toBe(b);
        expect(store.size).toBe(1);
    });

    test("stores a text edit as a small line delta and reads it back exactly", () => {
        const store = new MemoryObjectStore();
        const lines = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i} * millimeter;\n`);
        const v1 = lines.join("");
        const first = store.put({ t: "text", s: v1 });
        const edited = [...lines];
        edited[100] = "const value100 = 1000 * millimeter;\n";
        const v2 = edited.join("");
        const second = store.put({ t: "text", s: v2 }, first);
        expect(store.record(second)).toHaveProperty("d");
        expect(store.recordSize(second)).toBeLessThan(store.recordSize(first) / 20);
        expect(store.get(second)).toEqual({ t: "text", s: v2 });
        expect(store.stats().deltas).toBe(1);
    });

    test("bounds the delta chain", () => {
        const store = new MemoryObjectStore();
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i}\n`);
        let previous = store.put({ t: "text", s: lines.join("") });
        const depths: number[] = [];
        for (let i = 0; i < 40; i++) {
            lines[i % 100] = `edit ${i}\n`;
            const next = store.put({ t: "text", s: lines.join("") }, previous);
            const record = store.record(next)!;
            depths.push("d" in record ? record.d.depth : 0);
            previous = next;
        }
        expect(Math.max(...depths)).toBeLessThanOrEqual(16);
        expect(depths).toContain(0);
        expect((store.get(previous) as { s: string }).s).toBe(lines.join(""));
    });
});
