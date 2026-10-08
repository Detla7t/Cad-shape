// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    addReviewComment,
    deleteReviewComment,
    type IDocument,
    PubSub,
    type ReviewImage,
    type ReviewTarget,
    reviewComments,
    updateReviewComment,
} from "@chili3d/core";
import { action, labeled, panelBody, selectionTarget, targetKey, targetSelect, textElement } from "./helpers";
import { captureMarkup } from "./markupEditor";
import style from "./review.module.css";

export class CommentsPanel {
    readonly element: HTMLElement;
    private readonly list = document.createElement("div");
    private readonly search = document.createElement("input");
    private readonly body: HTMLElement;
    private images: ReviewImage[] = [];
    private disposed = false;
    private readonly target;
    constructor(
        private readonly doc: IDocument,
        target?: ReviewTarget,
    ) {
        const panel = panelBody("Comments");
        this.element = panel.root;
        this.body = panel.body;
        this.target = targetSelect(doc, target);
        const selection = action("Use selection", () => {
            this.target.select.value = targetKey(selectionTarget(doc));
        });
        const text = document.createElement("textarea");
        text.placeholder = "Add a comment…";
        text.setAttribute("aria-label", "Comment text");
        const tags = document.createElement("input");
        tags.placeholder = "Tags, separated by commas";
        tags.setAttribute("aria-label", "Comment tags");
        const file = document.createElement("input");
        file.type = "file";
        file.accept = "image/png,image/jpeg,image/webp";
        file.multiple = true;
        file.hidden = true;
        file.setAttribute("aria-label", "Attach comment images");
        const attachments = document.createElement("div"),
            error = textElement("p", "", style.error);
        const renderImages = () => {
            attachments.replaceChildren(
                ...this.images.map((image, index) => {
                    const row = textElement("div", image.name, style.muted);
                    row.append(
                        action("Remove", () => {
                            this.images.splice(index, 1);
                            renderImages();
                        }),
                    );
                    return row;
                }),
            );
        };
        file.onchange = async () => {
            error.textContent = "";
            for (const image of file.files ?? []) {
                if (!/^image\/(png|jpeg|webp)$/.test(image.type) || image.size > 8 * 1024 * 1024) {
                    error.textContent = "Use PNG, JPEG or WebP images up to 8 MB each.";
                    continue;
                }
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(image);
                }).catch(() => undefined);
                if (!dataUrl) {
                    error.textContent = "This image could not be read.";
                    continue;
                }
                if (!this.disposed) this.images.push({ name: image.name, dataUrl });
            }
            file.value = "";
            renderImages();
        };
        const toolbar = document.createElement("div");
        toolbar.className = style.toolbar;
        toolbar.append(
            action("Attach images", () => file.click()),
            action("Add markup", () => {
                const view = doc.application.activeView;
                if (!view || view.document !== doc) return;
                void captureMarkup(view)
                    .then((image) => {
                        if (image && !this.disposed) {
                            this.images.push(image);
                            renderImages();
                        }
                    })
                    .catch((err) => {
                        error.textContent = String(err);
                    });
            }),
            action("Add comment", () => {
                if (!text.value.trim() && !this.images.length) {
                    error.textContent = "Enter a comment or attach an image.";
                    return;
                }
                addReviewComment(doc, {
                    target: this.target.value(),
                    text: text.value,
                    tags: tags.value.split(","),
                    images: this.images,
                });
                text.value = "";
                tags.value = "";
                this.images = [];
                error.textContent = "";
                renderImages();
            }),
        );
        this.search.type = "search";
        this.search.placeholder = "Search comments, tags or targets";
        this.search.setAttribute("aria-label", "Search comments");
        this.search.oninput = this.render;
        this.body.append(
            labeled("On", this.target.select),
            selection,
            text,
            tags,
            toolbar,
            file,
            attachments,
            error,
            this.search,
            this.list,
        );
        this.element.addEventListener("keydown", (event) => event.stopPropagation());
        PubSub.default.sub("reviewCommentsChanged", this.changed);
        this.render();
    }
    private readonly changed = (doc: IDocument) => {
        if (doc === this.doc) this.render();
    };
    private readonly render = () => {
        const query = this.search.value.toLowerCase();
        const comments = reviewComments(this.doc)
            .filter((c) => `${c.target.name} ${c.text} ${c.tags.join(" ")}`.toLowerCase().includes(query))
            .reverse();
        this.list.replaceChildren();
        if (!comments.length) this.list.append(textElement("p", "No comments yet.", style.muted));
        for (const comment of comments) {
            const card = document.createElement("article");
            card.className = style.entry;
            card.dataset["resolved"] = String(comment.resolved);
            const target = action(comment.target.name, () => {
                const node = this.doc.modelManager.findNode((n) => n.id === comment.target.nodeId);
                if (node) this.doc.selection.setSelectedNodes([node], false);
            });
            target.title = comment.target.featureId ? `Feature ${comment.target.featureId}` : "Select target";
            card.append(
                target,
                textElement(
                    "div",
                    `${new Date(comment.created).toLocaleString()} · ${comment.branch ?? "Workspace"}${comment.commit ? ` · ${comment.commit.slice(0, 9)}` : ""}`,
                    style.muted,
                ),
                textElement("p", comment.text),
            );
            if (
                comment.target.nodeId &&
                !this.doc.modelManager.findNode((n) => n.id === comment.target.nodeId)
            )
                card.append(
                    textElement(
                        "p",
                        "Target is absent from this workspace; comment retained at its recorded version.",
                        style.muted,
                    ),
                );
            for (const tag of comment.tags) card.append(textElement("span", `#${tag}`, style.tag));
            for (const attachment of comment.images) {
                if (!/^data:image\/(png|jpeg|webp);base64,/.test(attachment.dataUrl)) continue;
                const img = document.createElement("img");
                img.src = attachment.dataUrl;
                img.alt = attachment.name;
                img.onclick = () => {
                    const dialog = document.createElement("dialog");
                    dialog.className = style.markup;
                    const large = img.cloneNode() as HTMLImageElement;
                    large.style.width = "100%";
                    dialog.append(
                        large,
                        action("Close", () => dialog.remove()),
                    );
                    dialog.oncancel = () => dialog.remove();
                    document.body.append(dialog);
                    dialog.showModal();
                };
                card.append(img);
            }
            const actions = document.createElement("div");
            actions.className = style.toolbar;
            actions.append(
                action(comment.resolved ? "Reopen" : "Resolve", () =>
                    updateReviewComment(this.doc, comment.id, { resolved: !comment.resolved }),
                ),
                action("Edit", () => {
                    const edit = document.createElement("textarea");
                    edit.value = comment.text;
                    edit.setAttribute("aria-label", "Edit comment text");
                    const editTags = document.createElement("input");
                    editTags.value = comment.tags.join(", ");
                    editTags.setAttribute("aria-label", "Edit comment tags");
                    actions.replaceChildren(
                        edit,
                        editTags,
                        action("Save", () =>
                            updateReviewComment(this.doc, comment.id, {
                                text: edit.value,
                                tags: editTags.value
                                    .split(",")
                                    .map((t) => t.trim())
                                    .filter(Boolean),
                            }),
                        ),
                        action("Cancel", this.render),
                    );
                    edit.focus();
                }),
                action("Delete", () => deleteReviewComment(this.doc, comment.id)),
            );
            card.append(actions);
            this.list.append(card);
        }
    };
    dispose() {
        this.disposed = true;
        PubSub.default.remove("reviewCommentsChanged", this.changed);
    }
}
