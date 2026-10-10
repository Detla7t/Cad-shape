// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerDataTableProvider } from "@chili3d/core";
import { DATA_SOURCE_TABLES } from "./provider";
import { registerDataFunctions } from "./resolver";
import "./commands";
import "./project";
import "./ui/dataSourceElement";
import "./database/databaseElement";

export * from "./database/databaseElement";
export * from "./database/databaseNode";
export * from "./database/sqlite";
export * from "./dataSourceNode";
export * from "./dependencies";
export * from "./load";
export * from "./model/cells";
export * from "./model/definition";
export * from "./model/snapshot";
export * from "./project";
export * from "./provider";
export * from "./readers/csv";
export * from "./readers/json";
export * from "./readers/spreadsheet";
export * from "./readers/sqlite";
export * from "./refresh";
export * from "./remote/http";
export * from "./remote/request";
export * from "./remote/sheets";
export * from "./remote/sqlHttp";
export * from "./resolver";
export * from "./secrets";
export * from "./ui/dataSourceElement";
export * from "./ui/dataSourceView";
export * from "./variables";

// Importing the package is enabling it: Data Source nodes become data tables for `findDataTable`,
// and `data` / `lookup` / `count` / `sum` join every expression.
registerDataTableProvider(DATA_SOURCE_TABLES);
registerDataFunctions();
