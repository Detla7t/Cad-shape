// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { IDisposable } from "../foundation";
import type { I18nKeys } from "../i18n";

export type DocumentPanelId = "configuration" | "tables" | "inspection" | "variables";
export interface DocumentPanelContent extends IDisposable {
    readonly element: HTMLElement;
}
export interface DocumentPanelDefinition {
    readonly id: DocumentPanelId;
    readonly title: I18nKeys;
    readonly icon: string;
    create(document: IDocument, onApplied?: () => void): DocumentPanelContent;
}
export interface IDocumentPanelHost {
    open(id: DocumentPanelId, document: IDocument, onApplied?: () => void): boolean;
}

/** Feature packages supply panel contents; the UI supplies the dock. */
export const DocumentPanels = {
    definitions: new Map<DocumentPanelId, DocumentPanelDefinition>(),
    host: undefined as IDocumentPanelHost | undefined,
    register(definition: DocumentPanelDefinition): void {
        this.definitions.set(definition.id, definition);
    },
    open(id: DocumentPanelId, document: IDocument, onApplied?: () => void): boolean {
        return this.host?.open(id, document, onApplied) ?? false;
    },
};
