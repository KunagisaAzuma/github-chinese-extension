/**
 * bootstrap.js — 启动顺序控制（content script 最后一段）
 *
 * 顺序要求：
 *   1. gm-api.js  建立 GM_* 兼容层，并把 chrome.storage.local 全量读进内存（异步）
 *   2. locals.js  定义 I18N 词库
 *   3. main.js    定义 window.__GHCN_MAIN__（不执行）
 *   4. bootstrap  等第 1 步完成，再调用 __GHCN_MAIN__
 *
 * 为什么必须等存储：main.js 在模块初始化阶段用 GM_getValue 读功能开关，
 * 若存储还没就绪会拿到 undefined → 退回默认值 → 顺带把默认值写回存储，
 * 用户的设置就丢了。
 *
 * 为什么还要等 documentElement：@run-at document_start 时（尤其是通过
 * CDP 注入、或浏览器极早期执行内容脚本的场景）document.documentElement
 * 可能仍是 null。main.js 的 initLangEnv() 会直接写
 * document.documentElement.lang，null 时抛 TypeError 导致整个 init 中断。
 * 上游是 userscript，Tampermonkey 的注入时机会保证 html 已存在；扩展里
 * 不能假设同样成立，所以在调用前补一道守卫。
 */

(function () {
    'use strict';

    const EXT_NAME = 'GitHub 中文化插件';
    const ROOT_WAIT_MS = 5000;

    function runMain() {
        if (typeof window.__GHCN_MAIN__ !== 'function') {
            console.error(`[${EXT_NAME}] 主逻辑未加载（src/main.js 缺失或被拦截）`);
            return;
        }
        try {
            window.__GHCN_MAIN__(window, document);
            // 标记：供 popup / 调试判断内容脚本是否已在本页生效
            document.documentElement.setAttribute('data-ghcn-active', '1');
        } catch (e) {
            console.error(`[${EXT_NAME}] 启动失败:`, e);
        }
    }

    /**
     * 等 <html> 元素存在后再执行。
     * documentElement 缺失只可能出现在文档解析的最开始一小段，
     * 正常几十毫秒内就会就绪；这里用 readystatechange + 短轮询双保险，
     * 并有 5 秒上限，避免极端情况下永远卡住。
     */
    function start() {
        if (document.documentElement) {
            runMain();
            return;
        }

        let done = false;
        let timer = null;

        const cleanup = () => {
            done = true;
            if (timer) clearInterval(timer);
            document.removeEventListener('readystatechange', onReady);
        };
        const onReady = () => {
            if (done || !document.documentElement) return;
            cleanup();
            runMain();
        };

        document.addEventListener('readystatechange', onReady);
        timer = setInterval(onReady, 10);
        setTimeout(() => {
            if (done) return;
            cleanup();
            if (document.documentElement) {
                runMain();
            } else {
                console.error(`[${EXT_NAME}] 等待 <html> 超时，放弃启动`);
            }
        }, ROOT_WAIT_MS);
    }

    const ready = window.__GHCN_READY__;
    if (ready && typeof ready.then === 'function') {
        ready.then(start, (err) => {
            console.warn(`[${EXT_NAME}] 存储预热失败，按默认值启动:`, err);
            start();
        });
    } else {
        // gm-api.js 未加载时的兜底：直接启动（GM_* 缺失会由 main 内部报错）
        start();
    }
})();
