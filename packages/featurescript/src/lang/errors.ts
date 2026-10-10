// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface SourcePosition {
    readonly line: number;
    readonly column: number;
    /** The studio (or built-in module) the code lives in. */
    readonly file: string;
}

export function formatPosition(pos: SourcePosition | undefined): string {
    return pos === undefined ? "" : `${pos.file}:${pos.line}:${pos.column}`;
}

/** Shared base: an error that knows where in FeatureScript source it happened. */
export class FsError extends Error {
    constructor(
        readonly detail: string,
        public pos: SourcePosition | undefined,
    ) {
        super(pos === undefined ? detail : `${detail} (${formatPosition(pos)})`);
        this.name = "FsError";
    }

    /** Pins the error to `pos` unless something more precise already did. */
    locate(pos: SourcePosition | undefined): this {
        if (this.pos === undefined && pos !== undefined) {
            this.pos = pos;
            this.message = `${this.detail} (${formatPosition(pos)})`;
        }
        return this;
    }
}

/** Raised by the lexer or parser: the source does not form a valid program. */
export class FsSyntaxError extends FsError {
    constructor(detail: string, pos: SourcePosition | undefined) {
        super(detail, pos);
        this.name = "FsSyntaxError";
    }
}

/**
 * A failure raised while running code — a type error, a failed precondition, a kernel
 * operation that could not build. `frames` is the FeatureScript call stack, innermost
 * first, so a message can say which user function the failure came through.
 */
export class FsRuntimeError extends FsError {
    readonly frames: string[] = [];

    constructor(detail: string, pos?: SourcePosition) {
        super(detail, pos);
        this.name = "FsRuntimeError";
    }

    /** The located message plus the FeatureScript call stack. */
    describe(): string {
        if (this.frames.length === 0) return this.message;
        return `${this.message}\n${this.frames.map((frame) => `  at ${frame}`).join("\n")}`;
    }
}

/**
 * A value thrown by `throw` (usually a `regenError` map). Catchable like any runtime
 * error; `value` is what a `catch (e)` binds.
 */
export class FsThrow extends FsRuntimeError {
    constructor(
        readonly value: unknown,
        detail: string,
        pos?: SourcePosition,
    ) {
        super(detail, pos);
        this.name = "FsThrow";
    }
}

/**
 * Raised when a run exceeds its step or recursion budget. Deliberately NOT catchable by
 * `try` — a runaway loop must end the feature, not be swallowed by a defensive catch.
 */
export class FsAbort extends FsRuntimeError {
    constructor(detail: string, pos?: SourcePosition) {
        super(detail, pos);
        this.name = "FsAbort";
    }
}
