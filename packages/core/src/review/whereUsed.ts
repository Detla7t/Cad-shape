// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "../application";
import { Constants } from "../constants";
import { Serializer } from "../serialize";
import {
    DocumentVersionControl,
    MemoryObjectStore,
    Repository,
    readTree,
    StorageHistoryPersistence,
} from "../versioning";
import type { ReviewTarget } from "./comments";

type Properties = Record<string, unknown>;
export interface UsageNode {
    id: string;
    name: string;
    props: Properties;
}
export interface UsageSnapshot {
    documentId: string;
    documentName: string;
    label: string;
    commit?: string;
    nodes: UsageNode[];
}
export interface UsageReference {
    documentId: string;
    documentName: string;
    nodeId: string;
    nodeName: string;
    featureId?: string;
    featureName?: string;
    path: string;
    label: string;
    commit?: string;
    sourceVersion?: string;
    sourceCommit?: string;
}
function parsed(value: unknown): unknown {
    if (typeof value !== "string" || !/^[[{]/.test(value.trim())) return value;
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}
const excluded = new Set([
    "comment",
    "description",
    "name",
    "brep",
    "sourceText",
    "fileText",
    "fileBase64",
    "snapshotJson",
    "cachedBrep",
    "transform",
]);
const nodeKeys =
    /^(nodeId|sketchId|sourceId|sourceNodeId|partId|assemblyId|studioId|toolId|targetId|nodeIds|sketchIds|toolIds|targetIds)$/;
const featureKeys = /^(featureId|afterFeatureId|beforeFeatureId|throughFeatureId)$/;

/** Scan typed reference fields, never arbitrary matching text in a comment or source file. */
export function referencesInSnapshot(snapshot: UsageSnapshot, target: ReviewTarget): UsageReference[] {
    const result: UsageReference[] = [];
    const seen = new Set<string>();
    for (const node of snapshot.nodes) {
        const add = (path: string, feature?: Properties, link?: Properties) => {
            const key = `${node.id}/${String(feature?.["id"] ?? "")}/${path}`;
            if (seen.has(key)) return;
            seen.add(key);
            const version = link?.["version"] as Properties | undefined;
            result.push({
                documentId: snapshot.documentId,
                documentName: snapshot.documentName,
                nodeId: node.id,
                nodeName: node.name,
                featureId: feature?.["id"] as string | undefined,
                featureName: feature ? String(feature["name"] ?? feature["type"] ?? "Feature") : undefined,
                path,
                label: snapshot.label,
                commit: snapshot.commit,
                sourceVersion: version
                    ? `${version["kind"]}: ${version["name"] ?? version["id"]}`
                    : undefined,
                sourceCommit: link?.["resolvedCommit"] as string | undefined,
            });
        };
        const walk = (
            input: unknown,
            path: string,
            documentId: string,
            feature?: Properties,
            link?: Properties,
        ) => {
            const value = parsed(input);
            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    walk(item, `${path}[${index}]`, documentId, feature, link);
                });
            } else if (value && typeof value === "object") {
                const obj = value as Properties;
                const sourceDoc = typeof obj["documentId"] === "string" ? obj["documentId"] : documentId;
                const sourceLink = typeof obj["documentId"] === "string" ? obj : link;
                for (const [key, child] of Object.entries(obj)) {
                    if (excluded.has(key) || key === "id" || key === "parentId") continue;
                    const reference = target.featureId ? featureKeys.test(key) : nodeKeys.test(key);
                    const expected = target.featureId ?? target.nodeId;
                    if (
                        reference &&
                        expected &&
                        sourceDoc === target.documentId &&
                        (child === expected || (Array.isArray(child) && child.includes(expected)))
                    ) {
                        // Feature identifiers are unique within the owning document.
                        add(`${path}${path ? "." : ""}${key}`, feature, sourceLink);
                    } else if (typeof child === "object" || /Json$/.test(key)) {
                        walk(child, `${path}${path ? "." : ""}${key}`, sourceDoc, feature, sourceLink);
                    }
                }
            }
        };
        const features = parsed(node.props["featuresJson"]);
        if (Array.isArray(features)) {
            features.forEach((feature: Properties, index) => {
                if (
                    snapshot.documentId === target.documentId &&
                    node.id === target.nodeId &&
                    target.featureId &&
                    index > 0 &&
                    features.findIndex((f) => f.id === target.featureId) === index - 1
                ) {
                    add("Previous feature in body", feature);
                }
                walk(feature, `features[${index}]`, snapshot.documentId, feature);
            });
        }
        const properties = { ...node.props };
        delete properties["featuresJson"];
        walk(properties, "", snapshot.documentId);
    }
    return result;
}

