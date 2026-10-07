// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FeatureParameter,
    type IDocument,
    type IShape,
    isConsumedTool,
    Matrix4,
    Result,
    ShapeNode,
} from "@chili3d/core";
import type { FeatureScriptParameterValue } from "../features/feature";
import { bodyKindOf } from "./context/fsContext";
import { documentVariables, plainDefinition, plainParameterRows } from "./featureScriptFeature";
import type { FeatureSpec } from "./featureSpec";
import type { FeatureStudioNode } from "./featureStudioNode";
import type { TableExport } from "./lang/interpreter";
import { type CompiledStudio, compileDocumentStudio, documentStudios, findStudio } from "./studioCompiler";
import { runTable, type TableFormatOptions, type TableHostBody, type TableRunResult } from "./tableRuntime";

/**
 * The document side of custom tables: which tables the document's Feature Studios
 * export, their parameters, and running one against the Part Studio — the document's
 * visible parts — with parameter values stored by key in app units, like a custom
 * feature's (numbers may be expressions over the document's variables).
 */

/** One custom table a document offers: which studio exports it, under which name. */
export interface CustomTableEntry {
    readonly studio: FeatureStudioNode;
    readonly tableName: string;
    readonly displayName: string;
    readonly description?: string;
}

export type TableParameterValues = Readonly<Record<string, FeatureScriptParameterValue>>;

/** Every custom table the document's studios export (studios that fail to compile offer none). */
export function customTables(document: IDocument, studio?: FeatureStudioNode): CustomTableEntry[] {
    const studios = studio === undefined ? documentStudios(document) : [studio];
    return studios.flatMap((candidate) => {
        const compiled = compileDocumentStudio(document, candidate.id);
        if (compiled === undefined || compiled.error !== undefined) return [];
        // Re-exported tables belong to the studio that defines them.
        return compiled.tables
            .filter((table) => table.module === compiled.module)
            .map((table) => ({
                studio: candidate,
                tableName: table.name,
                displayName: table.displayName,
                description: table.description,
            }));
    });
}

interface ResolvedTable {
    readonly compiled: CompiledStudio;
    readonly table: TableExport;
    readonly spec: FeatureSpec;
}

function resolveTable(document: IDocument, studioId: string, tableName: string): Result<ResolvedTable> {
    const compiled = compileDocumentStudio(document, studioId);
    if (compiled === undefined) return Result.err("The Feature Studio of this table was deleted");
    if (compiled.error !== undefined) {
        const name = findStudio(document, studioId)?.name ?? studioId;
        return Result.err(`Feature Studio "${name}" has an error: ${compiled.error}`);
    }
    const table = compiled.table(tableName);
    const spec = compiled.tableSpec(tableName);
    if (table === undefined || spec === undefined)
        return Result.err(`The Feature Studio no longer exports the table "${tableName}"`);
    return Result.ok({ compiled, table, spec });
}

/** A table's parameter spec (its precondition, read like a custom feature's). */
export function customTableSpec(
    document: IDocument,
    studioId: string,
    tableName: string,
): Result<FeatureSpec> {
    const resolved = resolveTable(document, studioId, tableName);
    return resolved.isOk ? Result.ok(resolved.value.spec) : Result.err(resolved.error);
}

/** The parameters a table panel shows for `values`: the visible ones, as feature-panel rows. */
export function customTableParameters(
    document: IDocument,
    studioId: string,
    tableName: string,
    values: TableParameterValues = {},
): FeatureParameter[] {
    const spec = customTableSpec(document, studioId, tableName);
    if (!spec.isOk) return [];
    return plainParameterRows(spec.value, values, document.variables.evaluate().scope);
}

/**
 * The Part Studio's parts: visible solid shape nodes that are not a body's consumed
 * boolean tools, in model-tree order.
 */
export function partStudioNodes(document: IDocument): ShapeNode[] {
    return document.modelManager
        .findNodes((node) => node instanceof ShapeNode)
        .filter((node): node is ShapeNode => node instanceof ShapeNode)
        .filter((node) => node.visible && node.parentVisible && !isConsumedTool(node))
        .filter((node) => {
            const shape = node.shape;
            return shape.isOk && bodyKindOf(shape.value) === "SOLID";
        });
}

/** The parts in world space, plus the transformed copies the caller must dispose. */
function partStudioBodies(document: IDocument): { bodies: TableHostBody[]; owned: IShape[] } {
    const owned: IShape[] = [];
    const bodies = partStudioNodes(document).map((node) => {
        const shape = node.shape.value;
        const matrix = node.worldTransform();
        if (matrix.equals(Matrix4.identity())) return { shape, name: node.name };
        const placed = shape.transformedMul(matrix);
        owned.push(placed);
        return { shape: placed, name: node.name };
    });
    return { bodies, owned };
}

/**
 * Runs a document studio's table over the Part Studio. Failures — the studio, the
 * parameter values, the run — come back as the result's `error`, never thrown.
 */
export function evaluateCustomTable(
    document: IDocument,
    studioId: string,
    tableName: string,
    values: TableParameterValues = {},
    format?: TableFormatOptions,
): TableRunResult {
    const resolved = resolveTable(document, studioId, tableName);
    if (!resolved.isOk) return { tables: [], error: resolved.error };
    const { compiled, table, spec } = resolved.value;
    const scope = document.variables.evaluate().scope;
    const definition = plainDefinition(spec, values, scope);
    if (!definition.isOk) return { tables: [], error: definition.error };
    let parts: ReturnType<typeof partStudioBodies> | undefined;
    try {
        parts = partStudioBodies(document);
        return runTable({
            interpreter: compiled.interpreter,
            table,
            bodies: parts.bodies,
            definition: definition.value,
            variables: documentVariables(scope),
            format,
        });
    } catch (error) {
        return { tables: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
        for (const shape of parts?.owned ?? []) shape.dispose();
    }
}
