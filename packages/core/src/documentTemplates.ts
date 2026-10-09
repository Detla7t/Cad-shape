// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "./application";
import type { IDocument } from "./document";
import type { Result } from "./foundation/result";

/**
 * Public templates: documents any user of the app can start from, listed in the dashboard's
 * Public section and opened by `?template=<id>`. A template builds a fresh document (modules
 * register theirs when they load), so it always reflects the current generators; opening one
 * makes a copy the user owns.
 */
export interface DocumentTemplate {
    /** Stable id, used in links (`?template=end-cap-configurator`). */
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** Who publishes it ("Chili3D", a module, a plugin). */
    readonly owner: string;
    readonly tags?: readonly string[];
    /** Image URL (a data URL is fine) shown beside the name. */
    readonly thumbnail?: string;
    /** Creates the document and makes it active; the caller saves it into the user's library. */
    create(application: IApplication): Promise<Result<IDocument>>;
}

const templates = new Map<string, DocumentTemplate>();

/** Publishes `template`; returns a function that withdraws it. A later registration with the same id replaces it. */
export function registerDocumentTemplate(template: DocumentTemplate): () => void {
    templates.set(template.id, template);
    return () => {
        if (templates.get(template.id) === template) templates.delete(template.id);
    };
}

/** Every published template, by name. */
export function documentTemplates(): DocumentTemplate[] {
    return [...templates.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findDocumentTemplate(id: string): DocumentTemplate | undefined {
    return templates.get(id);
}
