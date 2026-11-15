// daemon 版本单一来源：package.json version（tsup 构建时内联进 dist，运行时无需读盘）。
import daemonPackageJson from "../package.json";

export const DAEMON_VERSION: string = daemonPackageJson.version;
