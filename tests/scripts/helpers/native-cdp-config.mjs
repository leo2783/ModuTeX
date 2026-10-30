// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:net';

async function listenOnLoopback(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    throw new Error('Could not reserve an IPv4 loopback port for native WebView2 CDP');
  }
  return { port: address.port, server };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function configuredPort() {
  const value = process.env.MODUTEX_TEST_CDP_PORT;
  if (value === undefined) return null;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('MODUTEX_TEST_CDP_PORT must be an integer between 1024 and 65535');
  }
  const port = Number(value.trim());
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('MODUTEX_TEST_CDP_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

export async function createNativeCdpConfig(userDataFolder) {
  if (typeof userDataFolder !== 'string' || userDataFolder.trim() === '') {
    throw new Error('A WebView2 user data folder is required');
  }

  const requestedPort = configuredPort();
  let reservation;
  try {
    reservation = await listenOnLoopback(requestedPort ?? 0);
  } catch (error) {
    if (requestedPort === null) throw error;
    throw new Error(`Native WebView2 CDP loopback port ${requestedPort} is already in use`, { cause: error });
  }
  await closeServer(reservation.server);

  const port = requestedPort ?? reservation.port;
  return {
    port,
    env: {
      WEBVIEW2_USER_DATA_FOLDER: userDataFolder,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
    }
  };
}
