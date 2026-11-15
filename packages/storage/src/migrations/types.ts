import type { DatabaseSync } from "node:sqlite";

/** 手写递增迁移（Orca 式迁移链，SYSTEM_DESIGN §4.1）。 */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}
