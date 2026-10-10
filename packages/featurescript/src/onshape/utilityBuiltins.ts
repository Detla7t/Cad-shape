// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsContext } from "../context/fsContext";
import { resolveQuery, transientQuery } from "../context/queries";
import {
    expectArray,
    expectNumber,
    expectString,
    FsArray,
    type FsEnumType,
    FsMap,
    type FsValue,
    fail,
    fsArray,
    fsMap,
} from "../lang/values";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * Built-ins with little or no modeling state: point clustering, transient id strings,
 * compressed queries, profiling timers, debug frames and the tolerance bookkeeping of
 * feature parameters.
 */

/**
 * The kernel's modeling tolerance (OCCT `Precision::Confusion()`, 1e-7 mm), in meters.
 * Entity tolerances are not exposed by the kernel bindings; every entity is reported at
 * this, its default.
 */
export const KERNEL_TOLERANCE = 1e-10;

export function installUtilityBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    define("clusterPoints", (args) => {
        const points = expectArray(args[0], "@clusterPoints points").items.map((point) =>
            expectArray(point, "A point").items.map((c) => expectNumber(c, "A point coordinate")),
        );
        const tolerance = expectNumber(args[1], "@clusterPoints tolerance");
        return fsArray(clusterIndices(points, tolerance).map((cluster) => fsArray(cluster)));
    });

    // Transient ids are strings here already.
    define("transientIdToString", (args) => expectString(args[0], "@transientIdToString id"));
    define("unpackQuery", (args) => {
        const decoded = new CompressedQueryReader(expectString(args[1], "qCompressed query"), bridge).read();
        if (!(decoded instanceof FsMap) || decoded.tag !== "Query")
            fail("qCompressed: the string is not a query");
        return decoded;
    });

    // Profiling timers, shared by every run of this interpreter (a timer may span features).
    const timers = new Map<string, number>();
    define("startTimer", (args) => {
        timers.set(expectString(args[0], "@startTimer name"), performance.now());
        return undefined;
    });
    define("printTimer", (args, site) => {
        const name = expectString(args[0], "@printTimer name");
        const start = timers.get(name);
        if (start === undefined) fail(`Timer "${name}" has not been started`);
        site.print(
            `${name === "" ? "Timer" : `Timer ${name}`}: ${(performance.now() - start).toFixed(3)} ms`,
        );
        return undefined;
    });
    // A visualization aid only: there is no viewport to draw it in during a run.
    define("addReferenceCSysFrame", () => undefined);

    // Tolerances: no feature parameter carries a tolerance here (there is no tolerance UI),
    // so each reports none (and no parameter is tolerant: `getTolerantParameterIds` is {}).
    define("getParameterToleranceInfo", () =>
        fsMap(
            { toleranceType: bridge.enumValue("ToleranceType", "NONE"), usePrecisionOverride: false },
            "ToleranceInfo",
        ),
    );
    // A tolerance library places no requirement here on a variable studio.
    define("validateToleranceSchema", () => fsArray([]));
    define("evTolerances", (args) => {
        const context = FsContext.of(args[0]);
        const result = new FsMap();
        for (const ref of resolveQuery(context, bridge.toLocal(entitiesOf(args[1])))) {
            if (ref.kind !== "BODY") result.set(transientQuery(ref).field("transientId"), KERNEL_TOLERANCE);
        }
        return result;
    });
    define("evMaxTolerance", (args) => {
        const refs = resolveQuery(FsContext.of(args[0]), bridge.toLocal(entitiesOf(args[1])));
        return bridge.length(refs.length === 0 ? 0 : KERNEL_TOLERANCE);
    });
}

function entitiesOf(definition: FsValue): FsValue {
    if (!(definition instanceof FsMap)) fail("Expected a definition map with entities");
    return definition.field("entities") ?? definition.field("entity");
}

/**
 * Groups points so that points farther apart than `tolerance` never share a cluster: a
 * cluster grows from its first point by every later point within `tolerance` of all
 * its members. A tight group with nothing else nearby is therefore one cluster.
 */
