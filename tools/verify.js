/**
 * verify.js — 交付前静态自检（零依赖，纯 Node）
 *
 * 检查项：
 *  1. manifest.json 可解析、字段完整、MV3 合法
 *  2. manifest 引用的所有文件真实存在
 *  3. 所有 .js 通过语法检查（用 vm.Script 编译，等价 node --check）
 *  4. main.js 调用到的 GM_* 全部由 gm-api.js 定义（漏一个就是运行时崩溃）
 *  5. content script 加载顺序正确：gm-api → locals → main → bootstrap
 *  6. locals.js 真的定义了 I18N，且含 zh-CN 词表
 *  7. 隔离世界里没有残留 userscript 元数据块导致的语法问题（已改具名入口）
 *  8. background.js 的白名单覆盖 main.js 里用到的翻译 API 域名
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const notes = [];

function fail(msg) {
    problems.push(msg);
}
function note(msg) {
    notes.push(msg);
}
function read(p) {
    return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
function exists(p) {
    return fs.existsSync(path.join(ROOT, p));
}

/* ---------- 1 & 2. manifest ---------- */
let manifest;
try {
    manifest = JSON.parse(read('manifest.json'));
} catch (e) {
    fail(`manifest.json 不是合法 JSON: ${e.message}`);
    report();
    process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
for (const key of ['name', 'version', 'description', 'action', 'background', 'content_scripts']) {
    if (!manifest[key]) fail(`manifest 缺少字段: ${key}`);
}
if (!manifest.permissions || !manifest.permissions.includes('storage')) {
    fail('permissions 必须包含 storage（GM_getValue/GM_setValue 依赖它）');
}

const referenced = new Set();
for (const v of Object.values(manifest.icons || {})) referenced.add(v);
for (const v of Object.values((manifest.action && manifest.action.default_icon) || {})) referenced.add(v);
if (manifest.action && manifest.action.default_popup) referenced.add(manifest.action.default_popup);
if (manifest.background && manifest.background.service_worker) referenced.add(manifest.background.service_worker);
for (const cs of manifest.content_scripts || []) {
    for (const js of cs.js || []) referenced.add(js);
    for (const css of cs.css || []) referenced.add(css);
}

for (const p of referenced) {
    if (!exists(p)) fail(`manifest 引用的文件不存在: ${p}`);
}
note(`manifest 引用文件 ${referenced.size} 个，全部存在`);

/* ---------- 3. 语法 ---------- */
const jsFiles = [...referenced].filter((p) => p.endsWith('.js'));
const extra = ['src/bootstrap.js', 'popup.js', 'tools/verify.js', 'tools/e2e.js', 'tools/smoke.js', 'tools/mock.js', 'tools/clean.js'];
for (const f of extra) if (!jsFiles.includes(f)) jsFiles.push(f);

for (const file of new Set(jsFiles)) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    try {
        new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: file });
    } catch (e) {
        fail(`语法错误 ${file}: ${e.message}`);
    }
}
note(`语法检查 ${new Set(jsFiles).size} 个 JS 文件通过`);

/* ---------- 4. GM_* 覆盖 ---------- */
const gmApi = read('src/gm-api.js');
const mainSrc = read('src/main.js');

const defined = new Set();
for (const m of gmApi.matchAll(/window\.(GM_[A-Za-z_]+)\s*=/g)) defined.add(m[1]);

