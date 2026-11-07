;(function () {
    if (window.__GHCN_SMOKE_MOCK__) return;
    window.__GHCN_SMOKE_MOCK__ = true;

    var mem = {};
    window.__GHCN_SMOKE_MEM__ = mem;

    window.chrome = window.chrome || {};

    var listeners = [];
    window.chrome.runtime = {
        lastError: null,
        id: 'smoke-test-extension',
        getManifest: function () {
            return { version: '1.9.4.4' };
        },
        getURL: function (p) {
            return 'chrome-extension://smoke/' + p;
        },
        sendMessage: function (msg, cb) {
            if (cb) {
                setTimeout(function () {
                    cb({ ok: false, error: 'smoke: no background' });
                }, 0);
            }
        },
        onMessage: {
            addListener: function (fn) {
                listeners.push(fn);
            },
            removeListener: function () {},
            hasListener: function () {
                return false;
            }
        }
    };

    window.chrome.storage = {
        local: {
            // 关键：MV3 的 storage.get 在**不传回调**时返回 Promise。
            // gm-api.js 里用的是 `await chrome.storage.local.get(null)`，
            // 若这里只支持回调式，那个 await 会永远挂住，__GHCN_READY__ 永不 resolve。
            get: function (keys, cb) {
                var out = {};
                var k;
                if (keys === null || keys === undefined) {
                    for (k in mem) out[k] = mem[k];
                } else if (typeof keys === 'string') {
                    if (keys in mem) out[keys] = mem[keys];
                } else if (Array.isArray(keys)) {
                    keys.forEach(function (kk) {
                        if (kk in mem) out[kk] = mem[kk];
                    });
                } else {
                    for (k in keys) out[k] = k in mem ? mem[k] : keys[k];
                }
                if (typeof cb === 'function') {
                    setTimeout(function () { cb(out); }, 0);
                    return undefined;
                }
                return Promise.resolve(out);
            },
            set: function (obj, cb) {
                for (var k in obj) mem[k] = obj[k];
                if (typeof cb === 'function') {
                    setTimeout(function () { cb(); }, 0);
                    return undefined;
                }
                return Promise.resolve();
            },
            remove: function (k, cb) {
                delete mem[k];
                if (typeof cb === 'function') {
                    setTimeout(cb, 0);
                    return undefined;
                }
                return Promise.resolve();
            }
        },
        onChanged: {
            addListener: function () {},
            removeListener: function () {}
        }
    };

    window.__GHCN_SMOKE_ERRORS__ = [];
    window.addEventListener('error', function (e) {
        window.__GHCN_SMOKE_ERRORS__.push('error: ' + String((e && e.message) || e));
    });
    window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        window.__GHCN_SMOKE_ERRORS__.push('unhandledrejection: ' + String((r && r.stack) || (r && r.message) || r));
    });

    // 把 console.error / console.warn 也收进错误数组：
    // 扩展脚本内部用 try/catch + console.error 记录异常，不会触发 window error 事件
    var rawError = console.error.bind(console);
    var rawWarn = console.warn.bind(console);
    console.error = function () {
        var parts = Array.prototype.map.call(arguments, function (a) {
            if (a instanceof Error) return a.stack || String(a);
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (_) { return String(a); }
        });
        window.__GHCN_SMOKE_ERRORS__.push('console.error: ' + parts.join(' '));
        rawError.apply(null, arguments);
    };
    console.warn = function () {
        var parts = Array.prototype.map.call(arguments, function (a) {
            if (a instanceof Error) return a.stack || String(a);
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (_) { return String(a); }
        });
        window.__GHCN_SMOKE_ERRORS__.push('console.warn: ' + parts.join(' '));
        rawWarn.apply(null, arguments);
    };
})();
