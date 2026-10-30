# zcode-bundle-patcher

针对 ZCode 桌面版 **3.17.1**（CLI bundle `zcode.cjs`）中导致**子代理派发（subagent dispatch）失败**的坏代码，提供数据驱动的字节级修复与一键恢复。

- 纯命令行工具，零 npm 依赖，单个引擎文件 + 两张 JSON 数据表，全程**零网络访问**。
- 修复动作以数据表登记（锚点 + 补丁内容 + 逐条校验），引擎只执行表内登记的动作，表外一个字节都不碰。
- 内置 fail-closed 版本指纹门：只对已登记且指纹精确吻合的构建动手，其他一切构建一律拒改。

> ⚠️ **免责声明**：本工具直接修改厂商发布的程序文件，属非官方改动，风险自担。请务必先读「风险与适用面」；官方修复发布后，请用本工具恢复原文件再正常升级。

---

## 这是什么

ZCode 3.17.1 的 CLI bundle（`resources/glm/zcode.cjs`）中有一处回归：子代理派发请求会被坏代码拦截，导致无法派发子代理。本工具按预登记的字节级补丁动作，把该坏代码中和为 0.17.0 的等价行为：

| 动作 | 效果（简述） |
|---|---|
| p1 | 中和工具结果折叠开关（恒关闭） |
| p2 | 系统提醒类型白名单恢复为 0.17.0 的双元素形态 |
| p3 | 两条提醒通道参数恢复为 0.17.0 形态 |
| p4 | 会话特性头构建函数恒返回空（不再发送该头） |

文件结构：

```
patcher.mjs      引擎（零依赖单文件）
builds.json      版本注册表（sha256+size 双指纹）
actions.json     修复动作表（按构建登记）
test/run.mjs     测试套（20 用例）
test/harness.mjs 全链 harness（安装包提取 → 修复 → 断言 → 恢复）
```

## 风险与适用面

- **适用面**：仅限已登记构建（见 `builds.json`）。当前登记覆盖 **Windows x64** 的两个构建：
  - `zcode-cli-0.17.0-win-x64`（好版，阴性对照，工具对其恒 no-op）；
  - `zcode-cli-0.17.1-win-x64`（坏版，修复目标）。
- **风险**：
  - 修改后你的安装将偏离官方发布形态；后续官方升级/重装会覆盖补丁（属正常，升级后重新 `check` 即可）。
  - 补丁前引擎会做强制备份（见「备份与恢复」），修复过程中任何一道校验失败都会**自动回滚**到原始字节。
  - 请勿手工编辑被补丁的文件后再 `restore`——`restore` 按备份整文件回写，会覆盖你期间的任何手工改动。
- **不适用**：其他版本/平台/渠道的构建。工具对未知构建一律 `fingerprint-unknown` 拒改（见「版本门说明」），这是特性不是故障。

## 前置条件

1. **patch / restore 前关闭 ZCode**（正在运行的进程占用 `zcode.cjs`）。
2. **Node.js ≥ 20**（命令行 `node` 可用）。
3. 仅运行全链测试 harness（`test/harness.mjs`）需要 **7-Zip**（默认安装位 `C:\Program Files\7-Zip\7z.exe`）；日常 `check` / `patch` / `restore` 不需要。

## 快速开始

典型 bundle 路径（默认安装）：`C:\Program Files\ZCode\resources\glm\zcode.cjs`。以下用 `%BUNDLE%` 指代。

```bat
:: 1) 体检：看当前文件是什么状态（不写任何文件）
node patcher.mjs check --bundle "%BUNDLE%"

:: 2) 修复（自动备份 + 三重校验 + manifest 落盘）
node patcher.mjs patch --bundle "%BUNDLE%"

:: 3) 一键恢复到原始字节
node patcher.mjs restore --bundle "%BUNDLE%" --backup-dir backups
```

`check` 输出第一行 `verdict=` 就是当前状态：`already-good-negative`（好版，无需处理）/ `target-ready`（坏版，可修复）/ `already-patched`（已修复过）/ `target-pending`（已登记但修复动作未登记）/ `fingerprint-unknown`（未登记的构建，拒改）/ `anchors-lost`（不是 ZCode bundle）。

## 子命令与旗标

| 子命令 | 说明 |
|---|---|
| `check --bundle <p>` | 全程只读体检：输出 verdict、指纹、context 锚计数表。 |
| `patch --bundle <p> [--dry-run] [--backup-dir <d>] [--force]` | 指纹门 → 动作表校验 → **强制备份** → 按表应用 → 三重校验 → manifest 落盘。 |
| `restore --bundle <p> --backup-dir <d>` | 五步校验后按备份整文件回写（见「备份与恢复」）。 |

| 旗标 | 说明 |
|---|---|
| `--bundle <p>` | 目标文件路径（显式传参，工具不预知你的安装位）。 |
| `--dry-run` | 完整走版本门与定位管线，打印将改动的区间与上下文摘录，**零写盘**。 |
| `--backup-dir <d>` | 备份与 manifest 目录，缺省为工具目录下的 `backups/`。 |
| `--force` | **仅修表辅助诊断**：动作表锚计数不符时输出逐锚 expect/actual 诊断并退出（码 6），**任何场景都不会因此放行 patch**。社区用户没有需要用它的情况。 |

## 版本门说明（为什么我的版本被拒绝）

引擎用 **sha256 + 文件大小双指纹** 对照 `builds.json` 注册表，只有**精确吻合的已登记构建**才可能被 patch：

