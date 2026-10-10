// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "./foundation/logger";
import { Result } from "./foundation/result";
import type { Serialized } from "./serialize";

/**
 * The schema of a serialized document (`Document.serialize()`, `document.json` in a `.chili3d`
 * project, a `.cd` file, the IndexedDB document store) — independent of the application's
 * version. Bump it for a change an older build cannot read correctly, together with the
 * migration(s) that bring older documents up to it (`registerDocumentMigration`).
 */
export const DOCUMENT_SCHEMA_VERSION = 1;

/**
 * Before `schemaVersion` existed, a build opened a document only when its `version` field was
 * exactly that build's document version — "0.7.1" for every build since. Schema-1 documents
 * keep writing it, so those builds still open them; later schemas write `schema-<n>` there, so
 * those builds refuse such a document instead of misreading it (and later overwriting it).
 */
export const LEGACY_DOCUMENT_VERSION = "0.7.1";

/** The `version` field written for a document of `schemaVersion` (see `LEGACY_DOCUMENT_VERSION`). */
export function legacyDocumentVersion(schemaVersion: number): string {
    return schemaVersion <= 1 ? LEGACY_DOCUMENT_VERSION : `schema-${schemaVersion}`;
}

/** The version fields at the head of a serialized document. */
export interface DocumentSchemaHeader {
    /** Legacy compatibility marker, see `LEGACY_DOCUMENT_VERSION`. */
    readonly version: string;
    readonly schemaVersion: number;
    /** The version of the application that wrote the document (informational). */
    readonly appVersion: string;
}

/** The header a document written by this build carries. */
export function documentSchemaHeader(
    appVersion: string,
    schemaVersion = DOCUMENT_SCHEMA_VERSION,
): DocumentSchemaHeader {
    return { version: legacyDocumentVersion(schemaVersion), schemaVersion, appVersion };
}

/**
 * Why a serialized document cannot be opened:
 * - `newer`: written for a schema this build does not know — refused, so it is never loaded
 *   partially and saved back over the newer file;
 * - `invalid`: not a document, or a malformed `schemaVersion`;
 * - `migration`: a migration threw.
 *
 * A document without `schemaVersion` is never refused: every later schema records one, so such a
 * document is schema 1 whatever its `version` marker says (see `schemaVersionOf`).
 */
export type DocumentSchemaErrorKind = "newer" | "invalid" | "migration";

export interface DocumentSchemaError {
    readonly kind: DocumentSchemaErrorKind;
    /** The document's schema, when it has a readable one. */
    readonly schemaVersion?: number;
    /** The newest schema this build reads. */
    readonly supportedVersion: number;
    /** The application version that wrote the document, when recorded. */
    readonly appVersion?: string;
    /** The migration that failed (`migration`). */
    readonly migration?: string;
    /** A sentence for the user. */
    readonly message: string;
}

/** A document brought up to the current schema, ready to deserialize. */
export interface PreparedDocument {
    readonly document: Serialized;
    /** The schema the document was stored with. */
    readonly fromVersion: number;
    /** The ids of the migrations that ran, in order. */
    readonly applied: readonly string[];
}

/**
 * One step of a document schema change: a pure function over the serialized JSON. It runs on
 * documents stored with a schema below `version`, after every migration of a lower version, and
 * may modify its argument (a private copy) as long as it returns the migrated document.
 */
export interface DocumentMigration {
    /** The schema version this migration produces (≥ 2). */
    readonly version: number;
    /** Unique name, e.g. `"parametric: extrude depth as expression"` — named in errors. */
    readonly id: string;
    readonly migrate: (document: Serialized) => Serialized;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** An ordered registry of document migrations, for one supported schema version. */
export class DocumentMigrationRegistry {
    readonly #migrations: DocumentMigration[] = [];

    constructor(readonly supportedVersion: number = DOCUMENT_SCHEMA_VERSION) {}

