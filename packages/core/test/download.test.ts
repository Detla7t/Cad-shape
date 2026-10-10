// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { browserDownload, download, setDownloadDelivery } from "../src";

describe("download function", () => {
    let originalCreateObjectURL: typeof URL.createObjectURL;
    let originalRevokeObjectURL: typeof URL.revokeObjectURL;
    let originalCreateElement: typeof document.createElement;
    let createdObjectUrls: string[];
    let revokedObjectUrls: string[];
    let clickCalled: boolean;
    let anchorHref: string;
    let anchorDownload: string;
    let anchorVisibility: string;

    beforeEach(() => {
        originalCreateObjectURL = URL.createObjectURL;
        originalRevokeObjectURL = URL.revokeObjectURL;
        originalCreateElement = document.createElement;

        createdObjectUrls = [];
        revokedObjectUrls = [];
        clickCalled = false;
        anchorHref = "";
        anchorDownload = "";
        anchorVisibility = "";

        URL.createObjectURL = (_blob: Blob) => {
            const url = `blob:mock-${createdObjectUrls.length}`;
            createdObjectUrls.push(url);
            return url;
        };

        URL.revokeObjectURL = (url: string) => {
            revokedObjectUrls.push(url);
        };

        document.createElement = ((tagName: string, _options?: ElementCreationOptions) => {
            const el = originalCreateElement.call(document, tagName, _options);
            if (tagName === "a") {
                const htmlEl = el as HTMLElement & { href: string; download: string };
                const originalClick = el.click;
                Object.defineProperty(htmlEl, "href", {
                    set(value: string) {
                        anchorHref = value;
                    },
                    get() {
                        return anchorHref;
                    },
                });
                Object.defineProperty(htmlEl, "download", {
                    set(value: string) {
                        anchorDownload = value;
                    },
                    get() {
                        return anchorDownload;
                    },
                });
                Object.defineProperty(htmlEl.style, "visibility", {
                    set(value: string) {
                        anchorVisibility = value;
                    },
                    get() {
                        return anchorVisibility;
                    },
                });
                el.click = () => {
                    clickCalled = true;
                    originalClick.call(el);
                };
            }
            return el;
        }) as typeof document.createElement;
    });

    afterEach(() => {
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
        document.createElement = originalCreateElement;
    });

    test("should create a Blob, object URL, trigger click, and revoke URL", () => {
        download(["test content"], "test-file.txt");

        expect(createdObjectUrls.length).toBe(1);
        expect(revokedObjectUrls.length).toBe(1);
        expect(clickCalled).toBe(true);
    });

    test("should set download attribute with given filename", () => {
        download(["hello"], "export.step");
        expect(anchorDownload).toBe("export.step");
    });

    test("should set anchor href to created object URL", () => {
        download(["data"], "file.json");
        expect(anchorHref).toBe("blob:mock-0");
    });

    test("should set anchor visibility to hidden", () => {
        download(["data"], "test.txt");
        expect(anchorVisibility).toBe("hidden");
    });

    test("should revoke object URL even if click throws", () => {
        // Override click to throw for this test
        document.createElement = ((tagName: string, _options?: ElementCreationOptions) => {
            const el = originalCreateElement.call(document, tagName, _options);
            if (tagName === "a") {
                const htmlEl = el as HTMLElement & { href: string; download: string };
                Object.defineProperty(htmlEl.style, "visibility", {
                    set() {},
                    get() {
                        return "hidden";
                    },
                });
                el.click = () => {
                    throw new Error("click failed");
                };
                Object.defineProperty(htmlEl, "href", {
                    set() {},
                    get() {
                        return "";
                    },
                });
                Object.defineProperty(htmlEl, "download", {
                    set() {},
                    get() {
                        return "";
                    },
                });
            }
            return el;
        }) as typeof document.createElement;

        expect(() => download(["data"], "file.txt")).toThrow("click failed");
        // revokeObjectURL should still be called via finally block
        expect(revokedObjectUrls.length).toBe(1);
    });

    test("should handle empty data array", () => {
        download([], "empty.txt");
        expect(clickCalled).toBe(true);
        expect(createdObjectUrls.length).toBe(1);
    });

    test("should handle multiple BlobParts", () => {
        download(["part1", "part2", "part3"], "multi.txt");
        expect(createdObjectUrls.length).toBe(1);
        expect(clickCalled).toBe(true);
    });

    test("should handle special characters in filename", () => {
        download(["data"], "文件名-测试.step");
        expect(clickCalled).toBe(true);
        expect(revokedObjectUrls.length).toBe(1);
    });

    test("should create Blob from string data", () => {
        const jsonData = JSON.stringify({ key: "value" });
        download([jsonData], "data.json");
        expect(createdObjectUrls.length).toBe(1);
        expect(anchorDownload).toBe("data.json");
    });

    describe("delivery", () => {
        afterEach(() => setDownloadDelivery(undefined));

        test("a delivery that declines keeps the browser download, synchronously", () => {
            const seen: string[] = [];
            setDownloadDelivery((file) => {
                seen.push(file.name);
                return false;
            });
            download(["data"], "part.step");
            expect(seen).toEqual(["part.step"]);
            expect(clickCalled).toBe(true);
        });

        test("a delivery that takes the file replaces the browser download", async () => {
            let received: Blob | undefined;
            setDownloadDelivery(async (file) => {
                received = file.blob;
                return true;
            });
            download(["abc"], "part.step");
            await Promise.resolve();
            await Promise.resolve();
            expect(received).not.toBeUndefined();
            expect(await received!.text()).toBe("abc");
            expect(clickCalled).toBe(false);
            expect(createdObjectUrls).toEqual([]);
        });

        test("an async decline or a failure falls back to the browser download", async () => {
            setDownloadDelivery(() => Promise.resolve(false));
            download(["data"], "a.step");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(clickCalled).toBe(true);
            expect(anchorDownload).toBe("a.step");

            clickCalled = false;
            setDownloadDelivery(() => Promise.reject(new Error("bridge gone")));
            download(["data"], "b.step");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(clickCalled).toBe(true);
            expect(anchorDownload).toBe("b.step");

            clickCalled = false;
            setDownloadDelivery(() => {
                throw new Error("sync failure");
            });
            download(["data"], "c.step");
            expect(clickCalled).toBe(true);
            expect(anchorDownload).toBe("c.step");
        });

        test("browserDownload is the plain download", () => {
            browserDownload(new Blob(["x"]), "plain.txt");
            expect(clickCalled).toBe(true);
            expect(anchorDownload).toBe("plain.txt");
            expect(revokedObjectUrls.length).toBe(1);
        });
    });
});