export function clusterIndices(points: readonly number[][], tolerance: number): number[][] {
    const assigned = new Array<boolean>(points.length).fill(false);
    const distance = (a: number[], b: number[]) => Math.hypot(...a.map((c, k) => c - (b[k] ?? 0)));
    const clusters: number[][] = [];
    for (let i = 0; i < points.length; i++) {
        if (assigned[i]) continue;
        const cluster = [i];
        assigned[i] = true;
        for (let j = i + 1; j < points.length; j++) {
            if (assigned[j]) continue;
            if (cluster.every((k) => distance(points[k], points[j]) <= tolerance)) {
                cluster.push(j);
                assigned[j] = true;
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

/**
 * Reads Onshape's compressed query strings (`qCompressed`): a type-tagged serialization
 * where `S<len>$<text>` is a string, `B<len>$<Type><value>` a value of a named type,
 * `M<n>` a map of n key/value pairs, `A<n>` an array, `D<number>$` a number and
 * `T` / `F` / `U` true, false and undefined (lengths and counts in lowercase hex). Enum
 * types become std enum values; a query's `queryType` string becomes a `QueryType`.
 */
class CompressedQueryReader {
    private at = 0;

    constructor(
        private readonly text: string,
        private readonly bridge: StdBridge,
    ) {
        if (this.text.startsWith("%")) this.at = 1;
    }

    read(): FsValue {
        const value = this.value();
        if (this.at !== this.text.length) this.error();
        return value;
    }

    private error(): never {
        fail(`qCompressed: cannot decode the query at character ${this.at}`);
    }

    private value(): FsValue {
        const token = this.text[this.at++];
        switch (token) {
            case "S":
                return this.take(this.hex("$"));
            case "B": {
                const type = this.take(this.hex("$"));
                return this.typed(type, this.value());
            }
            case "M": {
                const map = new FsMap();
                for (let n = this.hex(); n > 0; n--) {
                    const key = this.value();
                    map.set(key, this.value());
                }
                return map;
            }
            case "A": {
                const items: FsValue[] = [];
                for (let n = this.hex(); n > 0; n--) items.push(this.value());
                return fsArray(items);
            }
            case "D": {
                const end = this.text.indexOf("$", this.at);
                if (end < 0) this.error();
                const number = Number(this.text.slice(this.at, end));
                if (Number.isNaN(number)) this.error();
                this.at = end + 1;
                return number;
            }
            case "T":
                return true;
            case "F":
                return false;
            case "U":
                return undefined;
            default:
                this.at--;
                this.error();
        }
    }

    /** Lowercase hex digits, optionally followed by `terminator`. */
    private hex(terminator?: string): number {
        const start = this.at;
        while (this.at < this.text.length && /[0-9a-f]/.test(this.text[this.at])) this.at++;
        if (this.at === start) this.error();
        const value = Number.parseInt(this.text.slice(start, this.at), 16);
        if (terminator !== undefined) {
            if (this.text[this.at] !== terminator) this.error();
            this.at++;
        }
        return value;
    }

    private take(length: number): string {
        if (this.at + length > this.text.length) this.error();
        const text = this.text.slice(this.at, this.at + length);
        this.at += length;
        return text;
    }

    private typed(type: string, value: FsValue): FsValue {
        if (typeof value === "string") {
            const enumType = this.enumType(type);
            const member = enumType?.member(value);
            if (member !== undefined) return member;
        }
        if (value instanceof FsMap) {
            const tagged = new FsMap(value.pairs(), type);
            const queryType = tagged.field("queryType");
            if (type === "Query" && typeof queryType === "string")
                tagged.set("queryType", this.typed("QueryType", queryType));
            return tagged;
        }
        if (value instanceof FsArray) return new FsArray(value.items, type);
        return value;
    }

    private enumType(name: string): FsEnumType | undefined {
        try {
            return this.bridge.stdEnum(name);
        } catch {
            return undefined;
        }
    }
}