- 未登记的构建：context 锚命中 ≥8/11 → `fingerprint-unknown`（疑似 ZCode 但未登记）；<8 → `anchors-lost`（不是 ZCode bundle）。
- **`fingerprint-unknown` 属正常非故障**：说明你拿到了一个尚未登记的新构建，工具按设计拒绝动手。
- 新构建登记流程（onboarding）：
  1. 运行 `node patcher.mjs check --bundle <你的 zcode.cjs>`；
  2. 把输出的 `fingerprint=` 行（含锚计数与 size）提交 issue；
  3. 维护者做差分核对后登记 `builds.json` 条目并（如适用）登记修复动作。
- 版本号字符串不参与判别（app 版本与 CLI bundle 版本可能错位），一切以指纹为准。

## 备份与恢复

- **强制备份，无豁免**：patch 前先把原始文件完整拷贝到备份目录（文件名含原 sha256 前 8 位 + 时间戳），备份失败立即中止、不写目标。
- manifest（`manifest.json`）记录：原/补丁后指纹与大小、每个动作的区间与**原始字节全录**、应用的动作列表、工具版本与时间。
- **一键恢复**：`node patcher.mjs restore --bundle <p> --backup-dir <d>`，五步校验：
  1. manifest 存在且合法；
  2. 备份文件 sha256 与 manifest 记录一致；
  3. **目标路径校验**（见下节），不符即拒，无逃生口；
  4. 目标已是原始字节 → `already-restored` no-op；
  5. 整文件回写，回写后再验 sha256，并输出补丁后指纹（`sha256_patched`/`size_patched`）作对照提示——如与你记忆不符，请核查期间文件是否被外部改动过。
- **备份目录语义：只增不清理。** 工具永不删除备份；磁盘紧张时你可以自行归档旧备份（保留最近一份即可恢复当前补丁）。

### restore 路径规范化规则

`restore` 会把 `--bundle` 传入路径与 manifest 里记录的 `bundle_path` 做**规范化比较**（realpath 解析 + Windows 大小写不敏感 + 正反斜杠归一）后再动手：

- 比较不符 → 拒绝执行（退出码 4）。宁可误拒也不误写：这是防止把 0.17.1 的备份覆写到好版文件上的硬闸。
- **移动过文件**的场景：把文件移回原路径再 restore，或手工把备份文件（`bundle-XXXXXXXX-*.cjs`）复制回使用位——工具不支持对已移动目标直接 restore。

## 退出码表

| 码 | 含义 |
|---|---|
| 0 | 成功 / no-op（含 already-good-negative / already-patched / already-restored） |
| 1 | 通用未分类错误（用法错误、文件不可读等） |
| 2 | 未知构建 `fingerprint-unknown`（拒改；按 onboarding 登记） |
| 3 | 锚失守 / 计数不符 / 定位歧义（含 `anchors-lost`） |
| 4 | IO / 表损坏 / span 相交 / 备份失败 / 校验失败（自动回滚）/ restore 目标不符 |
| 5 | 动作表未登记 `target-pending`（构建已登记但修复动作未登记） |
| 6 | 表 bug 诊断（`--force` 专用；诊断后仍不 patch） |

## 零网络声明

引擎不 import 任何网络模块、不含任何网络调用用法；唯一的子进程用法是调用本机 `node --check` 做语法校验。测试套内有机械断言持续锁死这一不变量。

## 平台覆盖声明

当前仅登记 **Windows x64** 双档构建。macOS/Linux 或其他渠道的构建未登记、一律拒改；需要覆盖请按上文 onboarding 流程提交指纹。`fingerprint-unknown` 属正常非故障。

## 测试

```bat
node test\run.mjs          :: 20 用例（含条件激活的全链用例 T4）
node test\harness.mjs      :: 全链：安装包提取 → 指纹门 → patch → 断言 → restore 字节级复原（需 7-Zip）
```

两者均输出计数化结果；harness 默认走安装包全链提取，也可用 `--sample` 直给已提取样本。

> 说明：阳性样本用例在本机未提供 0.17.1 样本时会自动 SKIP（不计入失败，非故障）；将环境变量 `ZBPATCH_POSITIVE`（run.mjs）或 `ZBPATCH_SAMPLE`（harness）指向已提取的 0.17.1 bundle 副本即可激活全表。

## License

[MIT](LICENSE)

---

## English Summary

**zcode-bundle-patcher** is a data-driven CLI tool that repairs the broken code in the ZCode 3.17.1 CLI bundle (`zcode.cjs`) which breaks subagent dispatch, restoring the 0.17.0-equivalent behavior via registered byte-level patch actions.

- **Usage**: `node patcher.mjs check|patch|restore --bundle <path/to/zcode.cjs>` (plus `--dry-run`, `--backup-dir`, `--force` — diagnostics only, never enables patching). Close ZCode first; Node.js ≥ 20 required. Zero network access.
- **Safety**: fail-closed version gate (exact sha256+size fingerprint registry — unregistered builds are always refused; `fingerprint-unknown` is normal, not an error), mandatory backup before patching, triple verification with automatic rollback, one-command restore (`restore`) with byte-identical results. Backup dirs are append-only.
- **Scope**: currently registered builds cover **Windows x64 only** (0.17.0 negative / 0.17.1 target). Other platforms/versions are refused by design; see the onboarding flow above to register new builds.
- **Exit codes**: 0 ok/no-op · 1 generic · 2 fingerprint-unknown · 3 anchors lost/mismatch · 4 IO/corrupt table/failed verification (rolled back) · 5 actions not registered · 6 table-bug diagnostics (`--force`).

This tool modifies vendor-shipped files and is an unofficial patch — use at your own risk, and restore the original file before official upgrades.
