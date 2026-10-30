// zcode-bundle-patcher 测试套（20 用例项；运行时条件激活：真表/真备份/真样本在位才激活，缺席=显式 SKIP 非 RED）
// 零依赖、node >=20。表置换机制：patcher.mjs 拷入临时目录后就地置表（引擎表基准=自身同目录）。
// 纪律：bundle 原件只读（活体只许拷出副本，对拍通过才可用）；--backup-dir 恒指临时目录（真备份目录只增不清理语义不被测试污染）；
//       临时工作区用后即弃；阳性/阴性 fixture 样本永久留存位不受本套影响。
// 用法：node test/run.mjs [--out <results.json>]；退出码：failed>0 → 1，否则 0（SKIP 不算红）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.dirname(TEST_DIR);
const PATCHER = path.join(ENGINE_DIR, "patcher.mjs");
const BUILDS_JSON = path.join(ENGINE_DIR, "builds.json");
const HARNESS = path.join(TEST_DIR, "harness.mjs");

const GOOD_SHA = "a055234a6ca3da0172616d3987cf3c617b6a26deb1332d69035300c2a0ae0de1";
const BAD_SHA = "395307aba9b59ba6a099f4941b073ec7a8b53fe4154e4e75af65b3703d2e6d36";
const GOOD_SIZE = 15243891;
const BAD_SIZE = 15405921;
const GOOD_ID = "zcode-cli-0.17.0-win-x64";
const BAD_ID = "zcode-cli-0.17.1-win-x64";
const GOOD_SRC = process.env.ZBPATCH_GOOD || "C:/Program Files/ZCode/resources/glm/zcode.cjs";
const POS_SRC = process.env.ZBPATCH_POSITIVE || path.join(os.tmpdir(), "zcode-0171-fixture", "app", "resources", "glm", "zcode.cjs");

const results = [];
class Skip extends Error {}
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function shaFile(p) {
  try {
    return sha256Hex(fs.readFileSync(p));
  } catch (err) {
    return null;
  }
}
function outOf(r) {
  return String(r.stdout || "") + String(r.stderr || "");
}
function verdictOf(r) {
  const m = String(r.stdout || "").match(/verdict=(\S+)/);
  return m ? m[1] : null;
}

// ---------- 工作区与 fixture ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "zbpatch-test-"));
const sampleNote = [];
let sentStart = null;

function prepSample(src, name, wantSha, wantSize) {
  if (!fs.existsSync(src)) {
    sampleNote.push("样本缺席:" + src);
    return null;
  }
  const dst = path.join(ROOT, name);
  fs.copyFileSync(src, dst); // 只读拷贝出副本；原件零触
  const b = fs.readFileSync(dst);
  if (b.length !== wantSize || sha256Hex(b) !== wantSha) {
    sampleNote.push("sha256/size 对拍失败:" + src);
    try { fs.rmSync(dst, { force: true }); } catch (err) { /* 忽略 */ }
    return null;
  }
  return dst;
}

function runCli(engine, args, timeoutMs) {
  return spawnSync(process.execPath, [engine].concat(args), { encoding: "utf8", timeout: timeoutMs || 120000 });
}

function mkTableDir(tag, buildsRaw, actionsRaw) {
  const dir = path.join(ROOT, "tbl-" + tag);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(PATCHER, path.join(dir, "patcher.mjs")); // 引擎拷入临时目录，表基准=其同目录
  if (buildsRaw !== undefined && buildsRaw !== null) {
    fs.writeFileSync(path.join(dir, "builds.json"), typeof buildsRaw === "string" ? buildsRaw : JSON.stringify(buildsRaw));
  }
  if (actionsRaw !== undefined) {
    fs.writeFileSync(path.join(dir, "actions.json"), typeof actionsRaw === "string" ? actionsRaw : JSON.stringify(actionsRaw));
  }
  return dir;
}

function buildEntry(id, version, size, sha, verdict) {
  return { build_id: id, version, size, sha256: sha, verdict };
}

