// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Id, PubSub, Transaction } from "../foundation";
import { DocumentVersionControl } from "../versioning";

export interface ReviewTarget {
    documentId: string;
    nodeId?: string;
    featureId?: string;
    name: string;
}
export interface ReviewImage {
    name: string;
    dataUrl: string;
    markup?: boolean;
}
export interface ReviewComment {
    id: string;
    target: ReviewTarget;
    text: string;
    tags: string[];
    images: ReviewImage[];
    created: string;
    commit?: string;
    branch?: string;
    resolved: boolean;
}
export function reviewComments(doc: IDocument): ReviewComment[] {
    const value = doc.userData?.["reviewComments"];
    return Array.isArray(value) ? structuredClone(value) : [];
}
function writeComments(doc: IDocument, after: ReviewComment[], label: string) {
    const before = reviewComments(doc);
    const apply = (value: ReviewComment[]) => {
        doc.userData = { ...doc.userData, reviewComments: structuredClone(value) };
        PubSub.default.pub("reviewCommentsChanged", doc);
    };
    Transaction.execute(doc, label, () => {
        apply(after);
        Transaction.add(doc, {
            name: label,
            undo: () => apply(before),
            redo: () => apply(after),
            dispose() {},
        });
    });
}
export function addReviewComment(
    doc: IDocument,
    draft: Pick<ReviewComment, "target" | "text" | "tags" | "images">,
): ReviewComment {
    const control = DocumentVersionControl.of(doc);
    control?.flush();
    const comment: ReviewComment = {
        ...structuredClone(draft),
        id: Id.generate(),
        created: new Date().toISOString(),
        text: draft.text.trim(),
        tags: [...new Set(draft.tags.map((t) => t.trim().replace(/^#/, "")).filter(Boolean))],
        commit: control?.head,
        branch: control?.repository.current,
        resolved: false,
    };
    writeComments(doc, [...reviewComments(doc), comment], "Add review comment");
    return comment;
}
export function updateReviewComment(
    doc: IDocument,
    id: string,
    patch: Partial<Pick<ReviewComment, "text" | "tags" | "resolved">>,
) {
    writeComments(
        doc,
        reviewComments(doc).map((c) => (c.id === id ? { ...c, ...patch } : c)),
        "Edit review comment",
    );
}
export function deleteReviewComment(doc: IDocument, id: string) {
    writeComments(
        doc,
        reviewComments(doc).filter((c) => c.id !== id),
        "Delete review comment",
    );
}
