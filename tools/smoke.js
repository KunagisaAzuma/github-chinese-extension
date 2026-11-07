/**
 * smoke.js — 端到端冒烟测试（真实加载扩展）
 *
 * 关键点：Chrome 137+ 移除了 --load-extension 的默认效力，必须配合
 *   --disable-features=DisableLoadExtensionCommandLineSwitch
 * 才能让命令行装扩展生效。本脚本会验证扩展的 service worker 是否注册成功，
 * 再打开 GitHub 页面，从主世界读 DOM（内容脚本在隔离世界，只能通过 DOM 观察效果）。
 *
 * 用法： node tools/smoke.js [url...]
 * 产物： tools/_smoke-report.txt
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');
const REPORT = path.join(TOOLS, '_smoke-report.txt');
const STDERR = path.join(TOOLS, '_smoke-stderr.txt');
const PROFILE = path.join(TOOLS, '_smoke-profile');

const URLS = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['https://github.com/', 'https://github.com/explore', 'https://github.com/login'];

const PORT = 9333;

const CHROME = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const out = [];
function log(l) {
    out.push(String(l));
    try {
        fs.writeFileSync(REPORT, out.join('\n') + '\n', 'utf8');
    } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rmrf(p) {
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return;
        } catch (_) {}
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
    send(method, params = {}, timeout = 40000) {
        const id = ++this.id;
        return new Promise((res, rej) => {
            this.pending.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
        });
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

const PROBE = `(() => {
    const de = document.documentElement;
    const txt = document.body ? document.body.innerText : '';
    return JSON.stringify({
        url: location.href,
        title: document.title,
        active: de.getAttribute('data-ghcn-active'),
        lang: de.getAttribute('lang'),
        hasPrimaryVar: !!getComputedStyle(de).getPropertyValue('--ghc-primary-color').trim(),
        styleTags: document.querySelectorAll('style').length,
        bodyLen: txt.length,
        sample: txt.slice(0, 900)
    });
})()`;

const ZH = ['代码', '拉取请求', '议题', '市场', '探索', '仓库', '趋势', '定价', '赞助', '登录', '注册', '团队', '企业', '搜索', '文档', '博客', '关于', '服务', '社区'];

async function main() {
    log(`stage=start node=${process.version}`);
    if (!CHROME) return log('RESULT=NO_CHROME');
    log(`browser=${CHROME}`);
    log(`extension=${ROOT}`);

    const mf = path.join(ROOT, 'manifest.json');
    if (!fs.existsSync(mf)) return log('RESULT=NO_MANIFEST');
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    log(`manifest_version=${manifest.manifest_version} version=${manifest.version}`);
    log(`scripts=${manifest.content_scripts[0].js.join(' -> ')} @ ${manifest.content_scripts[0].run_at}`);

    rmrf(PROFILE);
    const errFd = fs.openSync(STDERR, 'w');
    const child = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-features=DisableLoadExtensionCommandLineSwitch,Translate,MediaRouter',
        `--user-data-dir=${PROFILE}`,
        `--load-extension=${ROOT}`,
        `--disable-extensions-except=${ROOT}`,
        `--remote-debugging-port=${PORT}`,
        'about:blank',
    ], { stdio: ['ignore', 'ignore', errFd] });
    const pid = child.pid;
    log(`stage=spawned chrome_pid=${pid}`);

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
        const { targetInfos = [] } = await browser.send('Target.getTargets');
        const ext = targetInfos.filter((t) => String(t.url || '').startsWith('chrome-extension://'));
        log(`extension_targets=${ext.length}`);
        ext.forEach((t) => log(`  target type=${t.type} url=${t.url}`));
        const ours = ext.some((t) => /\/background\.js/.test(t.url));
        log(`our_service_worker_loaded=${ours}`);

        let anyActive = false;
        for (const url of URLS) {
            const t = await getJSON(`/json/new?${encodeURIComponent(url)}`, 'PUT');
            if (!t || !t.webSocketDebuggerUrl) { log(`page ${url} -> NO_TARGET`); continue; }
            page = await CDP.connect(t.webSocketDebuggerUrl);
            await page.send('Page.enable');
            await page.send('Runtime.enable');
            await sleep(7000);

            const r = await page.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
            if (r.exceptionDetails) { log(`page ${url} -> EVAL_THREW`); }
            else {
                let info;
                try { info = JSON.parse(r.result.value); } catch (_) { info = null; }
                if (!info) log(`page ${url} -> BAD_JSON`);
                else {
                    const hits = ZH.filter((w) => info.sample.includes(w));
                    log(`--- ${url}`);
                    log(`   active=${info.active} lang=${info.lang} primaryVar=${info.hasPrimaryVar} styleTags=${info.styleTags} bodyLen=${info.bodyLen}`);
                    log(`   title=${info.title}`);
                    log(`   chinese_hits=${hits.length} [${hits.join(',')}]`);
                    log(`   sample=${info.sample.replace(/\s+/g, ' ').slice(0, 260)}`);
                    if (info.active === '1') anyActive = true;
                }
            }
            page.close();
            page = null;
        }

        log(`RESULT=${anyActive ? 'ACTIVE' : 'NOT_ACTIVE'}`);
    } finally {
        if (page) page.close();
        if (browser) browser.close();
        killTree(pid);
        try { fs.closeSync(errFd); } catch (_) {}
        log('stage=cleaned');
    }
}

main().catch((e) => log('RESULT=ERROR\n' + (e && e.stack ? e.stack : e)));
