#!/usr/bin/env node
/**
 * zcode-bundle-patcher 引擎（零依赖单文件；draft v0.5 §3/§4/§5 权威，impl-plan v2 §1=M1 施工面）
 *
 * 子命令：check / patch / restore；旗标：--bundle <p> / --dry-run / --backup-dir <d> / --force
 * 退出码（draft §3.4）：
 *   0 成功/no-op（含 already-good-negative / already-patched / already-restored）
 *   1 通用未分类错误（用法错误、bundle 不可读等）
 *   2 未知构建 fingerprint-unknown（context 锚 >=8/11）
 *   3 锚失守/计数不符/定位歧义/span 不一致（anchors-lost 亦此）
 *   4 IO/表损坏或 schema 失败/span 相交/备份失败/校验失败/restore 目标不符
 *   5 动作表未登记 target-pending（在册构建且条目空，含表缺席=按空表）
 *   6 表 bug 诊断（--force 专用，永不放行 patch）
 *
 * 表解析基准 = 本文件同目录（import.meta.url 解析 builds.json/actions.json）；
 * CWD 与 --bundle 目录均不作基准（F-7/N1 置换机制前提：测试把本文件拷入临时目录再置表）。
 *
 * boundary_spec 双形态（actions.json locate.boundary_spec）：
 * A. 机器对象形态（推荐；解析后 span 必须与登记 span 一致，不符 exit 3=N2）：
 *   {"type":"anchor"}                                          span = 锚全串
 *   {"type":"anchor_suffix","suffix":"Slo"}                    span = 锚 + 尾随字面（先断言尾随字节确为该字面）
 *   {"type":"array_rhs","open_back":18,"close_literal":"x\"]"} span = [锚前 open_back 处 '[' , close_literal 首现之后）
 *                                                              内建首 '['/末 ']' 字节断言（F-2）
 *   {"type":"body_start","prefix":"function GXs(e){"}          断言锚起 prefix 字节后，插入点 = 锚起点 + prefix 长度（零长 span）
 *   {"type":"function_body","head_len":<n>,"mode":"body_start"|"body"}
 *                                                              head = 锚前 n 字节（须含 '{'）；字符级状态机（字符串/模板/正则/注释）
 *                                                              括号平衡扫描函数体；body_start=体首零长 span，body=体内部 [open+1, close)
 * B. 散文形态（字符串；首版 actions.json 的登记形态）：字符串=审计文档，运行期 span=登记 span；
 *   fail-closed 结构断言替代 N2 等值：replace 须锚整段落在 span 内；insert 插入点须严格落在锚内部
 *   （锚尾/锚外=语法错风险，F-3）；锚计数>1 时散文形态歧义=exit 3 拒改。
 * verify[] 校验④：引擎逐条目求值表内机器断言（span_post / count of 'x' / anchor literal 计数 /
 *   span_struct_post / boundary_post 文法）；存在不可解析子句=fail-closed exit 4（不静默跳过）。
 *
 * 零网络硬不变量：不 import 任何网络模块、无网络用法 token；child_process 唯一合法用法 =
 * 以 process.execPath 起子进程做 --check 语法检查（T9 机械断言钉死：调用点全文件唯一）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_VERSION = "0.1.0";
const MARKER = "zbpatch:v1";
const MARKER_COMMENT = "/*" + MARKER + "*/";
const THRESHOLD = 8; // context 锚阈值：>=8/11 → fingerprint-unknown

// draft §3.1 context 锚清单（判别力=0，双版同计数；阈值判别逐行机械对表）
const CONTEXT_ANCHORS = [
  { literal: "X-ZCode-Authorization", expect: 1 },
  { literal: "model.client_signing", expect: 2 },
  { literal: "ClientRequestSigningV4Manager", expect: 1 },
  { literal: "OfficialRequestSecurity", expect: 1 },
  { literal: "ModelRequestSecurityState", expect: 1 },
  { literal: "protectTransport", expect: 2 },
  { literal: "signingManager", expect: 3 },
  { literal: "api.chatglm.site", expect: 2 },
  { literal: "zcode.chatglm.site", expect: 4 },
  { literal: "/api/v1/ultra", expect: 2 },
  { literal: "/api/v1/ultra-zai", expect: 1 },
];

const EXIT = { OK: 0, GENERIC: 1, UNKNOWN: 2, ANCHOR: 3, IO: 4, PENDING: 5, TABLEBUG: 6 };
const BUILD_VERDICTS = ["good-negative", "target-ready", "target-pending"];
const ANCHOR_ROLES = ["discriminate", "context", "locate"];

class Exit extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
function bail(code, msg) {
  throw new Exit(code, msg);
}

/* ---------- 基础工具 ---------- */

function latin(buf) {
  return buf.toString("latin1");
}
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function countOccurrences(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}
function allOccurrences(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}
function excerpt(s, start, end) {
  const a = Math.max(0, start - 24);
  const b = Math.min(s.length, end + 24);
  return s.slice(a, b).replace(/[\r\n\t]/g, " ");
}

/* ---------- 表加载与 schema 校验（fail-closed：损坏/缺席分叉=F-8） ---------- */

function loadJsonTable(p, label) {
  if (!fs.existsSync(p)) return null; // 缺席=按空表（F-8②）
  let txt;
  try {
    txt = fs.readFileSync(p, "utf8");
  } catch (err) {
    bail(EXIT.IO, label + " 读取失败（IO 权限错）: " + err.message);
  }
  try {
    return JSON.parse(txt);
  } catch (err) {
    bail(EXIT.IO, label + " 解析失败: " + err.message);
  }
  return null;
}

function requireFields(obj, keys, label) {
  for (const k of keys) {
    if (!(k in obj)) bail(EXIT.IO, label + ": 缺字段 " + k);
  }
}

