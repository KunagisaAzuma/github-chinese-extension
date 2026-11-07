/**
 * clean.js — 清理开发期临时产物（不参与扩展运行）
 * 用法: node tools/clean.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');

function rm(target) {
    const abs = path.resolve(ROOT, target);
    if (!abs.startsWith(ROOT)) return `SKIP(outside) ${target}`;
    if (!fs.existsSync(abs)) return `absent  ${target}`;
    try {
        fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        return `removed ${target}`;
    } catch (e) {
        return `FAILED  ${target} :: ${e.code || e.message}`;
    }
}

const targets = [
    'tools/_smoke-profile',
    'tools/_diag-profile',
    'tools/_e2e-profile',
    'tools/_smoke-dump.html',
    'tools/_smoke-stderr.txt',
    'tools/_e2e-stderr.txt',
    'tools/_hello.txt',
    'tools/hello.js',
    'tools/diag.js',
    'tools/check-dump.js',
    'tools/check.cmd',
    'tools/smoke.cmd',
    'tools/t1.cmd',
    'probe.txt',
    'probe2.txt',
    'verdict.txt',
    'tools/_smoke-report.txt',
    'tools/_e2e-report.txt',
    'tools/_clean-report.txt',
    'tools/_diag-inject.js',
    'tools/_diag-report.txt',
    'tools/_diag-stderr.txt',
    'tools/_smoke-inject.js',
];

const lines = [];
for (const t of targets) lines.push(rm(t));

lines.push('');
lines.push('--- 剩余顶层条目 ---');
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    lines.push(`  ${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`);
}
lines.push('--- 剩余 tools ---');
for (const e of fs.readdirSync(TOOLS, { withFileTypes: true })) {
    lines.push(`  ${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`);
}

fs.writeFileSync(path.join(TOOLS, '_clean-report.txt'), lines.join('\n') + '\n', 'utf8');
