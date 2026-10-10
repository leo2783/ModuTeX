import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  })]).finally(() => clearTimeout(timer));
}
test('built Electron frontend loads, changes route and retains narrow IPC', { timeout: 180000 }, async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'modutex-built-smoke-'));
  assert.equal(dirname(resolve(fixtureDir)), resolve(tmpdir()));
  assert.ok(basename(fixtureDir).startsWith('modutex-built-smoke-'));
  const workspaceDir = join(fixtureDir, 'workspace');
  mkdirSync(workspaceDir);
  const mainPath = join(workspaceDir, 'main.tex');
  const initialBytes = Buffer.from('\uFEFF\\documentclass{article}\r\n\\begin{document}\r\nNative IPC body.\r\n\\end{document}\n', 'utf8');
  writeFileSync(mainPath, initialBytes);
  cpSync(join(repository, '.verification-artifacts/frontend-runtime-2026-10-07/tectonic-cache'), join(fixtureDir, 'tectonic-cache'), {recursive:true});
  writeFileSync(join(fixtureDir, 'frontend-recent-v1.json'), JSON.stringify({version:1,entries:[{id:randomUUID(),selected:mainPath,kind:'file',openedAt:Date.now()}]}));
  const errors = [];
  let browser;
  let desktop;
  let exited;
  let output = '';
  try {
    desktop = spawn(require('electron'), ['.', '--disable-gpu', '--remote-debugging-port=0'], {
      cwd: repository, windowsHide: true,
      env: { ...process.env, MODUTEX_RENDERER: 'frontend-built', TEXPILE_USER_DATA: fixtureDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    exited = new Promise((resolve) => desktop.once('exit', (code, signal) => resolve({code, signal})));
    const endpoint = await deadline(new Promise((resolve, reject) => {
      desktop.once('error', reject);
      desktop.once('exit', (code) => reject(new Error(`Electron exited before CDP: ${code}`)));
      for (const stream of [desktop.stdout, desktop.stderr]) stream.on('data', (chunk) => {
        const text = chunk.toString(); output += text;
        process.stderr.write(text);
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) resolve(match[1]);
      });
    }), 25000, 'Electron CDP startup');
    console.log('stage: real Electron CDP endpoint ready');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    console.log('stage: window created', page.url());
    await page.waitForURL('app://frontend/index.html');
    await page.getByRole('button', { name: /開啟 workspace \/ main.tex|Open workspace \/ main.tex/, exact: true }).click();
    await page.waitForURL('app://frontend/index.html#/workbench');
    await page.getByRole('button', { name: /開啟資料夾|Open folder/, exact: true }).waitFor({ state: 'visible' });
    const bridge = await page.evaluate(async () => ({
      recent: await window.modutexFiles.listRecent(),
      legacy: ['texpileNative', 'texpileTypst', 'texpileTerminal'].filter((name) => name in window)
    }));
    assert.ok(Array.isArray(bridge.recent));
    assert.deepEqual(bridge.legacy, []);
    console.log('stage: workbench real IPC accepted');
    const editor = page.locator('.cm-content[contenteditable="true"]').first();
    await editor.waitFor({state:'visible'});
    assert.match(await editor.textContent(), /Native IPC body/);
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('% native saved');
    await page.getByRole('button',{name:/^儲存$|^Save$/}).click();
    await page.waitForFunction(() => !document.querySelector('footer.status-bar')?.textContent.includes('未儲存'));
    assert.deepEqual(readFileSync(mainPath), Buffer.concat([initialBytes,Buffer.from('% native saved')]));
    await page.getByRole('button',{name:/^編譯 PDF$|^Compile PDF$/}).click();
    await page.waitForFunction(() => /編譯完成|Compilation completed/.test(document.querySelector('footer.status-bar')?.textContent ?? ''), null, {timeout:60000});
    const diskPdf = readFileSync(join(workspaceDir,'output/main.pdf'));
    assert.equal(diskPdf.subarray(0,5).toString('ascii'),'%PDF-');
    await page.locator('.pdf-scroll[aria-busy="false"]').waitFor({state:'attached'});
    const canvas = page.locator('.preview-pane canvas').first();
    await canvas.waitFor({state:'visible'});
    await page.waitForFunction(() => {
      const c=document.querySelector('.preview-pane canvas');
      if (!c?.width || !c.height) return false;
      return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i,a) => i%4===0 && a[i+3]>0 && (v<250||a[i+1]<250||a[i+2]<250));
    });
    await page.screenshot({path:join(repository,'.verification-artifacts/electron-native-workbench-20261010.png')});
    console.log('stage: real native open/save/compile/PDF passed');
    const savedCanvas = await canvas.evaluate(c => c.toDataURL());
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n');
    await page.getByRole('button',{name:/^儲存$|^Save$/}).click();
    await page.waitForFunction(() => !document.querySelector('footer.status-bar')?.textContent.includes('未儲存'));
    await page.getByRole('button',{name:/^編譯 PDF$|^Compile PDF$/}).click();
    await page.getByRole('button',{name:/^取消編譯$|^Cancel compilation$/}).click();
    await page.waitForFunction(() => /編譯已取消|Compilation cancelled/.test(document.querySelector('footer.status-bar')?.textContent ?? ''), null, {timeout:15000});
    assert.deepEqual(readFileSync(join(workspaceDir,'output/main.pdf')), diskPdf);
    await page.locator('.pdf-scroll[aria-busy="false"]').waitFor({state:'attached'});
    assert.equal(await canvas.evaluate(c => c.toDataURL()), savedCanvas);
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}Native retry.\\end{document}\n');
    await page.getByRole('button',{name:/^儲存$|^Save$/}).click();
    await page.waitForFunction(() => !document.querySelector('footer.status-bar')?.textContent.includes('未儲存'));
    await page.getByRole('button',{name:/^編譯 PDF$|^Compile PDF$/}).click();
    await page.waitForFunction(() => /編譯完成|Compilation completed/.test(document.querySelector('footer.status-bar')?.textContent ?? ''), null, {timeout:60000});
    assert.equal(readFileSync(join(workspaceDir,'output/main.pdf')).subarray(0,5).toString('ascii'), '%PDF-');
    await page.locator('.pdf-scroll[aria-busy="false"]').waitFor({state:'attached'});
    await page.screenshot({path:join(repository,'.verification-artifacts/electron-native-workbench-20261010.png')});
    console.log('stage: real native cancel/PDF preservation/retry passed');
    await page.getByRole('link', { name: /設定|Settings/, exact: true }).click();
    await page.getByRole('heading', { name: /設定|Settings/, exact: true }).waitFor({ state: 'visible' });
    assert.ok(Array.isArray(await page.evaluate(() => window.modutexFiles.listRecent())));
    await page.screenshot({ path: join(repository, '.verification-artifacts/electron-built-smoke-20261010.png') });
    assert.deepEqual(errors, []);
    console.log('stage: settings real IPC accepted, screenshot saved');
    await page.close();
    const result = await deadline(exited, 10000, 'Electron normal window close');
    assert.equal(result.code, 0);
  } catch (error) {
    console.error('native smoke failure:', error);
    if (browser) for (const page of browser.contexts()[0]?.pages() ?? []) {
      console.error('actual window:', page.url(), await deadline(page.title(), 2000, 'window title'));
      await deadline(page.screenshot({path: join(repository, '.verification-artifacts/electron-built-smoke-failure-20261010.png')}), 3000, 'failure screenshot');
    }
    throw error;
  } finally {
    if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
      desktop.kill();
      await deadline(exited, 5000, 'owned Electron cleanup');
    }
    if (browser) await deadline(browser.close(), 5000, 'CDP disconnect');
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
