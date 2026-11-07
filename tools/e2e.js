/**
 * e2e.js — 内容脚本链路端到端验证（不依赖扩展装载机制）
 *
 * 思路：把扩展的四段 content script 按 manifest 顺序，用
 * Page.addScriptToEvaluateOnNewDocument 注入到真实 GitHub 页面，
 * 并在注入前先注入 tools/mock.js 模拟 chrome.storage / chrome.runtime。
 * 这样验证的是「脚本本身能不能把页面汉化」，与 Chrome 版本是否允许
 * 命令行装扩展无关。
 *
 * 与上一版的关键差异：**等 document.readyState === 'complete' 再取样**，
 * 否则 setupInitTrans() 还在等 DOMContentLoaded，取到的是未翻译的快照。
 *
 * 用法： node tools/e2e.js [url]
 * 产物： tools/_e2e-report.txt
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');
const REPORT = path.join(TOOLS, '_e2e-report.txt');
const STDERR = path.join(TOOLS, '_e2e-stderr.txt');
const PROFILE = path.join(TOOLS, '_e2e-profile');

const URLS = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        'https://github.com/explore',
        'https://github.com/',
        'https://github.com/login',
        'https://gist.github.com/',
    ];
const PORT = 9337;

const CHROME = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const out = [];
function log(l) {
    out.push(String(l));
    try { fs.writeFileSync(REPORT, out.join('\n') + '\n', 'utf8'); } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rmrf(p) {
    for (let i = 0; i < 5; i++) {
        try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return; } catch (_) {}
    }
}
function killTree(pid) {
    if (pid) try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
}
async function getJSON(p, m = 'GET') {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m });
    const t = await r.text();
    try { return JSON.parse(t); } catch (_) { return {}; }
}

class CDP {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map();
        ws.addEventListener('message', (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
            if (m.id && this.pending.has(m.id)) {
                const p = this.pending.get(m.id); this.pending.delete(m.id);
                m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
            }
        });
    }
    static connect(u) {
        return new Promise((res, rej) => {
            const ws = new WebSocket(u);
            ws.addEventListener('open', () => res(new CDP(ws)));
            ws.addEventListener('error', () => rej(new Error('ws fail')));
        });
    }
    send(method, params = {}, timeout = 45000) {
        const id = ++this.id;
        return new Promise((res, rej) => {
            this.pending.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
        });
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

function buildInjection() {
    const files = ['tools/mock.js', 'src/gm-api.js', 'src/locals.js', 'src/main.js', 'src/bootstrap.js'];
    const parts = [];
    for (const rel of files) {
        const abs = path.join(ROOT, rel.replace(/\//g, path.sep));
        if (!fs.existsSync(abs)) throw new Error('missing ' + rel);
        parts.push(`/* ==== ${rel} ==== */\n` + fs.readFileSync(abs, 'utf8'));
    }
    return parts.join('\n;\n');
}

const READY_PROBE = `(() => JSON.stringify({
    readyState: document.readyState,
    active: document.documentElement.getAttribute('data-ghcn-active'),
    lang: document.documentElement.getAttribute('lang'),
    hasMain: typeof window.__GHCN_MAIN__,
    errs: (window.__GHCN_SMOKE_ERRORS__ || []).slice(0, 5)
}))()`;

const FINAL_PROBE = `(() => {
    const de = document.documentElement;
    const txt = document.body ? document.body.innerText : '';
    const cs = getComputedStyle(de);
    const v1 = cs.getPropertyValue('--ghc-primary-color').trim();
    const v2 = cs.getPropertyValue('--color-canvas-default').trim();
    const ZH = ['代码','拉取请求','议题','市场','探索','仓库','趋势','定价','赞助','登录','注册','团队','企业','搜索','文档','博客','关于','公告','主题','精选'];
    const hit = ZH.filter(w => txt.includes(w));
    const EN = ['Explore','Topics','Trending','Collections','Events','Sponsors','Sign in','Sign up','Pull requests','Issues','Marketplace','Repositories','Search or jump to','Code','Documentation'];
    const stillEN = EN.filter(w => txt.includes(w));
    return JSON.stringify({
        readyState: document.readyState,
        active: de.getAttribute('data-ghcn-active'),
        lang: de.getAttribute('lang'),
        cssPrimary: v1,
        cssCanvas: v2,
        zhHits: hit.length,
        zhWords: hit,
        enHits: stillEN.length,
        enWords: stillEN,
        bodyLen: txt.length,
        sample: txt.replace(/\\s+/g, ' ').slice(0, 700),
        errs: (window.__GHCN_SMOKE_ERRORS__ || []).slice(0, 5)
    });
})()`;

async function main() {
    log(`=== e2e ${new Date().toISOString()} ===`);
    log(`node=${process.version}`);
    if (!CHROME) return log('RESULT=NO_CHROME');
    log(`browser=${CHROME}`);
    log(`urls=${URLS.join(' , ')}`);

    const inject = buildInjection();
    log(`inject_bytes=${Buffer.byteLength(inject)}`);

    rmrf(PROFILE);
    const errFd = fs.openSync(STDERR, 'w');
    const child = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter',
        `--user-data-dir=${PROFILE}`,
        `--remote-debugging-port=${PORT}`,
        'about:blank',
    ], { stdio: ['ignore', 'ignore', errFd] });
    const pid = child.pid;
    log(`chrome_pid=${pid}`);

    let browser = null, page = null;
    try {
        let v = null;
        for (let i = 0; i < 80; i++) {
            await sleep(400);
            try { v = await getJSON('/json/version'); if (v.webSocketDebuggerUrl) break; } catch (_) {}
        }
        if (!v) return log('RESULT=CDP_NOT_READY');
        log(`browser_product=${v.Browser}`);

        browser = await CDP.connect(v.webSocketDebuggerUrl);

        let pass = 0, fail = 0;
        for (const targetUrl of URLS) {
            log(`========================================`);
            log(`>>> ${targetUrl}`);
            const t = await getJSON(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
            if (!t || !t.webSocketDebuggerUrl) { log('   NO_TARGET'); fail++; continue; }
            page = await CDP.connect(t.webSocketDebuggerUrl);
            try {
                await page.send('Page.enable');
                await page.send('Runtime.enable');
                await page.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
                await page.send('Page.navigate', { url: targetUrl });

                // 等 document 真正完成加载
                let lastState = '';
                let completeAt = -1;
                for (let i = 0; i < 90; i++) {
                    await sleep(500);
                    try {
                        const r = await page.send('Runtime.evaluate', { expression: READY_PROBE, returnByValue: true });
                        const info = JSON.parse(r.result.value);
                        if (info.readyState !== lastState) {
                            log(`   tick ${i}: readyState=${info.readyState} active=${info.active} hasMain=${info.hasMain}`);
                            lastState = info.readyState;
                        }
                        if (info.readyState === 'complete') { completeAt = i; break; }
                    } catch (_) {}
                }
                log(`   readyState_complete_at_tick=${completeAt}`);

                // 再给 MutationObserver / 翻译一跑
                await sleep(4000);

                const r2 = await page.send('Runtime.evaluate', { expression: FINAL_PROBE, returnByValue: true });
                if (r2.exceptionDetails) {
                    log('   EVAL_THREW ' + JSON.stringify(r2.exceptionDetails).slice(0, 800));
                    fail++;
                } else {
                    const info = JSON.parse(r2.result.value);
                    log(`   readyState=${info.readyState} active=${info.active} lang=${info.lang}`);
                    log(`   cssPrimaryColor=${info.cssPrimary || '(空)'}`);
                    log(`   zhHits=${info.zhHits} [${(info.zhWords || []).join(',')}]`);
                    log(`   enHits=${info.enHits} [${(info.enWords || []).join(',')}]`);
                    log(`   bodyLen=${info.bodyLen}`);
                    log(`   errs=${JSON.stringify(info.errs)}`);
                    log(`   sample=${String(info.sample).slice(0, 400)}`);
                    const ok = info.active === '1' && info.zhHits > 0;
                    ok ? pass++ : fail++;
                    log(`   VERDICT=${ok ? 'PASS' : 'FAIL'}`);
                }
            } finally {
                page.close();
                page = null;
            }
        }

        log(`========================================`);
        log(`SUMMARY pass=${pass} fail=${fail} total=${URLS.length}`);
        log(`RESULT=${fail === 0 ? 'ALL_PASS' : 'HAS_FAIL'}`);
    } finally {
        if (page) page.close();
        if (browser) browser.close();
        killTree(pid);
        try { fs.closeSync(errFd); } catch (_) {}
        log('=== cleaned ===');
    }
}

main().catch((e) => log('RESULT=ERROR\n' + (e && e.stack ? e.stack : e)));
