#!/bin/sh
# aether-mock-cli codex 引擎 POSIX 薄包装：经 node 运行同目录 codex-server.mjs。
# 注意：git 检出不带执行位，测试/使用前需 chmod +x（对照 cli.sh 的既有约定）。
exec node "$(dirname "$0")/codex-server.mjs" "$@"