function validateBuilds(raw, label) {
  if (!Array.isArray(raw)) bail(EXIT.IO, label + ": 根必须是数组");
  const seenId = new Set();
  const seenFp = new Set();
  const out = [];
  for (const b of raw) {
    if (typeof b !== "object" || b === null || Array.isArray(b)) bail(EXIT.IO, label + ": 条目必须是对象");
    requireFields(b, ["build_id", "size", "sha256", "verdict"], label + "[build_id=" + String(b.build_id) + "]");
    if (typeof b.build_id !== "string" || !b.build_id) bail(EXIT.IO, label + ": build_id 须为非空字符串");
    if (!Number.isSafeInteger(b.size) || b.size <= 0) bail(EXIT.IO, label + ": size 须为正整数");
    if (typeof b.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(b.sha256)) bail(EXIT.IO, label + ": sha256 须为 64 位十六进制");
    if (!BUILD_VERDICTS.includes(b.verdict)) bail(EXIT.IO, label + ": verdict 非法（" + String(b.verdict) + "）");
    if (b.version !== undefined && b.version !== null && (typeof b.version !== "string" || !b.version)) {
      bail(EXIT.IO, label + ": version 须为非空字符串或省略");
    }
    if (seenId.has(b.build_id)) bail(EXIT.IO, label + ": build_id 重复（" + b.build_id + "）");
    const fp = b.sha256.toLowerCase() + ":" + b.size;
    if (seenFp.has(fp)) bail(EXIT.IO, label + ": sha256+size 指纹重复（" + b.build_id + "）");
    seenId.add(b.build_id);
    seenFp.add(fp);
    out.push({ build_id: b.build_id, version: typeof b.version === "string" ? b.version : null, size: b.size, sha256: b.sha256.toLowerCase(), verdict: b.verdict });
  }
  return out;
}

function validateActions(raw, builds, label) {
  if (!Array.isArray(raw)) bail(EXIT.IO, label + ": 根必须是数组");
  const byId = new Map();
  const byVersion = new Map();
  for (const b of builds) {
    byId.set(b.build_id, b);
    if (b.version) byVersion.set(b.version, b);
  }
  const seenId = new Set();
  const out = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) bail(EXIT.IO, label + ": 条目必须是对象");
    requireFields(e, ["id", "target_build", "anchor", "locate", "apply", "verify", "rollback", "evidence", "span"], label + "[id=" + String(e.id) + "]");
    if (typeof e.id !== "string" || !e.id) bail(EXIT.IO, label + ": id 须为非空字符串");
    if (seenId.has(e.id)) bail(EXIT.IO, label + ": id 重复（" + e.id + "）");
    seenId.add(e.id);
    const build = byId.get(e.target_build) || byVersion.get(e.target_build);
    if (!build) bail(EXIT.IO, label + ": target_build 未注册（" + String(e.target_build) + "，须等于 builds.json 的 build_id 或 version）");
    // anchor（role 可选：动作条目语境隐含 locate，缺省即 "locate"）
    if (typeof e.anchor !== "object" || e.anchor === null || Array.isArray(e.anchor)) bail(EXIT.IO, label + "[" + e.id + "]: anchor 须为对象");
    requireFields(e.anchor, ["literal", "expect_count"], label + "[" + e.id + "].anchor");
    if (typeof e.anchor.literal !== "string" || !e.anchor.literal) bail(EXIT.IO, label + "[" + e.id + "]: anchor.literal 须为非空字符串");
    if (!Number.isSafeInteger(e.anchor.expect_count) || e.anchor.expect_count < 1) bail(EXIT.IO, label + "[" + e.id + "]: anchor.expect_count 须为正整数");
    if (e.anchor.role !== undefined && !ANCHOR_ROLES.includes(e.anchor.role)) bail(EXIT.IO, label + "[" + e.id + "]: anchor.role 非法");
    // locate（window 容纳散文串=审计描述，或 null/{start,end}=定位窗口；boundary_spec 容纳对象=机器形态或字符串=散文形态）
    if (typeof e.locate !== "object" || e.locate === null || Array.isArray(e.locate)) bail(EXIT.IO, label + "[" + e.id + "]: locate 须为对象");
    requireFields(e.locate, ["boundary_spec"], label + "[" + e.id + "].locate");
    if (typeof e.locate.boundary_spec !== "object" && typeof e.locate.boundary_spec !== "string") bail(EXIT.IO, label + "[" + e.id + "]: boundary_spec 须为对象或字符串");
    if (typeof e.locate.boundary_spec === "object" && e.locate.boundary_spec !== null && typeof e.locate.boundary_spec.type !== "string") {
      bail(EXIT.IO, label + "[" + e.id + "]: boundary_spec.type 缺失");
    }
    if (e.locate.window !== undefined && e.locate.window !== null && typeof e.locate.window !== "string") {
      const w = e.locate.window;
      if (typeof w !== "object" || Array.isArray(w)) bail(EXIT.IO, label + "[" + e.id + "]: window 须为 null/字符串/{start,end}");
      requireFields(w, ["start", "end"], label + "[" + e.id + "].window");
      if (!Number.isSafeInteger(w.start) || !Number.isSafeInteger(w.end) || w.start < 0 || w.end < w.start) {
        bail(EXIT.IO, label + "[" + e.id + "]: window.start/end 非法");
      }
    }
    // apply
    if (typeof e.apply !== "object" || e.apply === null || Array.isArray(e.apply)) bail(EXIT.IO, label + "[" + e.id + "]: apply 须为对象");
    requireFields(e.apply, ["kind", "payload"], label + "[" + e.id + "].apply");
    if (!["insert", "replace"].includes(e.apply.kind)) bail(EXIT.IO, label + "[" + e.id + "]: apply.kind 非法");
    if (typeof e.apply.payload !== "string") bail(EXIT.IO, label + "[" + e.id + "]: apply.payload 须为字符串");
    // verify / rollback / evidence
    if (!Array.isArray(e.verify) || e.verify.length < 2) bail(EXIT.IO, label + "[" + e.id + "]: verify 须为 >=2 条的数组");
    if (e.rollback === null || e.rollback === undefined) bail(EXIT.IO, label + "[" + e.id + "]: rollback 缺失");
    if (e.evidence === null || e.evidence === undefined) bail(EXIT.IO, label + "[" + e.id + "]: evidence 缺失（N6 schema 纳管）");
    // span（半开区间 [start,end)；insert=零长、replace=正长）
    if (!Array.isArray(e.span) || e.span.length !== 2) bail(EXIT.IO, label + "[" + e.id + "]: span 须为二元数组");
    if (!Number.isSafeInteger(e.span[0]) || !Number.isSafeInteger(e.span[1]) || e.span[0] < 0 || e.span[1] < e.span[0]) {
      bail(EXIT.IO, label + "[" + e.id + "]: span 非法（半开区间 [start,end)）");
    }
    if (e.apply.kind === "insert" && e.span[0] !== e.span[1]) bail(EXIT.IO, label + "[" + e.id + "]: insert 条目 span 须为零长");
    if (e.apply.kind === "replace" && e.span[1] === e.span[0]) bail(EXIT.IO, label + "[" + e.id + "]: replace 条目 span 须为正长");
    out.push({
      id: e.id,
      target_build: e.target_build,
      anchor: e.anchor,
      locate: e.locate,
      apply: e.apply,
      verify: e.verify,
      rollback: e.rollback,
      evidence: e.evidence,
      span: e.span,
      _build: build,
      _span: null,
    });
  }
  return out;
}

