#!/usr/bin/env node
/**
 * zcode-bundle-patcher 全链 harness（测试套 T4 全链用例的委托实现）
 *
 * 输入 = 安装包路径（默认取 %LOCALAPPDATA% 下 ZCode 桌面更新器 pending 位；可 --installer / 环境变量 ZBPATCH_INSTALLER 覆盖）。
 * 流程 = 7z 两步提取（$PLUGINSDIR/app-64.7z → resources/glm/zcode.cjs）→ sha256+size 门（== 395307ab…d36）
 *        → 副本 patch（引擎强制备份+manifest）→ 断言面 → restore → 字节级复原断言；
 *        阴性腿 = 好版（0.17.0）只读副本 no-op 断言；活体/安装包全程零写入（哨兵核对）。
 * 安装包缺席时可用 --sample / 环境变量 ZBPATCH_SAMPLE 直给已提取样本（仍过同一 sha256 门），mode 载入结果。
 * 输出 = 计数化 JSON（默认 %TEMP%/zcode-bundle-patcher-harness-result.json，--out 覆盖）；非全绿 exit 1，准备门失败 exit 2。
 *
 * 断言坐标语义（独立求值器）：span 相对断言按【位移后 payload 写入区域】求值——多 span 依次应用后，
 * 条目的 patch 产物区域 = [登记 span 起点 + 此前累积字节差, +replacement 长度)（insert 的 replacement =
 * payload+marker 注释 14B）；零位移（等长替换/单 span）时与登记坐标重合，语义不变。
 * 全局计数类断言与坐标无关。本求值器独立于引擎校验④，作为其第二实现对照。
 *
 * 纪律：活体与安装包只读（副本面施工）；临时工作区用后即弃；零网络；node ≥20；7z 仅全链提取需要。
 * 断言风格 = must() 抛错即红（与 test/run.mjs 同型；成功返回 detail 串）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.dirname(TEST_DIR);
const PATCHER = path.join(ENGINE_DIR, "patcher.mjs");
const ACTIONS_JSON = path.join(ENGINE_DIR, "actions.json");

const GOOD_SHA = "a055234a6ca3da0172616d3987cf3c617b6a26deb1332d69035300c2a0ae0de1";
const BAD_SHA = "395307aba9b59ba6a099f4941b073ec7a8b53fe4154e4e75af65b3703d2e6d36";
const GOOD_SIZE = 15243891;
const BAD_SIZE = 15405921;
const GOOD_ID = "zcode-cli-0.17.0-win-x64";
const BAD_ID = "zcode-cli-0.17.1-win-x64";
const MARKER_COMMENT = "/*zbpatch:v1*/";
const DELTA_PAYLOAD_BASIS = -557; // payload 口径基线：Σ(动作 payload 字节数 − 登记 span 字节数)，由动作表可复算（marker 附尾另计 14B/insert）
const MANIFEST_FIELDS = ["bundle_path", "sha256_orig", "size_orig", "backup_path", "patch_spans", "actions_applied", "sha256_patched", "size_patched", "tool_version", "created"];

const SEVENZIP = "C:/Program Files/7-Zip/7z.exe";
const DEF_INSTALLER = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "@zcodedesktop-updater", "pending", "ZCode-3.17.1-win-x64.exe");
const DEF_GOOD = "C:/Program Files/ZCode/resources/glm/zcode.cjs";
const DEF_OUT = path.join(os.tmpdir(), "zcode-bundle-patcher-harness-result.json");

