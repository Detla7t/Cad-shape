// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ReactNode } from "react";
import "./globals.css";

// Plain data (not annotated with Next's types, which `npm run typecheck` keeps out of its program).
export const metadata = {
    title: "Chili3D",
    description:
        "A 3D CAD application that runs directly in your browser for online model design and editing。一款直接在浏览器中运行的3D CAD应用程序，实现在线模型设计与编辑",
    keywords: [
        "Web CAD",
        "WebAssembly",
        "WASM",
        "Three.js",
        "OCCT",
        "Opencascade",
        "3D CAD",
        "在线 CAD",
        "在线建模",
    ],
    authors: [{ name: "仙阁" }],
    icons: { icon: "favicon.svg" },
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                {children}
            </body>
        </html>
    );
}