function loadBuilds() {
  const raw = loadJsonTable(path.join(ENGINE_DIR, "builds.json"), "builds.json");
  if (raw === null) return [];
  return validateBuilds(raw, "builds.json");
}
function loadActions(builds) {
  const raw = loadJsonTable(path.join(ENGINE_DIR, "actions.json"), "actions.json");
  if (raw === null) return [];
  return validateActions(raw, builds, "actions.json");
}

/* ---------- CLI ---------- */

function usage() {
  console.log("zcode-bundle-patcher v" + TOOL_VERSION);
  console.log("用法:");
  console.log("  node patcher.mjs check   --bundle <p>");
  console.log("  node patcher.mjs patch   --bundle <p> [--dry-run] [--backup-dir <d>] [--force]");
  console.log("  node patcher.mjs restore --bundle <p> --backup-dir <d>");
  console.log("退出码: 0 成功/no-op | 1 通用 | 2 fingerprint-unknown | 3 锚失守/计数不符 | 4 IO/表损坏/校验失败/span 相交 | 5 target-pending | 6 表 bug 诊断(--force)");
}

function parseArgs(argv) {
  const sub = argv[0];
  if (!["check", "patch", "restore"].includes(sub)) {
    usage();
    process.exit(EXIT.GENERIC);
  }
  const o = { sub, bundle: null, backupDir: null, dryRun: false, force: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle") o.bundle = argv[++i];
    else if (a === "--backup-dir") o.backupDir = argv[++i];
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--force") o.force = true;
    else {
      console.error("未知参数: " + a);
      usage();
      process.exit(EXIT.GENERIC);
    }
  }
  if (!o.bundle) {
    console.error("缺少 --bundle <p>");
    usage();
    process.exit(EXIT.GENERIC);
  }
  if (sub === "restore" && !o.backupDir) {
    console.error("restore 需要 --backup-dir <d>");
    usage();
    process.exit(EXIT.GENERIC);
  }
  return o;
}

function readBundle(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    bail(EXIT.GENERIC, "无法读取 bundle: " + err.message);
  }
  return buf;
}

/* ---------- 判定序四级（draft §3.0） ---------- */

function classify(buf, s, builds, actions) {
  // 第 0 步 marker（早于指纹门，check/patch 共用）
  if (s.includes(MARKER)) {
    return { verdict: "already-patched", code: EXIT.OK, fingerprint: "marker:" + MARKER, build: null, entries: [], anchorRows: null };
  }
  // 第 1 步指纹门：sha256+size 精确匹配
  const hex = sha256Hex(buf);
  const size = buf.length;
  const build = builds.find((b) => b.sha256 === hex && b.size === size) || null;
  if (build) {
    const entries = actions.filter((a) => a._build === build);
    if (build.verdict === "good-negative") {
      return { verdict: "already-good-negative", code: EXIT.OK, fingerprint: build.build_id, build, entries, anchorRows: null };
    }
    // N3：target-pending=在册构建且动作条目空（含表缺席=按空表），推导态优先于注册表静态 verdict（fail-closed 向）
    if (entries.length === 0 || build.verdict === "target-pending") {
      return { verdict: "target-pending", code: EXIT.PENDING, fingerprint: build.build_id, build, entries, anchorRows: null,
        reason: entries.length === 0 ? "动作条目空（actions.json 缺席=按空表）" : "注册表静态 verdict=target-pending" };
    }
    return { verdict: "target-ready", code: EXIT.OK, fingerprint: build.build_id, build, entries, anchorRows: null };
  }
  // 第 2 步锚判别（仅门未命中时）：context 锚 11 项逐行对表
  let hit = 0;
  const rows = CONTEXT_ANCHORS.map((a) => {
    const actual = countOccurrences(s, a.literal);
    if (actual === a.expect) hit += 1;
    return { literal: a.literal, expect: a.expect, actual };
  });
  const fingerprint = "anchors=" + hit + "/11;size=" + size;
  if (hit >= THRESHOLD) {
    return { verdict: "fingerprint-unknown", code: EXIT.UNKNOWN, fingerprint, build: null, entries: [], anchorRows: rows };
  }
  return { verdict: "anchors-lost", code: EXIT.ANCHOR, fingerprint, build: null, entries: [], anchorRows: rows };
}