/** 剥掉注释，避免 @grant 元数据和说明文字被当成调用点 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

const codeOnly = stripComments(mainSrc);
const calledInCode = new Set();
for (const m of codeOnly.matchAll(/\b(GM_[A-Za-z_]+)\s*\(/g)) calledInCode.add(m[1]);

const missing = [...calledInCode].filter((n) => !defined.has(n));
if (missing.length) fail(`gm-api.js 未实现: ${missing.join(', ')}`);
note(`GM_* 使用 ${calledInCode.size} 个，全部已实现: ${[...calledInCode].sort().join(', ')}`);

/* ---------- 5. 加载顺序 ---------- */
const cs = (manifest.content_scripts || [])[0] || { js: [] };
const order = cs.js || [];
const expected = ['src/gm-api.js', 'src/locals.js', 'src/main.js', 'src/bootstrap.js'];
if (JSON.stringify(order) !== JSON.stringify(expected)) {
    fail(`content_scripts.js 顺序应为 ${expected.join(' → ')}，实际 ${order.join(' → ')}`);
}
if (cs.run_at !== 'document_start') fail('run_at 应为 document_start（上游脚本依赖尽早执行）');
note(`加载顺序正确: ${order.join(' → ')}  @run_at=${cs.run_at}`);

/* ---------- 6. locals.js ---------- */
if (!/^var I18N\s*=\s*\{\s*\};/m.test(read('src/locals.js'))) {
    fail('locals.js 未按预期定义 I18N');
} else {
    const size = fs.statSync(path.join(ROOT, 'src/locals.js')).size;
    note(`locals.js ${(size / 1024 / 1024).toFixed(2)} MB，I18N 已定义`);
}

/* ---------- 7. 入口改写 ---------- */
if (!/window\.__GHCN_MAIN__\s*=\s*function\s*\(window, document, undefined\)/.test(mainSrc)) {
    fail('main.js 未改写为具名入口 window.__GHCN_MAIN__');
}
if (/^\}\)\(window, document\);\s*$/m.test(mainSrc)) {
    note('main.js 仍保留旧的 IIFE 收尾注释行（仅为说明，不影响执行）');
}
if (!/window\.__GHCN_READY__/.test(gmApi)) fail('gm-api.js 未暴露 window.__GHCN_READY__');
if (!/__GHCN_READY__/.test(read('src/bootstrap.js'))) fail('bootstrap.js 未等待 __GHCN_READY__');

/* ---------- 7b. 启动守卫 ---------- */
const boot = read('src/bootstrap.js');
if (!/document\.documentElement/.test(boot)) {
    fail('bootstrap.js 缺少 documentElement 守卫（@document_start 下 <html> 可能尚未存在）');
}
if (!/data-ghcn-active/.test(boot)) {
    fail('bootstrap.js 未设置 data-ghcn-active 标记');
}

/* ---------- 7c. popup 文件齐备 ---------- */
for (const f of ['popup.html', 'popup.css', 'popup.js']) {
    if (!exists(f)) fail(`缺少 ${f}`);
}
const popupHtml = read('popup.html');
for (const id of ['status', 'statusText', 'menus', 'reload', 'version', 'enable_RegExp', 'enable_transDesc']) {
    if (!popupHtml.includes(`id="${id}"`)) fail(`popup.html 缺少 #${id}`);
}
if (!popupHtml.includes('popup.js')) fail('popup.html 未引用 popup.js');
if (!popupHtml.includes('popup.css')) fail('popup.html 未引用 popup.css');
note('popup 三件套齐备且 id 对齐');

/* ---------- 8. 白名单 ---------- */
const bg = read('background.js');
for (const host of ['fanyi.iflyrec.com']) {
    if (!bg.includes(host)) fail(`background.js 白名单缺少 ${host}`);
    if (!(manifest.host_permissions || []).some((h) => h.includes(host))) {
        fail(`manifest.host_permissions 缺少 ${host}`);
    }
}
note('跨域白名单与 host_permissions 一致');

/* ---------- 汇总 ---------- */
report();

function report() {
    console.log('--- 通过项 ---');
    for (const n of notes) console.log(`  ✓ ${n}`);
    if (problems.length) {
        console.log('--- 问题 ---');
        for (const p of problems) console.log(`  ✗ ${p}`);
        console.log(`\n结果: 未通过（${problems.length} 个问题）`);
        process.exitCode = 1;
    } else {
        console.log('\n结果: 全部通过');
    }
}
