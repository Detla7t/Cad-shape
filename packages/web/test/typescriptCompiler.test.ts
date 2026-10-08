// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rs } from "@rstest/core";
import rustPackage from "tsc-rs/package.json" with { type: "json" };
import { compilerArguments, runCompiler } from "../../../scripts/typescript-compiler.mjs";

const quiet = () => {};
function executable(backend: string, source = "process.exit(0)") {
    return { command: process.execPath, args: ["-e", source, "--"], label: backend };
}

describe("TypeScript compiler failover", () => {
    test("prefers Rust and does not run additional compilers on success", async () => {
        const resolveCommand = rs.fn((backend: string) => executable(backend));
        const result = await runCompiler(["--noEmit"], { compiler: "auto", resolveCommand, log: quiet });
        expect(result.status).toBe(0);
        expect(result.backend).toBe("rust");
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust"]);
    });

    test("missing native executables fail over to Go with an explanation", async () => {
        const log = rs.fn((_message: string) => {});
        const resolveCommand = rs.fn((backend: string) =>
            backend === "rust"
                ? { command: "/missing/chili-test-compiler", args: [], label: backend }
                : executable(backend),
        );
        const result = await runCompiler([], { compiler: "auto", resolveCommand, log });
        expect(result.status).toBe(0);
        expect(result.backend).toBe("go");
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust", "go"]);
        expect(log.mock.calls.flat().join("\n")).toContain("Falling back to go");
    });

    test("missing platform packages and compiler panics fall back to retained TypeScript", async () => {
        const resolveCommand = rs.fn((backend: string) => {
            if (backend === "rust") throw new Error("Unsupported platform package");
            return executable(backend, backend === "go" ? "process.exit(2)" : undefined);
        });
        const result = await runCompiler([], { compiler: "auto", resolveCommand, log: quiet });
        expect(result.status).toBe(0);
        expect(result.backend).toBe("legacy");
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust", "go", "legacy"]);
    });

    test.each([1, 2])("TS diagnostics (exit %s) never trigger fallback", async (code) => {
        const resolveCommand = rs.fn((backend: string) =>
            executable(
                backend,
                `console.log("input.ts(1,1): error TS2322: Bad type"); process.exit(${code})`,
            ),
        );
        const result = await runCompiler([], { compiler: "auto", resolveCommand, log: quiet });
        expect(result.status).toBe(code);
        expect(result.stdout).toContain("TS2322");
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust"]);
    });

    test.each(["rust", "go", "legacy"])("explicit %s selection never falls back", async (compiler) => {
        const resolveCommand = rs.fn((backend: string) => executable(backend, "process.exit(101)"));
        const result = await runCompiler([], { compiler, resolveCommand, log: quiet });
        expect(result.status).toBe(101);
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual([compiler]);
    });

    test("all unavailable compilers fail the command", async () => {
        const resolveCommand = rs.fn((_backend: string): ReturnType<typeof executable> => {
            throw new Error("Not installed");
        });
        const result = await runCompiler([], { compiler: "auto", resolveCommand, log: quiet });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Not installed");
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust", "go", "legacy"]);
    });

    test("terminates a hung compiler before falling back", async () => {
        const resolveCommand = rs.fn((backend: string) =>
            executable(backend, backend === "rust" ? "setInterval(() => {}, 1000)" : undefined),
        );
        const result = await runCompiler([], {
            compiler: "auto",
            timeoutMs: 500,
            resolveCommand,
            log: quiet,
        });
        expect(result.status).toBe(0);
        expect(result.backend).toBe("go");
        expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust", "go"]);
    });

    test("cancellation stops the active compiler without starting a fallback", async () => {
        const controller = new AbortController();
        const resolveCommand = rs.fn((backend: string) => executable(backend, "setInterval(() => {}, 1000)"));
        const timer = setTimeout(() => controller.abort(), 100);
        try {
            const result = await runCompiler([], {
                compiler: "auto",
                resolveCommand,
                signal: controller.signal,
                log: quiet,
            });
            expect(result.status).toBe(130);
            expect(resolveCommand.mock.calls.map(([backend]) => backend)).toEqual(["rust"]);
        } finally {
            clearTimeout(timer);
        }
    });

    test("environment selection can be explicitly overridden", async () => {
        rs.stubEnv("CHILI_TS_COMPILER", "go");
        try {
            const resolveCommand = rs.fn((backend: string) => executable(backend));
            const fromEnvironment = await runCompiler([], { resolveCommand, log: quiet });
            const explicit = await runCompiler([], { compiler: "legacy", resolveCommand, log: quiet });
            expect(fromEnvironment.backend).toBe("go");
            expect(explicit.backend).toBe("legacy");
        } finally {
            rs.unstubAllEnvs();
        }
    });

    test("selection flags preserve compiler arguments including paths with spaces", () => {
        expect(compilerArguments(["--compiler", "go", "-p", "a folder/tsconfig.json"])).toEqual({
            compiler: "go",
            args: ["-p", "a folder/tsconfig.json"],
        });
        expect(compilerArguments(["--compiler=legacy", "--extendedDiagnostics"])).toEqual({
            compiler: "legacy",
            args: ["--extendedDiagnostics"],
        });
        expect(() => compilerArguments(["--compiler"])).toThrow("Unknown TypeScript compiler");
        expect(() => compilerArguments(["--compiler=typo"])).toThrow("Unknown TypeScript compiler");
    });
});

describe("installed compilers", () => {
    const compilers = ["go", "legacy"];
    if (`@tsc-rs/${process.platform}-${process.arch}` in rustPackage.optionalDependencies) {
        compilers.unshift("rust");
    }
    test.each(
        compilers,
    )("%s checks decorators, rejects bad types, and emits declarations", async (compiler) => {
        const scratch = await mkdtemp(join(tmpdir(), "chili compiler "));
        const config = join(scratch, "tsconfig.json");
        const source = join(scratch, "example.ts");
        const log = quiet;
        try {
            await writeFile(
                config,
                JSON.stringify({
                    compilerOptions: {
                        strict: true,
                        target: "ES2022",
                        types: [],
                        experimentalDecorators: true,
                        declaration: true,
                        emitDeclarationOnly: true,
                        noEmitOnError: true,
                        outDir: "types",
                    },
                    files: ["example.ts"],
                }),
            );
            await writeFile(
                source,
                "function serializable<T extends Function>(ctor: T): T { return ctor; }\n" +
                    "@serializable export class Model { readonly length: number = 12; }\n",
            );
            const valid = await runCompiler(["-p", config], { compiler, log });
            expect(valid.stdout + valid.stderr).toBe("");
            expect(valid.status).toBe(0);
            expect(valid.backend).toBe(compiler);
            expect(await readFile(join(scratch, "types/example.d.ts"), "utf8")).toContain(
                "readonly length: number",
            );
            await writeFile(source, 'export const length: number = "invalid";\n');
            const invalid = await runCompiler(["-p", config, "--noEmit"], { compiler, log });
            expect(invalid.status).not.toBe(0);
            expect(invalid.stdout).toContain("TS2322");
            expect(invalid.backend).toBe(compiler);
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    }, 30_000);
});