function printCls(cls) {
  console.log("verdict=" + cls.verdict);
  console.log("fingerprint=" + cls.fingerprint);
  if (cls.reason) console.log("reason=" + cls.reason);
  if (cls.anchorRows) {
    for (const r of cls.anchorRows) {
      console.log("[ctx] \"" + r.literal + "\" expect=" + r.expect + " actual=" + r.actual + (r.actual === r.expect ? " ok" : " MISMATCH"));
    }
  }
}

/* ---------- 函数边界 scanner（draft §3.2-4；状态机+括号平衡） ---------- */

function regexAllowed(prevChar, prevWord) {
  if (prevChar === "") return true;
  if ("([{,;=:?!&|}+-%*/<>~^".includes(prevChar)) return true;
  return ["return", "typeof", "case", "in", "of", "instanceof", "new", "delete", "void", "do", "else", "yield", "await"].includes(prevWord);
}

// s[openIdx] === "{"；返回与之配对的 "}" 下标；失守 = exit 3（拒改路径）
function scanFunctionBody(s, openIdx) {
  const n = s.length;
  let depth = 0;
  let state = "code";
  let prevChar = "";
  let prevWord = "";
  const tplStack = [];
  for (let i = openIdx; i < n; i++) {
    const ch = s[i];
    const nx = i + 1 < n ? s[i + 1] : "";
    if (state === "code") {
      if (ch === "/" && nx === "/") { state = "lcomment"; i += 1; continue; }
      if (ch === "/" && nx === "*") { state = "bcomment"; i += 1; continue; }
      if (ch === "'") { state = "squote"; prevChar = ch; prevWord = ""; continue; }
      if (ch === "\"") { state = "dquote"; prevChar = ch; prevWord = ""; continue; }
      if (ch === "`") { state = "tpl"; prevChar = ch; prevWord = ""; continue; }
      if (ch === "/") {
        if (regexAllowed(prevChar, prevWord)) { state = "regex"; prevChar = ch; prevWord = ""; continue; }
        prevChar = ch; prevWord = ""; continue;
      }
      if (ch === "{") { depth += 1; prevChar = ch; prevWord = ""; continue; }
      if (ch === "}") {
        if (tplStack.length > 0 && depth === tplStack[tplStack.length - 1]) { tplStack.pop(); state = "tpl"; prevChar = ch; prevWord = ""; continue; }
        depth -= 1;
        if (depth === 0) return i;
        prevChar = ch; prevWord = ""; continue;
      }
      if (/[A-Za-z_$]/.test(ch)) { prevWord += ch; prevChar = ch; continue; }
      if (!/\s/.test(ch)) { prevChar = ch; prevWord = ""; }
      continue;
    }
    if (state === "squote") { if (ch === "\\") { i += 1; } else if (ch === "'") { state = "code"; } continue; }
    if (state === "dquote") { if (ch === "\\") { i += 1; } else if (ch === "\"") { state = "code"; } continue; }
    if (state === "tpl") {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "`") { state = "code"; continue; }
      if (ch === "$" && nx === "{") { tplStack.push(depth); state = "code"; i += 1; }
      continue;
    }
    if (state === "lcomment") { if (ch === "\n") { state = "code"; } continue; }
    if (state === "bcomment") { if (ch === "*" && nx === "/") { state = "code"; i += 1; } continue; }
    if (state === "regex") {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "[") { state = "rxclass"; continue; }
      if (ch === "/") { state = "code"; prevChar = "x"; prevWord = ""; }
      continue;
    }
    if (state === "rxclass") { if (ch === "\\") { i += 1; } else if (ch === "]") { state = "regex"; } continue; }
  }
  bail(EXIT.ANCHOR, "函数边界扫描：括号不平衡/未闭合（拒改）");
}

/* ---------- boundary_spec 解析 + N2 span 一致性（draft §3.2-2） ---------- */