    /**
     * Adds a migration; returns a function that removes it. Throws for a version outside
     * 2…`supportedVersion` (bump `DOCUMENT_SCHEMA_VERSION` with the migration) or a repeated id.
     */
    register(migration: DocumentMigration): () => void {
        const { version, id } = migration;
        if (!Number.isInteger(version) || version < 2 || version > this.supportedVersion)
            throw new Error(
                `Document migration "${id}" targets schema ${version}; this build supports 2…${this.supportedVersion}`,
            );
        if (this.#migrations.some((x) => x.id === id))
            throw new Error(`Document migration "${id}" is already registered`);
        this.#migrations.push(migration);
        return () => {
            const index = this.#migrations.indexOf(migration);
            if (index >= 0) this.#migrations.splice(index, 1);
        };
    }

    /** Every migration in the order it runs: by version, then by registration. */
    migrations(): readonly DocumentMigration[] {
        // Array.prototype.sort is stable: equal versions keep their registration order.
        return [...this.#migrations].sort((a, b) => a.version - b.version);
    }

    /** The schema a serialized document was stored with. */
    schemaVersionOf(data: unknown): Result<number, DocumentSchemaError> {
        if (!isRecord(data)) return this.error("invalid", "The file is not a Chili3D document.");
        const appVersion = typeof data["appVersion"] === "string" ? data["appVersion"] : undefined;
        const schemaVersion = data["schemaVersion"];
        if (schemaVersion === undefined) {
            // Written before `schemaVersion` existed: schema 1, whatever the marker says. A
            // document the application itself saved must open — the Turbopack builds of
            // 9 October 2026 wrote the marker with embedded quotes ('"0.7.1"', a bundler define
            // that was stringified twice) — and a later schema always records `schemaVersion`,
            // so there is nothing newer to protect here.
            if (data["version"] !== LEGACY_DOCUMENT_VERSION) {
                Logger.warn(
                    `document: no schema version and an unexpected version marker ${JSON.stringify(data["version"])}; reading it as schema 1`,
                );
            }
            return Result.ok(1);
        }
        if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1)
            return this.error(
                "invalid",
                `The document has an invalid schema version (${String(schemaVersion)}).`,
            );
        if (schemaVersion > this.supportedVersion) {
            const writer = appVersion === undefined ? "a newer version of Chili3D" : `Chili3D ${appVersion}`;
            return this.error(
                "newer",
                `The document was saved by ${writer} (document schema ${schemaVersion}); this version reads schema ${this.supportedVersion} and older. Update Chili3D to open it.`,
                { schemaVersion, appVersion },
            );
        }
        return Result.ok(schemaVersion);
    }

    /**
     * Checks a serialized document and runs the migrations from its schema up to the supported
     * one. The input is never modified: when any migration runs, it works on a copy.
     */
    prepare(data: unknown): Result<PreparedDocument, DocumentSchemaError> {
        const version = this.schemaVersionOf(data);
        if (!version.isOk) return Result.err(version.error);
        const fromVersion = version.value;
        const pending = this.migrations().filter((x) => x.version > fromVersion);
        let document = data as Serialized;
        if (pending.length === 0) return Result.ok({ document, fromVersion, applied: [] });

        document = structuredClone(document);
        const applied: string[] = [];
        for (const migration of pending) {
            try {
                const migrated = migration.migrate(document);
                if (!isRecord(migrated)) throw new Error("the migration returned no document");
                document = migrated as Serialized;
            } catch (error) {
                return this.error(
                    "migration",
                    `The document could not be upgraded from schema ${fromVersion} (${migration.id}: ${error instanceof Error ? error.message : String(error)}).`,
                    { schemaVersion: fromVersion, migration: migration.id },
                );
            }
            applied.push(migration.id);
        }
        document = {
            ...document,
            version: legacyDocumentVersion(this.supportedVersion),
            schemaVersion: this.supportedVersion,
        };
        return Result.ok({ document, fromVersion, applied });
    }

    private error(
        kind: DocumentSchemaErrorKind,
        message: string,
        details: Partial<Pick<DocumentSchemaError, "schemaVersion" | "appVersion" | "migration">> = {},
    ): Result<never, DocumentSchemaError> {
        const error: DocumentSchemaError = {
            kind,
            supportedVersion: this.supportedVersion,
            message,
            ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
        };
        return Result.err(error);
    }
}

/** The application's migrations; feature packages add theirs with `registerDocumentMigration`. */
export const documentMigrations = new DocumentMigrationRegistry();

export function registerDocumentMigration(migration: DocumentMigration): () => void {
    return documentMigrations.register(migration);
}

/**
 * Every loader of a serialized document calls this before deserializing: it refuses documents
 * this build cannot read (a newer schema above all) and migrates older ones.
 */
export function prepareDocumentForLoad(data: unknown): Result<PreparedDocument, DocumentSchemaError> {
    return documentMigrations.prepare(data);
}