/* ---------- 小工具 ---------- */
function sha256Hex(b) { return crypto.createHash("sha256").update(b).digest("hex"); }
function shaFile(p) { try { return sha256Hex(fs.readFileSync(p)); } catch (err) { return null; } }
function countAll(s, needle) { let n = 0, i = s.indexOf(needle); while (i !== -1) { n += 1; i = s.indexOf(needle, i + 1); } return n; }
function must(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- CLI ---------- */
function parseArgs(argv) {
  const o = { installer: process.env.ZBPATCH_INSTALLER || DEF_INSTALLER, good: process.env.ZBPATCH_GOOD || DEF_GOOD, sample: process.env.ZBPATCH_SAMPLE || "", out: DEF_OUT, sevenZip: process.env.ZBPATCH_SEVENZIP || SEVENZIP, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--installer") o.installer = argv[++i];
    else if (a === "--good") o.good = argv[++i];
    else if (a === "--sample") o.sample = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--7z") o.sevenZip = argv[++i];
    else if (a === "--keep") o.keep = true;
    else { console.error("未知参数: " + a); process.exit(2); }
  }
  return o;
}

/* ---------- 断言登记 ---------- */
const asserts = [];
function add(id, name, pass, detail) {
  asserts.push({ id, name, pass: !!pass, detail: String(detail || "") });
  console.log("[" + (pass ? "PASS" : "FAIL") + "] " + id + " " + name + (detail ? " -- " + detail : ""));
}
function check(id, name, fn) {
  try {
    const detail = fn() || "";
    add(id, name, true, detail);
  } catch (err) {
    add(id, name, false, String((err && err.message) || err).slice(0, 400));
  }
}

/* ---------- 主流程 ---------- */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = new Date().toISOString();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zbpatch-harness-"));
  const info = { started, mode: null, installer: opts.installer, good_src: opts.good, workspace: ws, extraction: {} };
  let liveSentinelStart = null;
  let installerSizeBefore = null;

  const finish = (exitCode, abortedReason) => {
    const passed = asserts.filter((a) => a.pass).length;
    const failed = asserts.length - passed;
    const repeatKey = (info.mode || "none") + "|" + asserts.map((a) => a.id + (a.pass ? "+" : "-")).join(",") + "|patched_sha=" + (info.patched_sha || "-") + "|delta=" + (info.delta_actual ?? "-");
    const out = {
      tool: "zcode-bundle-patcher full-chain harness",
      started, finished: new Date().toISOString(), aborted: abortedReason || null,
      info, assertions: asserts, summary: { total: asserts.length, passed, failed }, repeat_key: repeatKey,
    };
    try {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
      console.log("results=" + opts.out);
    } catch (err) {
      console.error("结果 JSON 写入失败: " + err.message);
    }
    if (!opts.keep) { try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (err) { /* 用后即弃，失败不掩盖结果 */ } }
    console.log("SUMMARY total=" + asserts.length + " passed=" + passed + " failed=" + failed + (abortedReason ? " ABORTED=" + abortedReason : ""));
    process.exit(exitCode);
  };
  const abort = (reason) => { console.error("ABORT: " + reason); finish(2, reason); };

  /* 准备门 1：阴性（活体好版只读拷贝，对拍通过才可用） */
  if (!fs.existsSync(opts.good)) abort("好版源缺席: " + opts.good);
  liveSentinelStart = shaFile(opts.good);
  if (liveSentinelStart !== GOOD_SHA) abort("好版源 sha256 对拍失败（期望 " + GOOD_SHA.slice(0, 8) + "…）: " + opts.good);
  const goodCopy = path.join(ws, "good.cjs");
  fs.copyFileSync(opts.good, goodCopy);
  const goodBuf = fs.readFileSync(goodCopy);
  if (goodBuf.length !== GOOD_SIZE || sha256Hex(goodBuf) !== GOOD_SHA) abort("好版副本对拍失败");

  /* 准备门 2：阳性（安装包 7z 两步提取；缺席回落既有样本，同门对拍） */
  let posSrc = null;
  if (fs.existsSync(opts.installer)) {
    info.mode = "installer-fullchain";
    installerSizeBefore = fs.statSync(opts.installer).size;
    info.extraction.installer_size = installerSizeBefore;
    const x1 = path.join(ws, "x1");
    const app7z = path.join(x1, "$PLUGINSDIR", "app-64.7z");
    let r = spawnSync(opts.sevenZip, ["x", "-y", "-bso0", "-bsp0", "-o" + x1, opts.installer, "$PLUGINSDIR/app-64.7z"], { maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
    if (r.status !== 0 || !fs.existsSync(app7z)) abort("7z 第一步（NSIS 外壳→app-64.7z）失败 exit=" + r.status + " " + String(r.stderr || "").slice(0, 300));
    info.extraction.app7z_size = fs.statSync(app7z).size;
    const x2 = path.join(ws, "x2");
    posSrc = path.join(x2, "resources", "glm", "zcode.cjs");
    r = spawnSync(opts.sevenZip, ["x", "-y", "-bso0", "-bsp0", "-o" + x2, app7z, "resources/glm/zcode.cjs"], { maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
    if (r.status !== 0 || !fs.existsSync(posSrc)) abort("7z 第二步（app-64.7z→zcode.cjs）失败 exit=" + r.status + " " + String(r.stderr || "").slice(0, 300));
  } else if (fs.existsSync(opts.sample)) {
    info.mode = "sample-reuse";
    info.extraction.fallback_sample = opts.sample;
    posSrc = opts.sample;
    console.log("[note] 安装包缺席，回落既有提取样本（同 sha256 门）: " + opts.sample);
  } else {
    abort("安装包缺席且未提供 --sample / ZBPATCH_SAMPLE（尝试的安装包路径: " + opts.installer + "）");
  }
  const posCopy = path.join(ws, "pos.cjs");
  fs.copyFileSync(posSrc, posCopy);
  const posBuf = fs.readFileSync(posCopy);
  if (posBuf.length !== BAD_SIZE || sha256Hex(posBuf) !== BAD_SHA) abort("阳性样本 sha256/size 对拍失败（期望 " + BAD_SHA.slice(0, 8) + "…/" + BAD_SIZE + "B）: " + posSrc);
  info.extraction.final_sha = BAD_SHA;

  /* 引擎 CLI 调用器 */
  function runCli(args, timeoutMs) {
    return spawnSync(process.execPath, [PATCHER].concat(args), { encoding: "utf8", timeout: timeoutMs || 300000, maxBuffer: 64 * 1024 * 1024 });
  }
  const outOf = (r) => String(r.stdout || "") + String(r.stderr || "");
  const verdictOf = (r) => { const m = String(r.stdout || "").match(/verdict=(\S+)/); return m ? m[1] : null; };
  const exitOf = (r) => (r.status === null ? "signal/" + r.signal : String(r.status));

  /* 动作表与位移后 payload 区域坐标（多 span 升序应用后的 patch 产物区域） */
  function loadTable() { return JSON.parse(fs.readFileSync(ACTIONS_JSON, "utf8")); }
  function shiftedCoords(table) {
    const coords = new Map();
    let shift = 0;
    const sorted = table.slice().sort((a, b) => (a.span[0] - b.span[0]) || (a.span[1] - b.span[1]));
    for (const e of sorted) {
      // 与引擎 _outSpan 同语义：本条目 payload 写入区域 = [登记起点+累积位移, +replacement 长度)
      const replLen = e.apply.kind === "insert" ? e.apply.payload.length + MARKER_COMMENT.length : e.apply.payload.length;
      coords.set(e.id, { start: e.span[0] + shift, end: e.span[0] + shift + replLen });
      shift += replLen - (e.span[1] - e.span[0]);
    }
    return coords;
  }

  /* ---------- 阴性腿 ---------- */
  check("H-N1", "check 好版副本 → already-good-negative + 指纹命中", () => {
    const r = runCli(["check", "--bundle", goodCopy]);
    must(r.status === 0, "exit=" + exitOf(r) + " " + outOf(r).slice(0, 200));
    must(verdictOf(r) === "already-good-negative", "verdict=" + verdictOf(r));
    must(String(r.stdout).includes("fingerprint=" + GOOD_ID), "fingerprint 未命中注册表");
    return "exit=0 verdict=already-good-negative";
  });

  check("H-N2", "patch 好版副本 → no-op 拒写、零字节变化、无备份落盘", () => {
    const bak = path.join(ws, "bak-neg");
    const before = shaFile(goodCopy);
    const r = runCli(["patch", "--bundle", goodCopy, "--backup-dir", bak]);
    must(r.status === 0, "exit=" + exitOf(r) + " " + outOf(r).slice(0, 200));
    must(verdictOf(r) === "already-good-negative", "verdict=" + verdictOf(r));
    must(shaFile(goodCopy) === before, "好版拷贝字节被改（防误伤失守）");
    must(!fs.existsSync(bak), "no-op 却创建了备份目录");
    return "拒写 + 零字节变化 + 无备份目录";
  });

  /* ---------- 阳性腿 ---------- */
  check("H-P1", "check 真 0.17.1 副本 → target-ready + 指纹命中", () => {
    const r = runCli(["check", "--bundle", posCopy]);
    must(r.status === 0, "exit=" + exitOf(r) + " " + outOf(r).slice(0, 200));
    must(verdictOf(r) === "target-ready", "verdict=" + verdictOf(r));
    must(String(r.stdout).includes("fingerprint=" + BAD_ID), "fingerprint 未命中注册表");
    return "exit=0 verdict=target-ready";
  });

  let manifest = null;
  let patchedBuf = null;
  check("H-P2", "patch 真 0.17.1 副本 → exit 0 / applied=5 / manifest 字段全集 / span 原字节全录", () => {
    const bak = path.join(ws, "bak-pos");
    const r = runCli(["patch", "--bundle", posCopy, "--backup-dir", bak]);
    must(r.status === 0 && verdictOf(r) === "patched", "exit=" + exitOf(r) + " verdict=" + verdictOf(r) + " " + outOf(r).slice(0, 300));
    const applied = Number((String(r.stdout).match(/applied=(\d+)/) || [])[1]);
    must(applied === 5, "applied=" + applied + "（须 5）");
    const mPath = path.join(bak, "manifest.json");
    must(fs.existsSync(mPath), "manifest 缺失");
    manifest = JSON.parse(fs.readFileSync(mPath, "utf8"));
    const missing = MANIFEST_FIELDS.filter((k) => !(k in manifest));
    must(missing.length === 0, "manifest 缺字段: " + missing.join("|"));
    patchedBuf = fs.readFileSync(posCopy);
    must(manifest.size_patched === patchedBuf.length && manifest.sha256_patched === sha256Hex(patchedBuf), "manifest 指纹与产物不符");
    must(manifest.sha256_orig === BAD_SHA && manifest.size_orig === BAD_SIZE, "manifest 原指纹不符");
    const baks = fs.readdirSync(bak).filter((f) => f.startsWith("bundle-"));
    must(baks.length === 1 && sha256Hex(fs.readFileSync(path.join(bak, baks[0]))) === BAD_SHA, "备份缺失或指纹不符");
    must(Array.isArray(manifest.patch_spans) && manifest.patch_spans.length === 5, "patch_spans 须 5 条");
    const origStr = posBuf.toString("latin1");
    for (const rec of manifest.patch_spans) {
      must(rec.original === origStr.slice(rec.start, rec.end), "span " + rec.id + " 原字节未全录");
    }
    must(manifest.actions_applied.join(",") === "p4,p1,p2,p3-1,p3-2", "actions_applied 顺序非 span 升序: " + manifest.actions_applied.join(","));
    info.patched_sha = manifest.sha256_patched;
    return "applied=5 [p4,p1,p2,p3-1,p3-2] manifest/备份/原字节全录齐全";
  });

  check("H-P3", "patch 产物独立 node --check 过（引擎校验①之外的第二实现）", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const r = spawnSync(process.execPath, ["--check", posCopy], { timeout: 120000 });
    must(r.status === 0, "exit=" + exitOf(r) + " " + String(r.stderr || "").slice(0, 200));
    return "语法校验 exit=0";
  });

  check("H-P4", "五锚计数归零 + GXs 函数头保留", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const sOut = patchedBuf.toString("latin1");
    const table = loadTable();
    const bad = table.filter((e) => countAll(sOut, e.anchor.literal) !== 0).map((e) => e.id);
    must(bad.length === 0, "残留锚=" + (bad.join("|") || "无") );
    must(countAll(sOut, "function GXs(e){") === 1, "GXs 函数头计数异常");
    return "5/5 锚归零 + GXs 头=1";
  });

  check("H-P5", "verify[] 全量独立求值（位移后 payload 区域坐标，第二实现对照）全过", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const table = loadTable();
    const sOut = patchedBuf.toString("latin1");
    const coords = shiftedCoords(table);
    let items = 0, claims = 0;
    const failures = [];
    for (const e of table) {
      const c = coords.get(e.id);
      for (const itemRaw of e.verify) {
        items += 1;
        for (const rawPart of String(itemRaw).split(" AND ")) {
          claims += 1;
          const part = rawPart.trim();
          let ok = false;
          let m;
          if ((m = part.match(/bytes at \[[^\],]+, ?[a-z_.]+ ?\+ ?(\d+)\) ?== ?'([^']*)'/))) {
            const n = Number(m[1]);
            ok = m[2].length === n && sOut.slice(c.start, c.start + n) === m[2];
          } else if ((m = part.match(/patched span first byte == '(.)' and last byte == '(.)'/))) {
            ok = sOut[c.start] === m[1] && sOut[c.end - 1] === m[2];
          } else if ((m = part.match(/byte at insert_point-1 == '(.)'/))) {
            ok = c.start > 0 && sOut[c.start - 1] === m[1];
          } else if ((m = part.match(/count of '([^']*)'.*?== ?(\d+)/))) {
            ok = countAll(sOut, m[1]) === Number(m[2]);
          } else if ((m = part.match(/count of (?:the )?[a-z0-9' -]*anchor literal.*?== ?(\d+)/))) {
            ok = countAll(sOut, e.anchor.literal) === Number(m[1]);
          } else {
            failures.push({ id: e.id, clause: "UNPARSED:" + part });
            continue;
          }
          if (!ok) failures.push({ id: e.id, clause: part.slice(0, 120) });
        }
      }
    }
    must(failures.length === 0, "verify 项=" + items + " 子句=" + claims + " 失败=" + JSON.stringify(failures).slice(0, 300));
    return "verify 项=" + items + " 子句=" + claims + " 全过（位移后 payload 区域坐标）";
  });

  check("H-P6", "Δ 基线对照：payload 口径 == -557（表内可复算基线）；实际 == -543 = -557 + 14×insert（marker 附尾）", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const table = loadTable();
    const basis = table.reduce((n, e) => n + (e.apply.payload.length - (e.span[1] - e.span[0])), 0);
    const inserts = table.filter((e) => e.apply.kind === "insert").length;
    const actual = patchedBuf.length - BAD_SIZE;
    info.delta_actual = actual;
    must(basis === DELTA_PAYLOAD_BASIS, "payload 基线=" + basis + "（表内口径须 -557）");
    must(actual === basis + MARKER_COMMENT.length * inserts, "实际 Δ=" + actual + " ≠ 基线+marker（" + basis + "+" + MARKER_COMMENT.length * inserts + "）");
    return "basis=" + basis + " actual=" + actual + "（marker +" + MARKER_COMMENT.length * inserts + "B 相符）";
  });

  check("H-P7", "T4-ARRAY 附锁：patch 产物 $Tn RHS 数组结构合法 + 元素恰 [context_prefix, skills_listing]", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const table = loadTable();
    const sOut = patchedBuf.toString("latin1");
    const coords = shiftedCoords(table);
    const p2 = table.find((x) => x.id === "p2");
    must(p2, "动作表无 p2");
    const c = coords.get("p2");
    const bytes = sOut.slice(c.start, c.end);
    must(bytes === p2.apply.payload, "span 字节不符: " + JSON.stringify(bytes.slice(0, 60)));
    must(bytes[0] === "[" && bytes[bytes.length - 1] === "]", "首末字节非 [ / ]");
    let arr;
    try { arr = JSON.parse(bytes); } catch (err) { throw new Error("JSON 解析失败: " + err.message); }
    must(Array.isArray(arr) && arr.length === 2 && arr[0] === "context_prefix" && arr[1] === "skills_listing", "元素异常: " + JSON.stringify(arr));
    return "数组合法且恰二元素（@" + c.start + "，" + bytes.length + "B）";
  });

  check("H-P8", "marker 计数 == 1（仅 p4 insert 附 marker 注释）", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const n = countAll(patchedBuf.toString("latin1"), "zbpatch:v1");
    must(n === 1, "marker=" + n);
    return "marker=1";
  });

  check("H-P9", "幂等：marker 命中再 patch → already-patched no-op 零写盘", () => {
    must(patchedBuf, "前置 H-P2 未过");
    const before = shaFile(posCopy);
    const r = runCli(["patch", "--bundle", posCopy, "--backup-dir", path.join(ws, "bak-re")]);
    must(r.status === 0, "exit=" + exitOf(r) + " " + outOf(r).slice(0, 200));
    must(verdictOf(r) === "already-patched", "verdict=" + verdictOf(r));
    must(shaFile(posCopy) === before, "幂等 no-op 却写盘");
    return "exit=0 already-patched 零字节变化";
  });

  check("H-P10", "restore 五步 → verdict=restored + sha256==原件（字节级复原）+ sha256_patched 输出性对照", () => {
    must(manifest, "前置 H-P2 未过");
    const r = runCli(["restore", "--bundle", posCopy, "--backup-dir", path.join(ws, "bak-pos")]);
    must(r.status === 0, "exit=" + exitOf(r) + " " + outOf(r).slice(0, 200));
    must(/^verdict=restored/m.test(String(r.stdout)), "verdict=" + verdictOf(r) + "（须 restored）");
    const restored = fs.readFileSync(posCopy);
    must(sha256Hex(restored) === BAD_SHA && restored.length === BAD_SIZE, "字节级复原失守 sha=" + sha256Hex(restored).slice(0, 8));
    must(String(r.stdout).includes("sha256_patched=" + manifest.sha256_patched), "缺输出性对照（sha256_patched 提示语）");
    return "字节级复原实锤（sha256==" + BAD_SHA.slice(0, 8) + "…，size==" + BAD_SIZE + "）";
  });

  check("H-P11", "全程副本面：活体哨兵首尾一致 + 安装包零触 + 引擎目录无 backups/", () => {
    const liveNow = shaFile(opts.good);
    must(liveNow === liveSentinelStart && liveNow === GOOD_SHA, "活体哨兵失守: " + String(liveNow).slice(0, 8));
    if (info.mode === "installer-fullchain") {
      must(fs.existsSync(opts.installer) && fs.statSync(opts.installer).size === installerSizeBefore, "安装包被触碰");
    }
    must(!fs.existsSync(path.join(ENGINE_DIR, "backups")), "引擎目录出现 backups/");
    return "活体 sha 首尾一致" + (info.mode === "installer-fullchain" ? " + 安装包 size 不变" : " + 样本模式") + " + 引擎目录零备份";
  });

  const passed = asserts.filter((a) => a.pass).length;
  const failed = asserts.length - passed;
  finish(failed > 0 ? 1 : 0, null);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
