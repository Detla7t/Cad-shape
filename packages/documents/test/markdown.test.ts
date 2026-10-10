// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { htmlPage, htmlToText, markdownToHtmlPage, renderMarkdown } from "../src/text/markdown";

const element = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
};

describe("Markdown", () => {
    test("GitHub-flavored Markdown renders headings, emphasis, tables, lists and code", () => {
        const html = renderMarkdown(
            "# Notes\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```js\nlet x = 1;\n```\n",
        );
        const root = element(html);
        expect(root.querySelector("h1")?.textContent).toBe("Notes");
        expect(root.querySelector("strong")?.textContent).toBe("bold");
        expect(Array.from(root.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual(["1", "2"]);
        expect(root.querySelector("input[type=checkbox]")).toBeNull(); // form controls are removed
        expect(root.querySelector("pre code")?.textContent).toBe("let x = 1;\n");
    });

    test("raw HTML in Markdown is sanitized: no scripts, handlers or javascript: links", () => {
        const html = renderMarkdown(
            '<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[click](javascript:alert(3)) <a href="https://ok.example" onclick="x()">ok</a>',
        );
        const root = element(html);
        expect(root.querySelector("script")).toBeNull();
        const image = root.querySelector("img");
        expect(image).not.toBeNull();
        expect(image?.hasAttribute("onerror")).toBe(false);
        const links = Array.from(root.querySelectorAll("a"));
        expect(links.some((link) => (link.getAttribute("href") ?? "").startsWith("javascript"))).toBe(false);
        const ok = links.find((link) => link.textContent === "ok");
        expect(ok).not.toBeUndefined();
        expect(ok?.getAttribute("target")).toBe("_blank");
        expect(ok?.getAttribute("rel")).toBe("noopener noreferrer");
        expect(ok?.hasAttribute("onclick")).toBe(false);
    });

    test("export as a standalone HTML page with an escaped title", () => {
        const page = markdownToHtmlPage('Tom & "Jerry"', "# Hi");
        expect(page).toContain("<title>Tom &amp; &quot;Jerry&quot;</title>");
        expect(page).toContain("<h1>Hi</h1>");
        expect(htmlPage("t", "<p>x</p>")).toMatch(/^<!DOCTYPE html>/);
        expect(htmlToText("<h1>A</h1><p>b <em>c</em></p>")).toBe("A\nb c");
    });
});
