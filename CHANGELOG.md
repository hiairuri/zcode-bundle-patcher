# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-30

### Added

- 首版发布：针对 ZCode 3.17.1 CLI bundle（`zcode.cjs`）中破坏子代理派发的坏代码的字节级修复工具。
- 引擎 `patcher.mjs`（零依赖单文件）：`check` / `patch` / `restore` 三子命令；fail-closed 版本指纹门（sha256+size 双档注册表，未知构建一律拒改）；patch 前强制备份、三重校验失败自动回滚；restore 五步校验含目标路径规范化（无逃生口）与字节级复原；`--dry-run` 零写盘；`--force` 仅诊断永不放行。全程零网络访问。
- 版本注册表 `builds.json`：`zcode-cli-0.17.0-win-x64`（good-negative）/ `zcode-cli-0.17.1-win-x64`（target-ready）双档登记。
- 修复动作表 `actions.json`：0.17.1 五条目动作（含定位锚、补丁内容、逐条 verify 断言与证据留档）。
- 测试套 `test/run.mjs`（20 用例，含表损坏/备份失败/span 相交等 fail-closed 面与活体安全哨兵）与全链 harness `test/harness.mjs`（安装包 7z 提取 → 指纹门 → patch → 断言 → restore 字节级复原，可重复，输出计数化 JSON）。
- 公共交付面：README（中文为主 + 英文摘要）、LICENSE（MIT）、.gitignore。