function resolveSpan(e, s, size) {
  const lit = e.anchor.literal;
  const occ = allOccurrences(s, lit); // 计数已在管线步 2 校验 == expect_count
  const spec = e.locate.boundary_spec;
  // 散文形态（字符串）：登记 span 即运行期 span，fail-closed 结构断言替代 N2 等值
  if (typeof spec === "string") {
    const start = e.span[0];
    const end = e.span[1];
    if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= size)) {
      bail(EXIT.ANCHOR, "span 越界: id=" + e.id + " [" + start + "," + end + ") size=" + size);
    }
    if (occ.length !== 1) {
      bail(EXIT.ANCHOR, "散文 boundary_spec 需锚在目标构建内唯一（expect_count=1），实际 " + occ.length + ": id=" + e.id + " 拒改");
    }
    const pos = occ[0];
    const aEnd = pos + lit.length;
    if (e.apply.kind === "replace") {
      if (!(start <= pos && aEnd <= end)) {
        bail(EXIT.ANCHOR, "结构断言失败（replace：锚须整段落在 span 内）: id=" + e.id + " 锚=[" + pos + "," + aEnd + ") span=[" + start + "," + end + ") 拒改");
      }
    } else {
      if (!(start === end && pos < start && start < aEnd)) {
        bail(EXIT.ANCHOR, "结构断言失败（insert：插入点须严格落在锚内部，锚尾/锚外=语法错风险 F-3）: id=" + e.id + " 拒改");
      }
    }
    return { start, end };
  }
  // 机器对象形态：typed 解析 + N2 等值
  let cands = occ;
  const w = e.locate.window;
  if (w && typeof w === "object") cands = occ.filter((p) => p >= w.start && p < w.end);
  if (cands.length !== 1) {
    bail(EXIT.ANCHOR, "定位歧义: id=" + e.id + " 候选=" + cands.length + "（window 过滤后须恰 1，拒改）");
  }
  const a0 = cands[0];
  const aLen = lit.length;
  const type = spec.type;
  let start;
  let end;
  if (type === "anchor") {
    start = a0;
    end = a0 + aLen;
  } else if (type === "anchor_suffix") {
    const suf = spec.suffix;
    if (typeof suf !== "string" || !suf) bail(EXIT.IO, "boundary_spec.anchor_suffix.suffix 须为非空字符串: id=" + e.id);
    if (s.slice(a0 + aLen, a0 + aLen + suf.length) !== suf) {
      bail(EXIT.ANCHOR, "anchor_suffix 尾随字节断言失败: id=" + e.id);
    }
    start = a0;
    end = a0 + aLen + suf.length;
  } else if (type === "array_rhs") {
    const ob = spec.open_back;
    if (!Number.isSafeInteger(ob) || ob < 1) bail(EXIT.IO, "boundary_spec.array_rhs.open_back 须为正整数: id=" + e.id);
    const cl = spec.close_literal;
    if (typeof cl !== "string" || !cl) bail(EXIT.IO, "boundary_spec.array_rhs.close_literal 须为非空字符串: id=" + e.id);
    const openPos = a0 - ob;
    if (openPos < 0 || s[openPos] !== "[") bail(EXIT.ANCHOR, "array_rhs 首 '[' 字节断言失败: id=" + e.id);
    const ci = s.indexOf(cl, a0 + aLen);
    if (ci === -1) bail(EXIT.ANCHOR, "array_rhs close_literal 未找到: id=" + e.id);
    end = ci + cl.length;
    if (s[end - 1] !== "]") bail(EXIT.ANCHOR, "array_rhs 末 ']' 字节断言失败: id=" + e.id);
    start = openPos;
  } else if (type === "body_start") {
    const pre = spec.prefix;
    if (typeof pre !== "string" || !pre) bail(EXIT.IO, "boundary_spec.body_start.prefix 须为非空字符串: id=" + e.id);
    if (s.slice(a0, a0 + pre.length) !== pre) bail(EXIT.ANCHOR, "body_start 前缀断言失败: id=" + e.id);
    const p = a0 + pre.length;
    start = p;
    end = p;
  } else if (type === "function_body") {
    const hl = spec.head_len;
    if (!Number.isSafeInteger(hl) || hl < 1 || hl > aLen) bail(EXIT.IO, "boundary_spec.function_body.head_len 非法: id=" + e.id);
    const head = s.slice(a0, a0 + hl);
    const bo = head.indexOf("{");
    if (bo === -1) bail(EXIT.ANCHOR, "function_body 头部无 '{': id=" + e.id);
    const openBrace = a0 + bo;
    const closeIdx = scanFunctionBody(s, openBrace);
    if (spec.mode === "body") { start = openBrace + 1; end = closeIdx; }
    else if (spec.mode === "body_start") { start = openBrace + 1; end = openBrace + 1; }
    else bail(EXIT.IO, "boundary_spec.function_body.mode 非法: id=" + e.id);
  } else {
    bail(EXIT.IO, "boundary_spec 类型不支持: " + String(type) + " (id=" + e.id + ")");
  }
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= size)) {
    bail(EXIT.ANCHOR, "span 越界: id=" + e.id + " [" + start + "," + end + ") size=" + size);
  }
  // N2：运行期定位结果=boundary_spec 解析后 span，须与登记 span 一致（fail-closed，非裸锚 indexOf 位）
  if (start !== e.span[0] || end !== e.span[1]) {
    bail(EXIT.ANCHOR, "span 一致性失败（N2）: id=" + e.id + " 解析=[" + start + "," + end + ") 登记=[" + e.span[0] + "," + e.span[1] + ") 拒改");
  }
  return { start, end };
}

/* ---------- patch 管线（draft §3.2 五步 + §5 安全面） ---------- */

function spawnCheck(targetPath) {
  // child_process 唯一合法用法（T9 断言钉死：全文件仅此一处 spawn 调用）
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--check", targetPath], { stdio: ["ignore", "ignore", "pipe"] });
    let errTxt = "";
    p.stderr.on("data", (d) => { errTxt += String(d); });
    p.on("error", (er) => resolve({ ok: false, msg: String(er) }));
    p.on("close", (code) => resolve({ ok: code === 0, msg: errTxt.slice(0, 400) }));
  });
}

/* ---------- verify[] 校验④：表内机器断言逐条求值（不可解析=fail-closed exit 4） ---------- */

function parseVerifyClaims(e) {
  const claims = [];
  for (const itemRaw of e.verify) {
    const parts = String(itemRaw).split(" AND ");
    for (const rawPart of parts) {
      const part = rawPart.trim();
      let m;
      m = part.match(/bytes at \[[^\],]+, ?[a-z_.]+ ?\+ ?(\d+)\) ?== ?'([^']*)'/);
      if (m) { claims.push({ kind: "span_bytes", n: Number(m[1]), lit: m[2], item: itemRaw }); continue; }
      m = part.match(/patched span first byte == '(.)' and last byte == '(.)'/);
      if (m) { claims.push({ kind: "span_struct", first: m[1], last: m[2], item: itemRaw }); continue; }
      m = part.match(/byte at insert_point-1 == '(.)'/);
      if (m) { claims.push({ kind: "insert_before", ch: m[1], item: itemRaw }); continue; }
      m = part.match(/count of '([^']*)'.*?== ?(\d+)/);
      if (m) { claims.push({ kind: "count", lit: m[1], n: Number(m[2]), item: itemRaw }); continue; }
      m = part.match(/count of (?:the )?[a-z0-9' -]*anchor literal.*?== ?(\d+)/);
      if (m) { claims.push({ kind: "count_anchor", n: Number(m[1]), item: itemRaw }); continue; }
      bail(EXIT.IO, "verify 条目含无法解析的子句（fail-closed）: id=" + e.id + " item=" + JSON.stringify(itemRaw));
    }
  }
  return claims;
}

