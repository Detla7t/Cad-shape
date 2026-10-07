// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { NativeFunction } from "../lang/values";

/** Registers one `@name` built-in. */
export type BuiltinRegistry = (name: string, impl: NativeFunction["impl"]) => void;