// 合成动作条目（七字段+evidence 全集；verify 用表内机器文法，供引擎校验④求值）
function actionEntry(o) {
  return {
    id: o.id,
    target_build: o.target_build,
    anchor: { literal: o.anchor, expect_count: 1, role: "locate" },
    locate: { window: o.window === undefined ? null : o.window, boundary_spec: o.spec },
    apply: { kind: o.kind, payload: o.payload },
    verify: o.verify,
    rollback: o.rollback || "rewrite span with the original bytes recorded in manifest.patch_spans",
    span: o.span,
    evidence: { source: "synthetic fixture", note: o.note || "" },
  };
}

const goodCopy = prepSample(GOOD_SRC, "good.cjs", GOOD_SHA, GOOD_SIZE);
const posCopy = prepSample(POS_SRC, "pos.cjs", BAD_SHA, BAD_SIZE);
sentStart = shaFile(GOOD_SRC); // T10 活体哨兵·首
function sampleSkip() {
  return new Skip(sampleNote.join(";") || "样本不可用");
}

// ---------- 用例注册 ----------
const CASES = [];
function t(id, name, fn) {
  CASES.push({ id, name, fn });
}

t("T1", "check 好版拷贝 → verdict=already-good-negative", () => {
  if (!goodCopy) throw sampleSkip();
  const r = runCli(PATCHER, ["check", "--bundle", goodCopy]);
  must(r.status === 0, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(verdictOf(r) === "already-good-negative", "verdict=" + verdictOf(r));
  must(String(r.stdout).includes("fingerprint=" + GOOD_ID), "fingerprint 未命中注册表");
  return "exit=0 verdict=already-good-negative";
});

t("T2", "patch 好版拷贝 → no-op 拒写、文件零变化", () => {
  if (!goodCopy) throw sampleSkip();
  const bak = path.join(ROOT, "t2-bak");
  const before = shaFile(goodCopy);
  const r = runCli(PATCHER, ["patch", "--bundle", goodCopy, "--backup-dir", bak]);
  must(r.status === 0, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(verdictOf(r) === "already-good-negative", "verdict=" + verdictOf(r));
  must(shaFile(goodCopy) === before, "好版拷贝字节被改（防误伤失守）");
  must(!fs.existsSync(bak), "no-op 却创建了备份目录");
  return "拒写 + 零字节变化 + 无备份落盘";
});

t("T3", "check 真 0.17.1 提取样本 → target-ready/target-pending（视动作表状态）+ fingerprint 命中", () => {
  if (!posCopy) throw sampleSkip();
  const r = runCli(PATCHER, ["check", "--bundle", posCopy]);
  const v = verdictOf(r);
  must(v === "target-ready" || v === "target-pending", "verdict=" + v);
  must(r.status === (v === "target-ready" ? 0 : 5), "exit=" + r.status + " 与 verdict=" + v + " 不一致");
  must(String(r.stdout).includes("fingerprint=" + BAD_ID), "fingerprint 未命中注册表");
  return "verdict=" + v + " exit=" + r.status;
});

t("T4", "全链 harness（条件委托 spawn，缺席=SKIP 非 RED）", () => {
  if (!fs.existsSync(HARNESS)) throw new Skip("test/harness.mjs 缺席（后续交付；在位即自动激活）");
  const r = runCli(HARNESS, [], 600000);
  must(r.status === 0, "harness exit=" + r.status + " " + outOf(r).slice(0, 400));
  return "harness 汇总全绿";
});

t("T5", "patch --dry-run → 计划打印（含 span 与上下文摘录）、零写盘", () => {
  const text = "function alpha(a){return a+1;}\nvar z=2;\n";
  const bundle = path.join(ROOT, "t5.cjs");
  fs.writeFileSync(bundle, text);
  const ins = text.indexOf("{") + 1; // 体首（typed function_body: head_len=18 含 '{'）
  const builds = [buildEntry("syn-t5", "0.0.1", Buffer.byteLength(text), sha256Hex(Buffer.from(text)), "target-ready")];
  const actions = [actionEntry({
    id: "t5-e1",
    target_build: "syn-t5",
    anchor: "function alpha(a){",
    spec: { type: "function_body", head_len: 18, mode: "body_start" },
    kind: "insert",
    payload: "return;",
    verify: [
      "span_post: bytes at [insert_point, insert_point+7) == 'return;' (exact new-byte string)",
      "boundary_post: byte at insert_point-1 == '{' (insert strictly at body start)",
    ],
    span: [ins, ins],
    note: "dry-run fixture（typed function_body，顺带覆盖状态机扫描路径）",
  })];
  const td = mkTableDir("t5", builds, actions);
  const bak = path.join(ROOT, "t5-bak");
  const r = runCli(path.join(td, "patcher.mjs"), ["patch", "--dry-run", "--bundle", bundle, "--backup-dir", bak]);
  must(r.status === 0, "exit=" + r.status + " " + outOf(r).slice(0, 400));
  must(/dry-run=true/.test(String(r.stdout)), "缺 dry-run 标记");
  must(String(r.stdout).includes("span=[" + ins + "," + ins + ")"), "缺计划 span 行");
  must(String(r.stdout).includes("ctx="), "缺上下文摘录");
  must(shaFile(bundle) === sha256Hex(Buffer.from(text)), "dry-run 落盘了");
  must(!fs.existsSync(bak), "dry-run 却创建备份目录");
  return "计划含 span=[" + ins + "," + ins + ")，零写盘";
});

t("T6", "幂等：marker 命中再 patch → 判定序第 0 步 already-patched no-op", () => {
  const b = path.join(ROOT, "t6.cjs");
  fs.writeFileSync(b, "var q=1; /*zbpatch:v1*/\n");
  const before = shaFile(b);
  const bak = path.join(ROOT, "t6-bak");
  const r = runCli(PATCHER, ["patch", "--bundle", b, "--backup-dir", bak]);
  must(r.status === 0, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(verdictOf(r) === "already-patched", "verdict=" + verdictOf(r));
  must(shaFile(b) === before, "marker 命中却写盘");
  must(!fs.existsSync(bak), "no-op 却创建备份目录");
  return "exit=0 already-patched no-op";
});

t("T7", "restore 全链五步（合成表置换：patch → restore 字节级复原 → already-restored）", () => {
  const text = "function beta(a){return a+1;}\n";
  const bundle = path.join(ROOT, "t7.cjs");
  fs.writeFileSync(bundle, text);
  const a0 = text.indexOf("return a+1;");
  const span = [a0, a0 + "return a+1;".length];
  const patchedText = "function beta(a){return a;}\n";
  const builds = [buildEntry("syn-t7", "0.0.2", Buffer.byteLength(text), sha256Hex(Buffer.from(text)), "target-ready")];
  const actions = [actionEntry({
    id: "t7-e1",
    target_build: "syn-t7",
    anchor: "return a+1;",
    spec: { type: "anchor" },
    kind: "replace",
    payload: "return a;",
    verify: [
      "span_post: bytes at [span.start, span.start+9) == 'return a;' (exact new-byte string)",
      "anchor_global_post: count of 'return a+1;' in patched file == 0",
    ],
    span,
  })];
  const td = mkTableDir("t7", builds, actions);
  const bak = path.join(ROOT, "t7-bak");
  let r = runCli(path.join(td, "patcher.mjs"), ["patch", "--bundle", bundle, "--backup-dir", bak]);
  must(r.status === 0, "patch exit=" + r.status + " " + outOf(r).slice(0, 400));
  must(fs.readFileSync(bundle, "latin1") === patchedText, "patch 产物不符");
  const mPath = path.join(bak, "manifest.json");
  must(fs.existsSync(mPath), "manifest 缺失");
  const man = JSON.parse(fs.readFileSync(mPath, "utf8"));
  must(man.sha256_orig && man.sha256_patched && man.backup_path && man.bundle_path && Array.isArray(man.patch_spans) && man.patch_spans.length === 1 && man.patch_spans[0].original === "return a+1;", "manifest 字段不全（全集/原字节全录）");
  r = runCli(PATCHER, ["restore", "--bundle", bundle, "--backup-dir", bak]);
  must(r.status === 0, "restore exit=" + r.status + " " + outOf(r).slice(0, 400));
  must(String(r.stdout).includes("sha256_patched="), "缺输出性对照（sha256_patched 提示）");
  must(shaFile(bundle) === sha256Hex(Buffer.from(text)), "restore 后 sha256 != 原件（字节级复原失守）");
  r = runCli(PATCHER, ["restore", "--bundle", bundle, "--backup-dir", bak]);
  must(r.status === 0 && verdictOf(r) === "already-restored", "二次 restore exit=" + r.status + " verdict=" + verdictOf(r));
  return "五步过 + sha256==原件 + sha256_patched 对照 + already-restored no-op";
});

t("T8a", "无锚小文件 → anchors-lost exit 3", () => {
  const b = path.join(ROOT, "t8a.txt");
  fs.writeFileSync(b, "hello world this is not a bundle at all. ".repeat(3));
  const r = runCli(PATCHER, ["check", "--bundle", b]);
  must(r.status === 3, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(verdictOf(r) === "anchors-lost", "verdict=" + verdictOf(r));
  return "exit=3 verdict=anchors-lost";
});

t("T8b", "好版拷贝 +1 字节落文件尾 → 门未命中、11/11≥8 → fingerprint-unknown exit 2", () => {
  if (!goodCopy) throw sampleSkip();
  const b = path.join(ROOT, "t8b.cjs");
  fs.copyFileSync(goodCopy, b);
  fs.appendFileSync(b, "X"); // +1 字节落尾（勿插锚字面中间，否则锚计数被破坏、用例自失效）
  const r = runCli(PATCHER, ["check", "--bundle", b]);
  must(r.status === 2, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(verdictOf(r) === "fingerprint-unknown", "verdict=" + verdictOf(r));
  must(/fingerprint=anchors=11\/11/.test(String(r.stdout)), "context 锚计数应 11/11");
  return "exit=2 fingerprint-unknown（anchors=11/11）";
});

t("T9", "零网络双断言：import 面 0 + 用法面 0 + child_process 唯一合法点", () => {
  const src = fs.readFileSync(PATCHER, "utf8");
  const importFaces = [
    /(?:import|require)\s*\(\s*["'](node:)?(?:http|https|net|tls|dns|undici|axios)["']/,
    /\bfrom\s*["'](node:)?(?:http|https|net|tls|dns|undici|axios)["']/,
  ];
  const usageFaces = [
    /\bfetch\s*\(/,
    /\bhttps?\s*\.\s*(?:request|get)\b/,
    /\bnet\s*\.\s*(?:connect|createConnection)\b/,
    /\btls\s*\.\s*(?:connect|createServer)\b/,
    /\bdns\s*\.\s*(?:lookup|resolve)/,
  ];
  for (const re of importFaces) must(!re.test(src), "import 面命中: " + re);
  for (const re of usageFaces) must(!re.test(src), "用法面命中: " + re);
  must(src.includes("node:child_process"), "child_process import 缺失");
  const calls = src.match(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g) || [];
  must(calls.length === 1, "进程创建调用点=" + calls.length + "（须唯一）");
  must(/spawn\s*\(\s*process\.execPath\s*,\s*\[\s*["']--check/.test(src), "唯一调用点非 spawn(process.execPath, ['--check', …])");
  return "import 面 0 + 用法面 0 + 唯一合法点 x1（3 子断言全过）";
});

t("T11", "target-pending 空窗 → exit 5（在册构建 + 动作条目空，表缺席=按空表）", () => {
  if (!posCopy) throw sampleSkip();
  const builds = [buildEntry(BAD_ID, "0.17.1", BAD_SIZE, BAD_SHA, "target-ready")];
  const td = mkTableDir("t11", builds); // 无 actions.json
  const bak = path.join(ROOT, "t11-bak");
  const before = shaFile(posCopy);
  const r = runCli(path.join(td, "patcher.mjs"), ["patch", "--bundle", posCopy, "--backup-dir", bak]);
  must(r.status === 5, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(verdictOf(r) === "target-pending", "verdict=" + verdictOf(r));
  must(shaFile(posCopy) === before, "pending 却写盘");
  must(!fs.existsSync(bak), "pending 却创建备份目录");
  return "exit=5 target-pending（推导态）零写盘";
});

t("T12a", "表损坏：builds.json 截断 → exit 4", () => {
  const b = path.join(ROOT, "t12a.cjs");
  fs.writeFileSync(b, "hello");
  const td = mkTableDir("t12a", '[{"build_id":"syn-t12"');
  const r = runCli(path.join(td, "patcher.mjs"), ["check", "--bundle", b]);
  must(r.status === 4, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  return "exit=4（解析失败拒执行）";
});

t("T12b", "表损坏：builds.json 字段缺失 → exit 4", () => {
  const b = path.join(ROOT, "t12b.cjs");
  fs.writeFileSync(b, "hello");
  const td = mkTableDir("t12b", JSON.stringify([{ build_id: "syn-t12", size: 5 }]));
  const r = runCli(path.join(td, "patcher.mjs"), ["check", "--bundle", b]);
  must(r.status === 4, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  return "exit=4（schema 校验拒）";
});

t("T12c", "表损坏：actions.json 截断 / 字段缺失 → exit 4", () => {
  const b = path.join(ROOT, "t12c.cjs");
  fs.writeFileSync(b, "hello");
  const builds = [buildEntry("syn-t12", "0.0.0", 5, sha256Hex(Buffer.from("hello")), "target-ready")];
  const tdA = mkTableDir("t12c-a", builds, '[{"id":"x"');
  let r = runCli(path.join(tdA, "patcher.mjs"), ["check", "--bundle", b]);
  must(r.status === 4, "截断 exit=" + r.status + " " + outOf(r).slice(0, 300));
  const badEntry = { id: "x", target_build: "syn-t12", anchor: { literal: "h", expect_count: 1, role: "locate" }, locate: { window: null, boundary_spec: { type: "anchor" } }, apply: { kind: "replace", payload: "H" }, verify: ["a", "b"], span: [0, 1] };
  const tdB = mkTableDir("t12c-b", builds, JSON.stringify([badEntry])); // 缺 rollback/evidence
  r = runCli(path.join(tdB, "patcher.mjs"), ["check", "--bundle", b]);
  must(r.status === 4, "字段缺失 exit=" + r.status + " " + outOf(r).slice(0, 300));
  return "exit=4 x2（截断 + 字段缺失）";
});

t("T13", "restore 目标错指（--bundle 指好版拷贝 + 0.17.1 备份）→ 路径校验拒、好版零字节变化", () => {
  if (!goodCopy || !posCopy) throw sampleSkip();
  const bak = path.join(ROOT, "t13-bak");
  fs.mkdirSync(bak, { recursive: true });
  const backupBin = path.join(bak, "backup.bin");
  fs.copyFileSync(POS_SRC, backupBin); // 0.17.1 原件字节作备份（只读拷贝）
  const manifest = {
    bundle_path: posCopy,
    sha256_orig: BAD_SHA,
    size_orig: BAD_SIZE,
    backup_path: backupBin,
    patch_spans: [],
    actions_applied: [],
    sha256_patched: "f".repeat(64),
    size_patched: 1,
    tool_version: "0.1.0",
    created: "2026-10-30T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(bak, "manifest.json"), JSON.stringify(manifest));
  const before = shaFile(goodCopy);
  const r = runCli(PATCHER, ["restore", "--bundle", goodCopy, "--backup-dir", bak]);
  must(r.status === 4, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(outOf(r).includes("路径校验失败"), "缺路径校验拒绝语（③ 无逃生口）");
  must(shaFile(goodCopy) === before, "错指场景好版被改（③先于④兜底失守）");
  return "③ 拒绝 exit=4 + 好版零字节变化";
});

t("T14", "span 相交 → 预检 exit 4（零长点内含）；端点相邻 → 合法 patch（prose 形态）", () => {
  // (a) 相交：replace [0,13) × insert [11,11)（零长点严格内含 = 相交）
  const textA = "function f(){return 1;}\n";
  const bA = path.join(ROOT, "t14a.cjs");
  fs.writeFileSync(bA, textA);
  const buildsA = [buildEntry("syn-t14", "0.0.3", Buffer.byteLength(textA), sha256Hex(Buffer.from(textA)), "target-ready")];
  const actionsA = [
    actionEntry({
      id: "t14-e1", target_build: "syn-t14", anchor: "function f(){",
      spec: { type: "anchor" }, kind: "replace", payload: "function g(){}",
      verify: [
        "span_post: bytes at [span.start, span.start+14) == 'function g(){}' (exact new-byte string)",
        "anchor_global_post: count of 'function f(){' in patched file == 0",
      ],
      span: [0, 13],
    }),
    actionEntry({
      id: "t14-e2", target_build: "syn-t14", anchor: "function f(){",
      spec: { type: "body_start", prefix: "function f(" }, kind: "insert", payload: "X;",
      verify: [
        "span_post: bytes at [insert_point, insert_point+2) == 'X;' (exact new-byte string)",
        "anchor_global_post: count of 'function f(){' in patched file == 1",
      ],
      span: [11, 11],
    }),
  ];
  const tdA = mkTableDir("t14a", buildsA, actionsA);
  let r = runCli(path.join(tdA, "patcher.mjs"), ["patch", "--bundle", bA, "--backup-dir", path.join(ROOT, "t14a-bak")]);
  must(r.status === 4, "(a) exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(outOf(r).includes("span 相交"), "(a) 缺相交拒绝语");
  must(shaFile(bA) === sha256Hex(Buffer.from(textA)), "(a) 相交却写盘");
  // (b) 端点相邻（prose boundary_spec + 结构断言）→ patch 成功
  const textB = "var x2=2;var y3=3;\n";
  const bB = path.join(ROOT, "t14b.cjs");
  fs.writeFileSync(bB, textB);
  const buildsB = [buildEntry("syn-t14b", "0.0.4", Buffer.byteLength(textB), sha256Hex(Buffer.from(textB)), "target-ready")];
  const actionsB = [
    actionEntry({
      id: "t14b-e1", target_build: "syn-t14b", anchor: "x2=2",
      spec: "span = the full anchor string (prose form; registered span is the runtime span; audit doc)",
      kind: "replace", payload: "z4=4",
      verify: [
        "span_post: bytes at [span.start, span.start+4) == 'z4=4' (exact new-byte string)",
        "anchor_global_post: count of 'x2=2' in patched file == 0",
      ],
      span: [4, 8],
      note: "相邻对左（端点 8 相接，半开区间相邻合法）",
    }),
    actionEntry({
      id: "t14b-e2", target_build: "syn-t14b", anchor: ";var ",
      spec: "span = the full anchor string (prose form)",
      kind: "replace", payload: ";let ",
      verify: [
        "span_post: bytes at [span.start, span.start+5) == ';let ' (exact new-byte string)",
        "anchor_global_post: count of ';var ' in patched file == 0",
      ],
      span: [8, 13],
      note: "相邻对右",
    }),
  ];
  const tdB = mkTableDir("t14b", buildsB, actionsB);
  r = runCli(path.join(tdB, "patcher.mjs"), ["patch", "--bundle", bB, "--backup-dir", path.join(ROOT, "t14b-bak")]);
  must(r.status === 0, "(b) exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(fs.readFileSync(bB, "latin1") === "var z4=4;let y3=3;\n", "(b) 产物不符");
  return "(a) exit=4 零写盘；(b) 端点相邻合法（prose 形态+结构断言+校验④）";
});

t("T15", "--force 诊断 → 逐锚 expect/actual + 请修表 + exit 6 永不 patch（无 force → exit 3）", () => {
  if (!posCopy) throw sampleSkip();
  const builds = [buildEntry(BAD_ID, "0.17.1", BAD_SIZE, BAD_SHA, "target-ready")];
  const actions = [{
    id: "t15-bad",
    target_build: BAD_ID,
    anchor: { literal: "foldRemindersIntoToolResults:e===", expect_count: 2, role: "locate" }, // 人为算错 expect_count
    locate: { window: null, boundary_spec: { type: "anchor" } },
    apply: { kind: "replace", payload: "X" },
    verify: ["a", "b"],
    rollback: "n/a",
    span: [4116830, 4116863],
    evidence: { note: "T15 fixture：人为算错 expect_count（纯数据构造）" },
  }];
  const td = mkTableDir("t15", builds, actions);
  const bak = path.join(ROOT, "t15-bak");
  const before = shaFile(posCopy);
  let r = runCli(path.join(td, "patcher.mjs"), ["patch", "--force", "--bundle", posCopy, "--backup-dir", bak]);
  must(r.status === 6, "force exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(String(r.stdout).includes("expect=2") && String(r.stdout).includes("actual=1"), "缺逐锚 expect/actual 诊断");
  must(String(r.stdout).includes("请修表"), "缺「表 bug，请修表」提示");
  must(shaFile(posCopy) === before, "--force 放行了写入（失守）");
  r = runCli(path.join(td, "patcher.mjs"), ["patch", "--bundle", posCopy, "--backup-dir", bak]);
  must(r.status === 3, "无 force exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(shaFile(posCopy) === before, "无 force 却写盘");
  return "force exit=6 诊断齐全零写盘；无 force exit=3";
});

t("T-BKP", "备份失败（--backup-dir 为既有文件）→ 中止拒写 exit 4", () => {
  const text = "function gamma(a){return a+1;}\n";
  const b = path.join(ROOT, "tbkp.cjs");
  fs.writeFileSync(b, text);
  const a0 = text.indexOf("return a+1;");
  const builds = [buildEntry("syn-tbkp", "0.0.5", Buffer.byteLength(text), sha256Hex(Buffer.from(text)), "target-ready")];
  const actions = [actionEntry({
    id: "tbkp-e1", target_build: "syn-tbkp", anchor: "return a+1;",
    spec: { type: "anchor" }, kind: "replace", payload: "return a;",
    verify: [
      "span_post: bytes at [span.start, span.start+9) == 'return a;' (exact new-byte string)",
      "anchor_global_post: count of 'return a+1;' in patched file == 0",
    ],
    span: [a0, a0 + 11],
  })];
  const td = mkTableDir("tbkp", builds, actions);
  const blocker = path.join(ROOT, "tbkp-blocker.file");
  fs.writeFileSync(blocker, "not a dir"); // 备份目录位被文件占据 → mkdir/写必败（Windows 确定构造）
  const before = shaFile(b);
  const r = runCli(path.join(td, "patcher.mjs"), ["patch", "--bundle", b, "--backup-dir", blocker]);
  must(r.status === 4, "exit=" + r.status + " " + outOf(r).slice(0, 300));
  must(outOf(r).includes("备份失败"), "缺备份失败拒绝语");
  must(shaFile(b) === before, "备份失败仍写盘（强制备份失守）");
  return "中止拒写 exit=4，bundle 零变化";
});

t("T16", "多 span 非零位移：校验④ span 相对断言按位移后坐标求值（回归钉）", () => {
  const text = "function a(){return 1;}\nfunction b(){return 2;}\nfunction c(){return 3;}\n";
  const b16 = path.join(ROOT, "t16.cjs");
  fs.writeFileSync(b16, text);
  const sB = text.indexOf("return 2;"); // 37
  const sC = text.indexOf("return 3;"); // 61
  const builds = [buildEntry("syn-t16", "0.0.6", Buffer.byteLength(text), sha256Hex(Buffer.from(text)), "target-ready")];
  const actions = [
    actionEntry({
      id: "t16-e1", target_build: "syn-t16", anchor: "function a(){",
      spec: { type: "body_start", prefix: "function a(){" }, kind: "insert", payload: "return 0;",
      verify: [
        "span_post: bytes at [insert_point, insert_point+9) == 'return 0;' (exact new-byte string)",
        "boundary_post: byte at insert_point-1 == '{'",
      ],
      span: [13, 13],
      note: "位移源 +23（payload 9 + marker 注释 14）",
    }),
    actionEntry({
      id: "t16-e2", target_build: "syn-t16", anchor: "return 2;",
      spec: { type: "anchor" }, kind: "replace", payload: "return;",
      verify: [
        "span_post: bytes at [span.start, span.start+7) == 'return;' (exact new-byte string)",
        "anchor_global_post: count of 'return 2;' in patched file == 0",
      ],
      span: [sB, sB + 9],
      note: "受 e1 位移 +23；自身 −2",
    }),
    actionEntry({
      id: "t16-e3", target_build: "syn-t16", anchor: "return 3;",
      spec: { type: "anchor" }, kind: "replace", payload: "return 42;",
      verify: [
        "span_post: bytes at [span.start, span.start+10) == 'return 42;' (exact new-byte string)",
        "anchor_global_post: count of 'return 3;' in patched file == 0",
      ],
      span: [sC, sC + 9],
      note: "复合位移 原+23−2=+21：输出坐标≠登记坐标，按登记坐标切缓冲必误读（旧缺陷路径）",
    }),
  ];
  const td = mkTableDir("t16", builds, actions);
  const bak = path.join(ROOT, "t16-bak");
  const r = runCli(path.join(td, "patcher.mjs"), ["patch", "--bundle", b16, "--backup-dir", bak]);
  must(r.status === 0, "exit=" + r.status + " " + outOf(r).slice(0, 400));
  const want = "function a(){return 0;/*zbpatch:v1*/return 1;}\nfunction b(){return;}\nfunction c(){return 42;}\n";
  must(fs.readFileSync(b16, "latin1") === want, "产物字节不符");
  return "三 span 位移 +23/−2/复合+21：校验④按位移后坐标全过，产物字节精确";
});

t("T10", "活体安全：套件首尾活体 sha256 不变（read-only 哨兵）", () => {
  if (sentStart === null) throw new Skip("活体缺席或对拍未过（N4 显式标注）: " + GOOD_SRC);
  const end = shaFile(GOOD_SRC); // 套件尾（本用例注册于末位）
  must(end !== null && end === sentStart, "活体 sha256 首尾不一致");
  return "活体哨兵首尾一致（全程只读）";
});

// ---------- 机械断言（计数化 meta） ----------
function metaChecks() {
  const nodeCheck = spawnSync(process.execPath, ["--check", PATCHER]).status === 0;
  let buildsDual = "0/2";
  try {
    const arr = JSON.parse(fs.readFileSync(BUILDS_JSON, "utf8"));
    let n = 0;
    for (const b of arr) {
      if (b.build_id === GOOD_ID && b.size === GOOD_SIZE && b.sha256 === GOOD_SHA && b.verdict === "good-negative") n += 1;
      if (b.build_id === BAD_ID && b.size === BAD_SIZE && b.sha256 === BAD_SHA && b.verdict === "target-ready") n += 1;
    }
    buildsDual = n + "/2";
  } catch (err) { /* 保持 0/2 */ }
  return { node_check: nodeCheck ? "pass" : "FAIL", builds_dual_track: buildsDual };
}

// ---------- 汇总主流程 ----------
async function main() {
  const argv = process.argv.slice(2);
  let outPath = null;
  const oi = argv.indexOf("--out");
  if (oi >= 0 && argv[oi + 1]) outPath = argv[oi + 1];
  console.log("zbpatch test suite（20 用例项）workdir=" + ROOT);
  for (const c of CASES) {
    let status = "pass";
    let note = "";
    try {
      note = (await c.fn()) || "";
    } catch (err) {
      if (err instanceof Skip) {
        status = "skip";
        note = err.message;
      } else {
        status = "fail";
        note = String(err && err.message ? err.message : err);
      }
    }
    results.push({ id: c.id, name: c.name, status, note });
    console.log("[" + status.toUpperCase() + "] " + c.id + " " + c.name + (note ? " -- " + note : ""));
  }
  const meta = metaChecks();
  const passed = results.filter((x) => x.status === "pass").length;
  const failed = results.filter((x) => x.status === "fail").length;
  const skipped = results.filter((x) => x.status === "skip").length;
  console.log("SUMMARY total=" + results.length + " passed=" + passed + " failed=" + failed + " skipped=" + skipped);
  console.log("META node-check=" + meta.node_check + " builds-dual-track=" + meta.builds_dual_track + (sampleNote.length ? " sample-warn=" + sampleNote.join(";") : ""));
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ meta, summary: { total: results.length, passed, failed, skipped }, cases: results }, null, 2));
    console.log("results=" + outPath);
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (err) { /* 用后即弃，失败不掩盖结果 */ }
  process.exit(failed > 0 ? 1 : 0);
}

main();