function evalVerifyClaims(e, claims, sOut) {
  // span 相对断言一律按位移后（输出缓冲）坐标求值；_outSpan=本条目 payload 写入区域，
  // 零位移（等长替换/单 span）时与登记坐标重合，语义不变
  const sp = e._outSpan || { start: e.span[0], end: e.span[1] };
  for (const c of claims) {
    let ok = false;
    let desc = "";
    if (c.kind === "span_bytes") {
      const got = sOut.slice(sp.start, sp.start + c.n);
      ok = got === c.lit && c.lit.length === c.n;
      desc = "span 后字节[" + sp.start + ",+" + c.n + ")==" + JSON.stringify(c.lit);
    } else if (c.kind === "span_struct") {
      ok = sOut[sp.start] === c.first && sOut[sp.end - 1] === c.last;
      desc = "span 首末字节==" + JSON.stringify(c.first) + "/" + JSON.stringify(c.last);
    } else if (c.kind === "insert_before") {
      ok = sp.start > 0 && sOut[sp.start - 1] === c.ch;
      desc = "插入点前字节==" + JSON.stringify(c.ch);
    } else if (c.kind === "count") {
      const n = countOccurrences(sOut, c.lit);
      ok = n === c.n;
      desc = "计数 " + JSON.stringify(c.lit) + "==" + c.n + "（实际 " + n + "）";
    } else if (c.kind === "count_anchor") {
      const n = countOccurrences(sOut, e.anchor.literal);
      ok = n === c.n;
      desc = "锚计数==" + c.n + "（实际 " + n + "）";
    }
    if (!ok) return "verify 断言失败: id=" + e.id + " [" + desc + "] item=" + JSON.stringify(c.item);
  }
  return null;
}

