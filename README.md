# GitHub 中文化插件（浏览器扩展版）

把 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese) 的油猴脚本改造成可直接加载的 **Chrome / Edge Manifest V3 扩展**。

当前版本：**1.9.4.4**（与上游脚本版本对齐）

---

## 安装

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中本目录（`github-chinese-extension`）
4. 打开或刷新 GitHub 页面即可看到中文界面

> 需要 Chrome / Edge 102 或更高版本。
> 如果是从旧版本升级，加载后请到扩展详情页点一次「重新加载」，再刷新 GitHub 标签页。

---

## 与油猴版的关系

| | 油猴版 | 本扩展 |
|---|---|---|
| 词库文件 | `@require` 从 raw.githubusercontent.com 远程拉取 | 打包在 `src/locals.js`，**离线可用** |
| 超时/限流 | 远程拉取失败就完全不工作 | 不受影响 |
| 设置存储 | `GM_setValue`（脚本管理器沙箱） | `chrome.storage.local`（扩展存储） |
| 设置入口 | 油猴菜单 | 点扩展图标弹出面板 |
| 主逻辑 | `main.user.js` | `src/main.js`（除入口与出口外**逐行未改**） |

上游主逻辑保持原样，只是把 IIFE 的自动执行改成由 `src/bootstrap.js` 在存储预热完成后调用，避免 `GM_getValue` 在异步存储就绪前读到 `undefined` 而把默认值写回、覆盖用户设置。

---

## 功能

- GitHub 界面汉化（仓库、议题、拉取请求、讨论、市场、设置等）
- 覆盖 `github.com`、`gist.github.com`、`skills.github.com`、`education.github.com`、`www.githubstatus.com`
- 支持 Turbo / React 局部导航，切换页面不用刷新
- 两个开关（在弹窗里改，即时生效）：
  - **词条正则替换**（`enable_RegExp`）— 用正则处理带变量的文案，关掉更保守
  - **翻译描述文字**（`enable_transDesc`）— 是否翻译仓库简介等长文本
- 未命中词条收集（`enable_missedTerms`）— 默认关闭；开启后在页面上记录未翻译的文本，方便反馈给词库
- 讯飞听见接口兜底翻译（可选，需联网；请求经扩展后台转发以绕过页面跨域限制）

---

## 目录结构

```
github-chinese-extension/
├── manifest.json          MV3 清单
├── background.js          Service Worker：跨域请求转发 + 默认设置初始化
├── popup.html / popup.css / popup.js   点图标弹出的控制面板
├── icons/                 16 / 32 / 48 / 128 图标
├── src/
│   ├── gm-api.js          GM_* 兼容层（content script 第一段）
│   ├── locals.js          I18N 词库（约 2 MB，上游原样）
│   ├── main.js            主逻辑（上游原样，仅改入口/出口两行）
│   └── bootstrap.js       等待存储就绪后再启动主逻辑
├── tools/                 开发期自检与端到端验证脚本（不影响扩展运行）
└── LICENSE                GPL-3.0（继承上游）
```

---

## 工作原理

内容脚本按固定顺序注入（`document_start`）：

```
gm-api.js → locals.js → main.js → bootstrap.js
```

1. **`gm-api.js`** 建立 `GM_getValue` / `GM_setValue` / `GM_addStyle` / `GM_xmlhttpRequest` / `GM_registerMenuCommand` / `GM_notification` 的兼容实现，并异步把 `chrome.storage.local` 全量读进内存缓存，暴露 `window.__GHCN_READY__`。
   `GM_getValue` 必须是同步的（主逻辑在对象字面量里就调用了），所以缓存先行。
2. **`locals.js`** 定义 `I18N` 词库对象。
3. **`main.js`** 只定义 `window.__GHCN_MAIN__`，不自动执行。
4. **`bootstrap.js`** 等 `__GHCN_READY__` 完成、并确认 `<html>` 已存在后，调用主逻辑，成功后给 `<html>` 打上 `data-ghcn-active="1"`。

`data-ghcn-active` 是弹窗判断「本页是否已生效」的依据。

跨域请求（讯飞翻译接口）由 `background.js` 发起，只放行 `fanyi.iflyrec.com` 一个域名，不做通用代理。

---

## 开发期自检

`tools/` 下有三个独立脚本，都不参与扩展运行：

```bash
# 静态自检：manifest 字段、引用文件、JS 语法、GM_* 覆盖、加载顺序、词库、白名单
node tools/verify.js

# 端到端：用 CDP 注入四段脚本到真实 GitHub 页面，验证真的翻译了
node tools/e2e.js

# 真实装载扩展冒烟（Chrome 137+ 需要 --disable-features=DisableLoadExtensionCommandLineSwitch）
node tools/smoke.js
```

`tools/e2e.js` 会依次打开 `github.com/explore`、`github.com/`、`github.com/login`、`gist.github.com/`，等 `document.readyState === 'complete'` 后取样，检查 `data-ghcn-active`、`<html lang>`、注入的 CSS 变量、以及页面上是否出现中文词条。结果写到 `tools/_e2e-report.txt`。

> 注意：`smoke.js` 的「真实装载」路径依赖 Chrome 命令行装载扩展的机制，新版 Chrome 已默认禁用该开关，需要显式 `--disable-features=DisableLoadExtensionCommandLineSwitch`。手动「加载已解压的扩展程序」不受此影响。

---

## 已知限制

- 只匹配五个 GitHub 域名，其它站点不注入
- GitHub 改版后新文案可能未被词库覆盖，可在弹窗里开「未命中词条」收集
- 兜底机翻需要联网，且质量不如人工词库
- 不处理 GitHub 的 `<iframe>` 内容（`all_frames: false`）

---

## 许可

GPL-3.0，继承上游 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)。
词库与主逻辑版权归原作者「沙漠之子」及贡献者所有；本仓库只做扩展封装。
