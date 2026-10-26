// SPDX-License-Identifier: Apache-2.0
// Actual Svelte component and official updater JS. Only native IPC is a fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const frontend = path.resolve(import.meta.dirname, '../..');
const evidence = path.resolve(frontend, '../../.verification-artifacts/tauri');

test('official updater UI requires user action and preserves work and resources', { timeout: 120_000 }, async t => {
  const fixture = await mkdtemp(path.join(frontend, '.updater-ui-test-'));
  let server, browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    assert.equal(path.dirname(fixture), frontend);
    assert.match(path.basename(fixture), /^\.updater-ui-test-/);
    await rm(fixture, { recursive: true, force: true });
  });
  await writeFile(path.join(fixture, 'Harness.svelte'), `<script>
import UpdateNotice from '../src/features/updates/UpdateNotice.svelte';
let allowed = $state(true);
let dirty = $state(false);
let compiling = $state(false);
window.fixture.setAllowed = value => allowed = value;
window.fixture.setDirty = value => dirty = value;
window.fixture.setCompiling = value => compiling = value;
async function prepare() {
 if (!allowed || compiling) return false;
 if (dirty) {
  window.fixture.calls.push('save-document');
  if (window.fixture.cancelSave) return false;
  dirty = false;
 }
 return allowed && !dirty && !compiling;
}
</script>
<UpdateNotice language="zh-Hant" installAllowed={allowed && !compiling} needsSave={dirty}
 busyReason={compiling ? 'compiling' : !allowed ? 'busy' : null}
 beforeInstall={prepare} canInstall={() => allowed && !dirty && !compiling} />`);
  await writeFile(path.join(fixture, 'main.mjs'), `import {mount,unmount} from 'svelte';
import Harness from './Harness.svelte';
import '../src/styles/base.css';
const app=mount(Harness,{target:document.getElementById('app')});
window.fixture.unmount=()=>unmount(app);`);
  await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html lang="zh-Hant"><body><div id="app"></div><script type="module" src="./main.mjs"></script></body></html>');
  server = await createServer({ root: frontend, configFile: false, plugins: [svelte()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/${path.basename(fixture)}/index.html`;
  browser = await chromium.launch({ headless: true, channel: process.env.MODUTEX_TEST_BROWSER_CHANNEL, args: ['--disable-gpu'] });

  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(options => {
      let callbackId = 0;
      const callbacks = new Map();
      const metadata = { rid: 70, currentVersion: '0.3.0', version: '0.4.0', rawJson: {} };
      const fixture = window.fixture = { calls: [], closed: [], holdCheck: options.holdCheck, holdDownload: options.holdDownload, downloadFailure: options.downloadFailure, installFailure: options.installFailure };
      window.__TAURI_INTERNALS__ = {
        transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
          fixture.calls.push(command);
          if (command === 'plugin:updater|check') {
            if (fixture.holdCheck) return new Promise(resolve => { fixture.finishCheck = () => resolve(metadata); });
            if (options.offline) throw new Error('offline fixture');
            return options.noUpdate ? null : metadata;
          }
          if (command === 'plugin:updater|download') {
            if (fixture.downloadFailure) throw new Error('signature verification failed fixture');
            args.onEvent.onmessage({ event: 'Started', data: { contentLength: 100 } });
            args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 50 } });
            if (fixture.holdDownload) await new Promise(resolve => { fixture.finishDownload = resolve; });
            args.onEvent.onmessage({ event: 'Finished' });
            return 71;
          }
          if (command === 'plugin:updater|install') {
            if (fixture.installFailure) throw new Error('installer launch failed fixture');
            return null;
          }
          if (command === 'plugin:resources|close') { fixture.closed.push(args.rid); return null; }
          throw new Error('Unexpected native command ' + command);
        }
      };
    }, options);
    await page.goto(url);
    await page.waitForFunction(() => typeof window.fixture?.unmount === 'function');
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    return page;
  }

  await t.test('availability does not download or install until clicked and Later closes the resource', async () => {
    const page = await open();
    await page.getByRole('button', { name: '下載更新', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['plugin:updater|check']);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'updater-notice-desktop.png') });
    await page.setViewportSize({ width: 800, height: 600 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(evidence, 'updater-notice-800.png') });
    await page.getByRole('button', { name: '稍後', exact: true }).click();
    await page.waitForFunction(() => window.fixture.closed.includes(70));
    assert.equal(await page.getByRole('region', { name: '軟體更新' }).count(), 0);
  });

  await t.test('download verifies first and a separate click invokes installation once', async () => {
    const page = await open();
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.getByRole('button', { name: '安裝更新', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.calls.includes('plugin:updater|install')), false);
    await page.getByRole('button', { name: '安裝更新', exact: true }).click();
    await page.waitForFunction(() => window.fixture.calls.includes('plugin:updater|install'));
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(x => x === 'plugin:updater|install').length), 1);
  });

  await t.test('work started while downloading prevents installation until it finishes', async () => {
    const page = await open({ holdDownload: true });
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.waitForFunction(() => typeof window.fixture.finishDownload === 'function');
    await page.evaluate(() => { window.fixture.setAllowed(false); window.fixture.finishDownload(); });
    const install = page.getByRole('button', { name: '安裝更新', exact: true });
    await install.waitFor();
    assert.equal(await install.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.fixture.calls.includes('plugin:updater|install')), false);
    await page.evaluate(() => window.fixture.setAllowed(true));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '安裝更新' && !b.disabled));
    await install.click();
    await page.waitForFunction(() => window.fixture.calls.includes('plugin:updater|install'));
  });

  await t.test('new edits made during download are saved before a user-approved update', async () => {
    const page = await open({ holdDownload: true });
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.waitForFunction(() => typeof window.fixture.finishDownload === 'function');
    await page.evaluate(() => { window.fixture.setDirty(true); window.fixture.finishDownload(); });
    await page.getByRole('button', { name: '儲存並更新', exact: true }).click();
    await page.waitForFunction(() => window.fixture.calls.includes('plugin:updater|install'));
    const calls = await page.evaluate(() => window.fixture.calls);
    assert(calls.indexOf('save-document') < calls.indexOf('plugin:updater|install'));
  });

  await t.test('cancelled save preserves edits and never starts the installer', async () => {
    const page = await open();
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.getByRole('button', { name: '安裝更新', exact: true }).waitFor();
    await page.evaluate(() => { window.fixture.setDirty(true); window.fixture.cancelSave = true; });
    await page.getByRole('button', { name: '儲存並更新', exact: true }).click();
    await page.waitForFunction(() => window.fixture.calls.includes('save-document'));
    assert.equal(await page.evaluate(() => window.fixture.calls.includes('plugin:updater|install')), false);
    await page.getByRole('button', { name: '儲存並更新', exact: true }).waitFor();
  });

  await t.test('a compilation begun during download is announced and blocks installation until complete', async () => {
    const page = await open({ holdDownload: true });
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.waitForFunction(() => typeof window.fixture.finishDownload === 'function');
    await page.evaluate(() => { window.fixture.setCompiling(true); window.fixture.finishDownload(); });
    const install = page.getByRole('button', { name: '安裝更新', exact: true });
    await install.waitFor();
    assert.equal(await install.isDisabled(), true);
    assert.match(await page.getByRole('region', { name: '軟體更新' }).innerText(), /編譯/);
    await page.evaluate(() => window.fixture.setCompiling(false));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '安裝更新' && !b.disabled));
    assert.equal(await page.evaluate(() => window.fixture.calls.includes('plugin:updater|install')), false);
    await install.click();
  });

  await t.test('failed verification cannot invoke install and a user can retry the download', async () => {
    const page = await open({ downloadFailure: true });
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => window.fixture.calls.includes('plugin:updater|install')), false);
    await page.evaluate(() => window.fixture.downloadFailure = false);
    await page.getByRole('button', { name: '重試下載更新', exact: true }).click();
    await page.getByRole('button', { name: '安裝更新', exact: true }).waitFor();
  });

  await t.test('installer launch failure leaves a retry and never redownloads verified bytes', async () => {
    const page = await open({ installFailure: true });
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.getByRole('button', { name: '安裝更新', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.evaluate(() => window.fixture.installFailure = false);
    await page.getByRole('button', { name: '安裝更新', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(x => x === 'plugin:updater|download').length), 1);
  });

  await t.test('unmount during download closes both resources after it settles and never installs', async () => {
    const page = await open({ holdDownload: true });
    await page.getByRole('button', { name: '下載更新', exact: true }).click();
    await page.waitForFunction(() => typeof window.fixture.finishDownload === 'function');
    await page.evaluate(() => window.fixture.unmount());
    await page.evaluate(() => window.fixture.finishDownload());
    await page.waitForFunction(() => window.fixture.closed.includes(70) && window.fixture.closed.includes(71));
    assert.equal(await page.evaluate(() => window.fixture.calls.includes('plugin:updater|install')), false);
    assert.deepEqual((await page.evaluate(() => window.fixture.closed)).sort(), [70, 71]);
  });

  await t.test('a late check result after unmount releases its resource without showing a banner', async () => {
    const page = await open({ holdCheck: true });
    await page.waitForFunction(() => typeof window.fixture.finishCheck === 'function');
    await page.evaluate(() => window.fixture.unmount());
    await page.evaluate(() => window.fixture.finishCheck());
    await page.waitForFunction(() => window.fixture.closed.includes(70));
    assert.equal(await page.getByRole('region', { name: '軟體更新' }).count(), 0);
  });

  await t.test('offline and current versions stay quiet and do not retry in the background', async () => {
    for (const options of [{ offline: true }, { noUpdate: true }]) {
      const page = await open(options);
      await page.waitForFunction(() => window.fixture.calls.includes('plugin:updater|check'));
      assert.equal(await page.getByRole('region', { name: '軟體更新' }).count(), 0);
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.evaluate(() => window.fixture.calls.length), 1);
    }
  });
});