// span 相交判定（半开区间 [start,end)；端点相邻=合法；零长插入点=空点集，仅当严格内含他 span 时判相交）
function spansIntersect(a, b) {
  if (a.start === a.end && b.start === b.end) return false;
  if (a.start === a.end) { const p = a.start; return b.start < p && p < b.end; }
  if (b.start === b.end) { const p = b.start; return a.start < p && p < a.end; }
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

async function runPipeline(buf, s, entries, opts) {
  const size = buf.length;
  // 步 2：锚计数 = expect_count（不符只可能=表 bug/工具 bug）
  const mismatched = [];
  for (const e of entries) {
    const actual = countOccurrences(s, e.anchor.literal);
    if (actual !== e.anchor.expect_count) mismatched.push({ e, actual });
  }
  if (mismatched.length > 0) {
    if (!opts.force) {
      const m = mismatched[0];
      bail(EXIT.ANCHOR, "锚计数不符: id=" + m.e.id + " expect=" + m.e.anchor.expect_count + " actual=" + m.actual + "（拒改；--force 仅诊断不放行）");
    }
    for (const m of mismatched) {
      console.log("[diagnose] id=" + m.e.id + " anchor=" + JSON.stringify(m.e.anchor.literal) + " expect=" + m.e.anchor.expect_count + " actual=" + m.actual + " MISMATCH");
    }
    console.log("[diagnose] 表 bug，请修表；本次不 patch（--force 永不放行）");
    return EXIT.TABLEBUG;
  }
  // N2：boundary_spec 解析后 span + 与登记 span 一致性
  for (const e of entries) e._span = resolveSpan(e, s, size);
  // 步 3：span 两两不相交预检（半开区间；端点相邻合法；零长点严格内含他 span=相交，exit 4）
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (spansIntersect(entries[i]._span, entries[j]._span)) {
        bail(EXIT.IO, "span 相交: id=" + entries[i].id + " [" + entries[i]._span.start + "," + entries[i]._span.end + ") x id=" + entries[j].id + " [" + entries[j]._span.start + "," + entries[j]._span.end + ") 拒（登记硬约束 QA3-5）");
      }
    }
  }
  // 步 5：span 起点升序逐个应用（确定性）
  const sorted = entries.slice().sort((x, y) => (x._span.start - y._span.start) || (x._span.end - y._span.end) || (x.id < y.id ? -1 : 1));
  if (opts.dryRun) {
    console.log("dry-run=true（零写盘）");
    for (const e of sorted) {
      const kind = e.apply.kind;
      const pl = kind === "insert" ? MARKER_COMMENT.length + e.apply.payload.length : e.apply.payload.length;
      console.log("plan id=" + e.id + " kind=" + kind + " span=[" + e._span.start + "," + e._span.end + ") payload_bytes=" + pl + " ctx=" + JSON.stringify(excerpt(s, e._span.start, e._span.end)));
    }
    console.log("written=nothing");
    return EXIT.OK;
  }
  // §5 强制备份（无豁免；失败即中止拒写）
  const bdir = opts.backupDir || path.join(ENGINE_DIR, "backups");
  try {
    fs.mkdirSync(bdir, { recursive: true });
  } catch (err) {
    bail(EXIT.IO, "备份失败（目录创建），中止拒写: " + err.message);
  }
  const origSha = sha256Hex(buf);
  const d = new Date();
  const stamp = d.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const bakPath = path.join(bdir, "bundle-" + origSha.slice(0, 8) + "-" + stamp + ".cjs");
  try {
    fs.writeFileSync(bakPath, buf);
  } catch (err) {
    bail(EXIT.IO, "备份失败（写入），中止拒写: " + err.message);
  }
  // apply（全 Buffer/latin1 字节偏移防多字节漂移）
  const parts = [];
  let prev = 0;
  let shift = 0; // 累积字节位移：变长替换/插入使后续 span 在输出缓冲中平移
  const spanRecords = [];
  for (const e of sorted) {
    const start = e._span.start;
    const end = e._span.end;
    parts.push(buf.subarray(prev, start));
    // insert：体首插入 payload+marker 注释（marker 附尾——表内 span_post 断言以 insert_point 起点为 payload 基准）
    const replacement = e.apply.kind === "insert" ? (e.apply.payload + MARKER_COMMENT) : e.apply.payload;
    parts.push(Buffer.from(replacement, "latin1"));
    spanRecords.push({ id: e.id, start, end, original: s.slice(start, end) }); // manifest 记原始登记坐标+原字节（rollback/审计口径）
    // 输出缓冲坐标：= 本条目 payload 写入区域 [outStart, outStart+replacement.length)。
    // 校验④ span 相对断言按此求值（M3 harness 独立求值器同语义）；变长替换下不可用「原 span 长度平移」
    // 的 end（越界读到 span 后旧内容，span_struct 首末字节即此误读）；零位移（等长替换）时与登记坐标重合。
    e._outSpan = { start: start + shift, end: start + shift + replacement.length };
    shift += replacement.length - (end - start);
    prev = end;
  }
  parts.push(buf.subarray(prev));
  const outBuf = Buffer.concat(parts);
  try {
    fs.writeFileSync(opts.bundlePath, outBuf);
  } catch (err) {
    bail(EXIT.IO, "写 bundle 失败: " + err.message);
  }
  // 三重校验（任一失败自动从备份回写并报错）
  const sOut = latin(outBuf);
  let failReason = null;
  const chk = await spawnCheck(opts.bundlePath); // 校验①：语法机械面
  if (!chk.ok) failReason = "语法校验失败: " + chk.msg;
  if (!failReason) {
    // 校验②：context 锚计数与 patch 前一致 + marker 数=预期（=insert 条数）
    for (let i = 0; i < CONTEXT_ANCHORS.length; i++) {
      const a = CONTEXT_ANCHORS[i];
      const before = countOccurrences(s, a.literal);
      const after = countOccurrences(sOut, a.literal);
      if (before !== after) { failReason = "context 锚计数漂移: \"" + a.literal + "\" " + before + "->" + after; break; }
    }
    if (!failReason) {
      const markerExpected = sorted.filter((e) => e.apply.kind === "insert").length;
      const markerActual = countOccurrences(sOut, MARKER);
      if (markerActual !== markerExpected) failReason = "marker 数不符: expect=" + markerExpected + " actual=" + markerActual;
    }
  }
  if (!failReason) {
    // 校验③：字节级反证（落盘字节=确定性重算结果；长度差=span 字节差）
    let reRead = null;
    try { reRead = fs.readFileSync(opts.bundlePath); } catch (err) { failReason = "回读失败: " + err.message; }
    if (!failReason) {
      if (!reRead.equals(outBuf)) failReason = "字节级反证失败：落盘内容与确定性重算不一致";
      else {
        let delta = 0;
        for (const e of sorted) {
          delta += (e.apply.kind === "insert" ? MARKER_COMMENT.length + e.apply.payload.length : e.apply.payload.length) - (e._span.end - e._span.start);
        }
        if (outBuf.length - buf.length !== delta) failReason = "长度差反证失败";
      }
    }
  }
  if (!failReason) {
    // 校验④：表内 verify[] 机器断言逐条求值
    for (const e of sorted) {
      const verdictMsg = evalVerifyClaims(e, parseVerifyClaims(e), sOut);
      if (verdictMsg) { failReason = verdictMsg; break; }
    }
  }
  if (failReason) {
    try {
      fs.writeFileSync(opts.bundlePath, buf);
      const reSha = sha256Hex(fs.readFileSync(opts.bundlePath));
      if (reSha !== origSha) bail(EXIT.IO, "校验失败且回滚后指纹不符（备份: " + bakPath + "）");
    } catch (err) {
      bail(EXIT.IO, "校验失败且回滚失败（备份: " + bakPath + "）: " + err.message);
    }
    bail(EXIT.IO, "校验失败已自动回滚: " + failReason);
  }
  // manifest 落盘（§5 字段全集）
  const manifest = {
    bundle_path: path.resolve(opts.bundlePath),
    sha256_orig: origSha,
    size_orig: buf.length,
    backup_path: path.resolve(bakPath),
    patch_spans: spanRecords,
    actions_applied: sorted.map((e) => e.id),
    sha256_patched: sha256Hex(outBuf),
    size_patched: outBuf.length,
    tool_version: TOOL_VERSION,
    created: new Date().toISOString(),
  };
  const manifestPath = path.join(bdir, "manifest.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (err) {
    bail(EXIT.IO, "manifest 写入失败（bundle 已 patch，备份: " + bakPath + "）: " + err.message);
  }
  console.log("verdict=patched");
  console.log("fingerprint=" + (opts.buildId || ""));
  console.log("applied=" + sorted.length);
  console.log("sha256_patched=" + manifest.sha256_patched);
  console.log("size_patched=" + manifest.size_patched);
  console.log("backup=" + bakPath);
  console.log("manifest=" + manifestPath);
  return EXIT.OK;
}

/* ---------- restore 五步（draft §4.1；QA-R2-6 路径规范化无逃生口） ---------- */

function normalizeTarget(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch (err) { /* 目标不存在→用 resolve 结果（误拒方向安全） */ }
  return r.replace(/[\\/]+/g, "/").toLowerCase();
}

