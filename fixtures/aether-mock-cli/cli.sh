#!/bin/sh
# aether-mock-cli POSIX 薄包装：经 node 运行同目录 cli.mjs。
# 注意：git 检出不带执行位，测试/使用前需 chmod +x（见 packages/adapters/claude/tests/mock-cli*.test.ts）。
exec node "$(dirname "$0")/cli.mjs" "$@"