/** Live documents plus saved documents and their named versions/branch heads. No models are rebuilt. */
export async function findWhereUsed(
    app: IApplication,
    target: ReviewTarget,
    history: boolean,
    signal?: AbortSignal,
): Promise<{ references: UsageReference[]; warnings: string[] }> {
    const references: UsageReference[] = [],
        warnings: string[] = [];
    const live = new Map([...app.documents].map((doc) => [doc.id, doc]));
    const stored = new Map<string, Properties>();
    try {
        for (let page = 0; ; page++) {
            signal?.throwIfAborted();
            const rows = await app.storage.page(Constants.DBName, Constants.DocumentTable, page);
            if (!rows.length) break;
            for (const row of rows) if (typeof row.id === "string") stored.set(row.id, row);
        }
    } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(`Saved documents could not be read: ${String(error)}`);
    }
    for (const id of new Set([...live.keys(), ...stored.keys()])) {
        signal?.throwIfAborted();
        const doc = live.get(id),
            saved = stored.get(id);
        const control = doc && DocumentVersionControl.of(doc);
        if (doc)
            references.push(
                ...referencesInSnapshot(
                    {
                        documentId: id,
                        documentName: doc.name,
                        label: `${control?.repository.current ?? "Workspace"} · current`,
                        commit: control?.head,
                        nodes: doc.modelManager.findNodes().map((node) => ({
                            id: node.id,
                            name: node.name,
                            props: Serializer.serializeObject(node),
                        })),
                    },
                    target,
                ),
            );
        else if (saved) {
            const nodes = (saved["models"] as Properties)?.["nodes"];
            references.push(
                ...referencesInSnapshot(
                    {
                        documentId: id,
                        documentName: String(saved["name"]),
                        label: "Saved workspace",
                        nodes: Array.isArray(nodes)
                            ? nodes.map((node) => ({ id: node.id, name: node.name, props: node }))
                            : [],
                    },
                    target,
                ),
            );
        }
        if (!history) continue;
        try {
            let repository = control?.repository;
            if (!repository) {
                const archive = await new StorageHistoryPersistence(app.storage).load(id);
                if (!archive) continue;
                const store = new MemoryObjectStore();
                for (const [hash, record] of archive.records) store.importRecord(hash, record);
                repository = new Repository(store);
                repository.loadRefs(archive.refs);
            }
            const refs = [
                ...repository.versions().map((v) => ({ label: `Version ${v.name}`, commit: v.commit })),
                ...repository.branches().map((b) => ({ label: `Branch ${b.name}`, commit: b.head })),
            ];
            for (const ref of refs) {
                signal?.throwIfAborted();
                const snapshot = readTree(repository.store, repository.getCommit(ref.commit).tree);
                references.push(
                    ...referencesInSnapshot(
                        {
                            documentId: id,
                            documentName: snapshot.meta.name,
                            ...ref,
                            nodes: [...snapshot.nodes].map(([nodeId, node]) => ({
                                id: nodeId,
                                name: String(node.props["name"] ?? nodeId),
                                props: { ...node.props },
                            })),
                        },
                        target,
                    ),
                );
            }
        } catch (error) {
            if (signal?.aborted) throw error;
            warnings.push(`History unavailable for ${doc?.name ?? saved?.["name"] ?? id}: ${String(error)}`);
        }
    }
    return { references, warnings };
}
