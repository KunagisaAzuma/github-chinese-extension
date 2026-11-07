/**
 * gm-api.js — Tampermonkey GM_* API 的浏览器扩展实现（内容脚本第一段，先于词库与主逻辑执行）
 *
 * 背景：上游 github-chinese 是一个 userscript，依赖 GM_getValue / GM_setValue /
 * GM_addStyle / GM_xmlhttpRequest / GM_registerMenuCommand / GM_notification。
 * 扩展的 content script 没有这些全局函数，因此在这里用 chrome.storage + runtime 消息
 * 补齐一套兼容实现，主逻辑（src/main.js）不用改动任何调用点。
 *
 * 关键设计：
 *  - GM_getValue 必须**同步**返回（主逻辑在对象字面量里就调用了）。
 *    所以先异步把 chrome.storage.local 全量读进内存缓存，并通过 window.__GHCN_READY__
 *    暴露一个 Promise；src/bootstrap.js 会 await 它再执行主逻辑，
 *    保证读到的是持久化后的值，而不是默认值。
 *  - GM_xmlhttpRequest 走 background service worker 发起，绕开页面 CORS 限制。
 *  - GM_registerMenuCommand 注册到内存表，popup 通过 runtime 消息读取并触发。
 */

(function () {
    'use strict';

    if (window.__GHCN_GM_SHIM__) return;
    window.__GHCN_GM_SHIM__ = true;

    const EXT_NAME = 'GitHub 中文化插件';
    const VERSION = '1.9.4.4';
    const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    const hasStorage = hasChrome && !!chrome.storage && !!chrome.storage.local;

    /** @type {Record<string, any>} 同步缓存：chrome.storage.local 的全量快照 */
    let store = {};

    /** 菜单注册表：id -> { label, fn } */
    const menus = new Map();
    let menuSeq = 0;

    /* =========================== 设置读写（同步接口） =========================== */

    function persist(key, value) {
        if (!hasStorage) return;
        try {
            chrome.storage.local.set({ [key]: value }, () => {
                // 读取 lastError，避免扩展重载后 context 失效产生未处理告警
                void chrome.runtime.lastError;
            });
        } catch (e) {
            console.warn(`[${EXT_NAME}] 写入设置失败:`, e);
        }
    }

    window.__GHCN_READY__ = (async () => {
        if (!hasStorage) return store;
        try {
            const all = await chrome.storage.local.get(null);
            if (all && typeof all === 'object') store = all;
        } catch (e) {
            console.warn(`[${EXT_NAME}] 读取设置失败，使用默认值:`, e);
        }
        return store;
    })();

    window.GM_getValue = function (key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue;
    };

    window.GM_setValue = function (key, value) {
        store[key] = value;
        persist(key, value);
    };

    window.GM_deleteValue = function (key) {
        delete store[key];
        if (hasStorage) {
            try {
                chrome.storage.local.remove(key, () => void chrome.runtime.lastError);
            } catch (e) {
                console.warn(`[${EXT_NAME}] 删除设置失败:`, e);
            }
        }
    };

    window.GM_listValues = function () {
        return Object.keys(store);
    };

    window.GM_info = {
        script: {
            name: EXT_NAME,
            version: VERSION,
            namespace: 'https://github.com/maboloshi/github-chinese',
            runAt: 'document-start',
        },
        scriptHandler: 'browser-extension',
        version: VERSION,
    };

    window.GM_log = function (...args) {
        console.log(`[${EXT_NAME}]`, ...args);
    };

    /* 其它标签页或 popup 改了设置时，本页缓存跟着更新 */
    if (hasStorage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            for (const [key, { newValue }] of Object.entries(changes)) {
                if (newValue === undefined) delete store[key];
                else store[key] = newValue;
            }
        });
    }

    /* =========================== 样式注入 =========================== */

    window.GM_addStyle = function (css) {
        const style = document.createElement('style');
        style.textContent = css;
        style.setAttribute('data-ghcn', '');
        const parent = document.head || document.documentElement;
        if (parent) parent.appendChild(style);
        return style;
    };

    /* =========================== 跨域请求（交给 background 发） =========================== */

    let xhrSeq = 0;

    window.GM_xmlhttpRequest = function (details) {
        const requestId = `ghcn-${++xhrSeq}-${Date.now()}`;
        const timeout = Math.max(1000, Math.min(details.timeout || 10000, 25000));
        let aborted = false;

        if (!hasChrome) {
            if (details.onerror) details.onerror({ error: '扩展上下文不可用' });
            return { abort() {} };
        }

        try {
            chrome.runtime.sendMessage(
                {
                    type: 'ghcn:xhr',
                    requestId,
                    method: details.method || 'GET',
                    url: details.url,
                    headers: details.headers || {},
                    data: details.data ?? null,
                    timeout,
                },
                (resp) => {
                    void chrome.runtime.lastError; // 扩展重载时 message port 会关闭
                    if (aborted) return;
                    if (!resp) {
                        if (details.onerror) details.onerror({ error: 'no response from background' });
                        return;
                    }
                    if (resp.ok) {
                        if (details.onload) {
                            details.onload({
                                status: resp.status,
                                statusText: resp.statusText,
                                responseText: resp.text,
                                responseHeaders: Object.entries(resp.headers || {})
                                    .map(([k, v]) => `${k}: ${v}`)
                                    .join('\r\n'),
                                finalUrl: resp.url,
                            });
                        }
                    } else if (details.onerror) {
                        details.onerror({
                            status: resp.status || 0,
                            error: resp.error || `HTTP ${resp.status}`,
                        });
                    }
                }
            );
        } catch (e) {
            if (details.onerror) details.onerror({ error: String(e) });
        }

        return {
            abort() {
                aborted = true;
            },
        };
    };

    /* =========================== 菜单命令 =========================== */

    window.GM_registerMenuCommand = function (label, fn) {
        const id = ++menuSeq;
        menus.set(id, { label: String(label), fn });
        broadcastMenus();
        return id;
    };

    window.GM_unregisterMenuCommand = function (id) {
        if (menus.delete(id)) broadcastMenus();
    };

    /** 统一快照结构：id / title（popup 用）+ label（内部用） */
    function menuSnapshot() {
        return Array.from(menus.entries()).map(([id, m]) => ({ id, title: m.label, label: m.label }));
    }

    /** 菜单变化时通知已打开的 popup（没有监听者时忽略错误） */
    function broadcastMenus() {
        if (!hasChrome) return;
        try {
            chrome.runtime.sendMessage({ type: 'ghcn:menusChanged', menus: menuSnapshot() }, () => {
                void chrome.runtime.lastError;
            });
        } catch (e) {
            /* popup 未打开属正常情况 */
        }
    }

    /* =========================== 通知（页面内轻提示） =========================== */

    let toastHost = null;
    let toastTimer = null;

    window.GM_notification = function (input) {
        const text = typeof input === 'string' ? input : (input && (input.text || input.title)) || '';
        if (!text) return;
        console.log(`[${EXT_NAME}] ${text}`);
        showToast(text);
    };

    function showToast(text) {
        try {
            const parent = document.body || document.documentElement;
            if (!parent) return;
            if (!toastHost) {
                toastHost = document.createElement('div');
                toastHost.setAttribute('data-ghcn-toast', '');
                toastHost.style.cssText = [
                    'position:fixed',
                    'right:20px',
                    'bottom:20px',
                    'z-index:2147483647',
                    'max-width:320px',
                    'padding:10px 14px',
                    'border-radius:8px',
                    'background:#1f6feb',
                    'color:#fff',
                    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif',
                    'box-shadow:0 6px 24px rgba(0,0,0,.3)',
                    'opacity:0',
                    'transition:opacity .18s ease',
                    'pointer-events:none',
                    'white-space:pre-wrap',
                ].join(';');
                parent.appendChild(toastHost);
            }
            toastHost.textContent = String(text);
            toastHost.style.opacity = '1';
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                if (toastHost) toastHost.style.opacity = '0';
            }, 3000);
        } catch (e) {
            /* 提示失败不影响主流程 */
        }
    }

    /* =========================== 与 popup 通信 =========================== */

    if (hasChrome) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
            switch (msg && msg.type) {
                case 'ghcn:ping':
                    // popup 一次性拿到「是否生效」与「当前菜单」，省一次往返
                    sendResponse({
                        ok: true,
                        version: VERSION,
                        active: document.documentElement.getAttribute('data-ghcn-active') === '1',
                        menus: menuSnapshot(),
                    });
                    return false;

                case 'ghcn:getMenus':
                    sendResponse({ ok: true, menus: menuSnapshot() });
                    return false;

                case 'ghcn:runMenu': {
                    const entry = menus.get(msg.id);
                    if (!entry) {
                        sendResponse({ ok: false, error: 'menu-not-found' });
                        return false;
                    }
                    try {
                        entry.fn();
                        sendResponse({ ok: true });
                    } catch (e) {
                        sendResponse({ ok: false, error: String(e) });
                    }
                    return false;
                }

                default:
                    return false;
            }
        });
    }
})();
