/**
 * background.js — Service Worker
 *
 * 职责只有两件：
 *  1. 代内容脚本发跨域请求（GM_xmlhttpRequest 的替代实现），
 *     因为页面里的 fetch 会被 fanyi.iflyrec.com 的 CORS 拦住，
 *     而扩展的 host_permissions 允许后台直接抓。
 *  2. 首次安装时写入默认设置，避免内容脚本首帧读到空值。
 */

const EXT_NAME = 'GitHub 中文化插件';

const DEFAULTS = {
    enable_RegExp: true,
    enable_transDesc: true,
    enable_missedTerms: false,
    missedTerms: {},
};

chrome.runtime.onInstalled.addListener(async (details) => {
    try {
        const current = await chrome.storage.local.get(null);
        const patch = {};
        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (!(key in current)) patch[key] = value;
        }
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        if (details.reason === 'install') {
            console.log(`[${EXT_NAME}] 已安装，默认设置已写入`);
        }
    } catch (e) {
        console.warn(`[${EXT_NAME}] 初始化默认设置失败:`, e);
    }
});

/**
 * 发起请求并把结果序列化回内容脚本。
 * 只转发白名单内的目标，避免成为任意站点的开放代理。
 */
const ALLOWED_HOSTS = new Set(['fanyi.iflyrec.com']);

async function handleXhr(msg) {
    const started = Date.now();
    let target;
    try {
        target = new URL(msg.url);
    } catch {
        return { ok: false, status: 0, error: 'URL 非法' };
    }
    if (!/^https?:$/.test(target.protocol)) {
        return { ok: false, status: 0, error: '只允许 http(s)' };
    }
    if (!ALLOWED_HOSTS.has(target.hostname)) {
        return { ok: false, status: 0, error: `目标域名不在白名单: ${target.hostname}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(msg.timeout || 10000, 25000));

    try {
        const isBodyless = !msg.method || msg.method === 'GET' || msg.method === 'HEAD';
        const res = await fetch(target.href, {
            method: msg.method || 'GET',
            headers: msg.headers || {},
            body: isBodyless ? undefined : msg.data,
            signal: controller.signal,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
        });
        const text = await res.text();
        const headers = {};
        res.headers.forEach((value, key) => {
            headers[key] = value;
        });
        return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            text,
            headers,
            url: res.url,
            elapsed: Date.now() - started,
        };
    } catch (e) {
        const aborted = e && e.name === 'AbortError';
        return {
            ok: false,
            status: 0,
            error: aborted ? `请求超时（${Date.now() - started}ms）` : String(e && e.message ? e.message : e),
        };
    } finally {
        clearTimeout(timer);
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;

    switch (msg.type) {
        case 'ghcn:xhr':
            handleXhr(msg).then(sendResponse, (err) =>
                sendResponse({ ok: false, status: 0, error: String(err) })
            );
            return true; // 异步响应

        case 'ghcn:menusChanged':
            // 内容脚本广播菜单快照；popup 自己也会主动拉取，这里无需处理
            return false;

        default:
            return false;
    }
});