function cmdRestore(opts) {
  const mPath = path.join(opts.backupDir, "manifest.json");
  if (!fs.existsSync(mPath)) bail(EXIT.IO, "manifest 缺失: " + mPath);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mPath, "utf8"));
  } catch (err) {
    bail(EXIT.IO, "manifest 解析失败: " + err.message);
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) bail(EXIT.IO, "manifest 不合法: 根须为对象");
  requireFields(m, ["bundle_path", "sha256_orig", "size_orig", "backup_path", "patch_spans", "actions_applied", "sha256_patched", "size_patched", "tool_version", "created"], "manifest");
  if (typeof m.bundle_path !== "string" || !m.bundle_path) bail(EXIT.IO, "manifest 不合法: bundle_path");
  if (typeof m.sha256_orig !== "string" || !/^[0-9a-fA-F]{64}$/.test(m.sha256_orig)) bail(EXIT.IO, "manifest 不合法: sha256_orig");
  if (!Number.isSafeInteger(m.size_orig) || m.size_orig < 0) bail(EXIT.IO, "manifest 不合法: size_orig");
  if (typeof m.backup_path !== "string" || !m.backup_path) bail(EXIT.IO, "manifest 不合法: backup_path");
  // ② 备份校验：备份 sha256 == sha256_orig
  const bakAbs = path.isAbsolute(m.backup_path) ? m.backup_path : path.join(opts.backupDir, m.backup_path);
  let bak;
  try {
    bak = fs.readFileSync(bakAbs);
  } catch (err) {
    bail(EXIT.IO, "备份读取失败: " + err.message);
  }
  if (sha256Hex(bak) !== m.sha256_orig.toLowerCase() || bak.length !== m.size_orig) {
    bail(EXIT.IO, "备份校验失败（sha256/size 与 manifest.sha256_orig 不符）: " + bakAbs);
  }
  // ③ 目标路径校验（规范化=realpath+win32 大小写不敏感+正反斜杠归一；不符即拒、无逃生口）
  const targetNorm = normalizeTarget(opts.bundle);
  const manifestNorm = normalizeTarget(m.bundle_path);
  if (targetNorm !== manifestNorm) {
    bail(EXIT.IO, "restore 目标路径校验失败（无逃生口）: --bundle=" + opts.bundle + " manifest.bundle_path=" + m.bundle_path);
  }
  // ④ 目标已存在且 sha256==sha256_orig → already-restored no-op
  if (fs.existsSync(opts.bundle)) {
    let cur;
    try { cur = fs.readFileSync(opts.bundle); } catch (err) { bail(EXIT.IO, "目标读取失败: " + err.message); }
    if (sha256Hex(cur) === m.sha256_orig.toLowerCase()) {
      console.log("verdict=already-restored");
      console.log("sha256=" + m.sha256_orig.toLowerCase());
      printRestoreNote(m);
      return EXIT.OK;
    }
  }
  // ⑤ 回写 + 输出性对照
  try {
    fs.writeFileSync(opts.bundle, bak);
  } catch (err) {
    bail(EXIT.IO, "回写失败: " + err.message);
  }
  let re;
  try { re = fs.readFileSync(opts.bundle); } catch (err) { bail(EXIT.IO, "回写后回读失败: " + err.message); }
  if (sha256Hex(re) !== m.sha256_orig.toLowerCase()) bail(EXIT.IO, "回写后校验失败（sha256 != sha256_orig）");
  console.log("verdict=restored");
  console.log("sha256=" + m.sha256_orig.toLowerCase());
  printRestoreNote(m);
  return EXIT.OK;
}

function printRestoreNote(m) {
  console.log("sha256_patched=" + String(m.sha256_patched));
  console.log("size_patched=" + String(m.size_patched));
  console.log("note=原 patch 后指纹=sha256_patched/size_patched，如与你的记忆不符请核查期间是否被外部改动");
}

/* ---------- check / patch ---------- */

function cmdCheck(opts, buf, s, cls) {
  console.log("bundle=" + opts.bundle);
  console.log("size=" + buf.length);
  console.log("sha256=" + sha256Hex(buf));
  console.log("marker=" + (s.includes(MARKER) ? "present" : "absent"));
  printCls(cls);
  return cls.code;
}

async function cmdPatch(opts, buf, s, cls) {
  console.log("bundle=" + opts.bundle);
  console.log("size=" + buf.length);
  console.log("sha256=" + sha256Hex(buf));
  console.log("marker=" + (s.includes(MARKER) ? "present" : "absent"));
  if (cls.verdict === "already-patched") { printCls(cls); console.log("no-op（幂等，判定序第 0 步命中 marker）"); return cls.code; }
  if (cls.verdict === "already-good-negative") { printCls(cls); console.log("no-op 拒写（好版，防误伤）"); return cls.code; }
  if (cls.verdict === "target-pending") { printCls(cls); return cls.code; }
  if (cls.verdict === "fingerprint-unknown") { printCls(cls); console.log("hint=疑似 ZCode 未知精确构建，请携 fingerprint 行开 issue 走 onboarding 登记"); return cls.code; }
  if (cls.verdict === "anchors-lost") { printCls(cls); console.log("hint=非 ZCode bundle，拒改"); return cls.code; }
  // target-ready → 动作管线
  console.log("fingerprint=" + cls.fingerprint);
  return runPipeline(buf, s, cls.entries, {
    bundlePath: opts.bundle,
    backupDir: opts.backupDir,
    dryRun: opts.dryRun,
    force: opts.force,
    buildId: cls.fingerprint,
  });
}

/* ---------- main ---------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.sub === "restore") return cmdRestore(opts);
  const builds = loadBuilds();
  const actions = loadActions(builds);
  const buf = readBundle(opts.bundle);
  const s = latin(buf);
  const cls = classify(buf, s, builds, actions);
  if (opts.sub === "check") return cmdCheck(opts, buf, s, cls);
  return cmdPatch(opts, buf, s, cls);
}

main()
  .then((code) => process.exit(code ?? EXIT.OK))
  .catch((err) => {
    if (err instanceof Exit) {
      console.error("error: " + err.message);
      process.exit(err.code);
    }
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(EXIT.GENERIC);
  });
