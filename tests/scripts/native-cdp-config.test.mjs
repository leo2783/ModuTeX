import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { createNativeCdpConfig } from './helpers/native-cdp-config.mjs';

async function withPort(value, run) {
  const previous = process.env.MODUTEX_TEST_CDP_PORT;
  if (value === undefined) delete process.env.MODUTEX_TEST_CDP_PORT;
  else process.env.MODUTEX_TEST_CDP_PORT = value;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.MODUTEX_TEST_CDP_PORT;
    else process.env.MODUTEX_TEST_CDP_PORT = previous;
  }
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('native CDP configuration selects and releases a loopback port', async () => {
  await withPort(undefined, async () => {
    const config = await createNativeCdpConfig('owned-webview-profile');
    assert(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535);
    assert.equal(config.env.WEBVIEW2_USER_DATA_FOLDER, 'owned-webview-profile');
    assert.equal(config.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      `--remote-debugging-port=${config.port} --remote-debugging-address=127.0.0.1`);
    const probe = createServer();
    await listen(probe, config.port);
    await close(probe);
  });
});

test('native CDP configuration rejects invalid explicit ports', async () => {
  for (const value of ['', '0', '-1', '1023', '65536', '1e4', '9222x']) {
    await withPort(value, async () => {
      await assert.rejects(createNativeCdpConfig('owned-webview-profile'), /must be an integer/);
    });
  }
});

test('native CDP configuration refuses an occupied explicit port', async () => {
  const occupied = createServer();
  await listen(occupied, 0);
  try {
    await withPort(String(occupied.address().port), async () => {
      await assert.rejects(createNativeCdpConfig('owned-webview-profile'), /already in use/);
    });
  } finally { await close(occupied); }
});
