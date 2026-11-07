/**
 * popup.js — 工具弹窗逻辑
 *
 * 能做的事：
 *  - 检测当前标签页是否已被扩展注入（data-ghcn-active）
 *  - 读改两个常用功能开关（直接写 chrome.storage.local，内容脚本用 storage.onChanged 同步）
 *  - 列出当前页面上 main.js 通过 GM_registerMenuCommand 注册的动态菜单，点击即在页面执行
 *  - 一键刷新当前标签页
 */

const EXT_NAME = 'GitHub 中文化插件';

const SUPPORTED = [
    /^https:\/\/github\.com\//,
    /^https:\/\/skills\.github\.com\//,
    /^https:\/\/gist\.github\.com\//,
    /^https:\/\/education\.github\.com\//,
    /^https:\/\/www\.githubstatus\.com\//,
];

const SWITCHES = ['enable_RegExp', 'enable_transDesc'];

const $ = (id) => document.getElementById(id);

const els = {
    status: $('status'),
    statusText: $('statusText'),
    menus: $('menus'),
    reload: $('reload'),
    version: $('version'),
};

function isSupported(url) {
    return SUPPORTED.some((re) => re.test(url));
}

function setStatus(state, text) {
    els.status.dataset.state = state;
    els.statusText.textContent = text;
}

/** 浏览器 API 优先用 promise 形式，必要时回落到 callback */
function queryActiveTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(tabs && tabs[0] ? tabs[0] : null);
        });
    });
}

function sendToTab(tabId, message) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(response ?? null);
        });
    });
}

function readSettings(keys) {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys, (items) => {
            resolve(items || {});
        });
    });
}

async function renderSwitches() {
    const stored = await readSettings(SWITCHES);
    const DEFAULTS = { enable_RegExp: true, enable_transDesc: true };
    for (const key of SWITCHES) {
        const box = $(key);
        if (!box) continue;
        box.checked = key in stored ? Boolean(stored[key]) : DEFAULTS[key];
    }
}

function bindSwitches() {
    for (const key of SWITCHES) {
        const box = $(key);
        if (!box) continue;
        box.addEventListener('change', () => {
            chrome.storage.local.set({ [key]: box.checked });
        });
    }
}

function renderMenus(items) {
    els.menus.textContent = '';

    if (!items || !items.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = '当前页面未提供额外菜单。';
        els.menus.appendChild(p);
        return;
    }

    for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.textContent = item.title;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            await sendToTab(currentTabId, { type: 'ghcn:runMenu', id: item.id });
            window.setTimeout(() => { btn.disabled = false; }, 400);
        });
        els.menus.appendChild(btn);
    }
}

let currentTabId = null;

async function init() {
    const manifest = chrome.runtime.getManifest();
    if (manifest && manifest.version && els.version) {
        els.version.textContent = `v${manifest.version}`;
    }

    bindSwitches();
    await renderSwitches();

    const tab = await queryActiveTab();
    if (!tab || !tab.url) {
        setStatus('inactive', '无法读取当前标签页');
        renderMenus(null);
        return;
    }
    currentTabId = tab.id;

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
        setStatus('inactive', '浏览器内部页面，扩展不生效');
        renderMenus(null);
        els.reload.disabled = true;
        return;
    }

    if (!isSupported(tab.url)) {
        setStatus('inactive', '当前站点不在汉化范围内');
        renderMenus(null);
        return;
    }

    const pong = await sendToTab(tab.id, { type: 'ghcn:ping' });
    if (!pong || !pong.active) {
        setStatus('inactive', '已加载但未生效，刷新页面试试');
        renderMenus(null);
        return;
    }

    setStatus('active', '汉化已生效');
    renderMenus(Array.isArray(pong.menus) ? pong.menus : []);
}

els.reload.addEventListener('click', async () => {
    if (currentTabId == null) return;
    els.reload.disabled = true;
    chrome.tabs.reload(currentTabId);
    window.setTimeout(() => window.close(), 120);
});

// 内容脚本改动菜单后（例如切换正则功能刷新了动态项）同步一次
chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ghcn:menusChanged' && Array.isArray(msg.menus)) {
        renderMenus(msg.menus);
    }
    return false;
});

init().catch((e) => {
    console.error(`[${EXT_NAME}] popup 初始化失败:`, e);
    setStatus('inactive', '弹窗初始化失败，详见控制台');
});
