import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import waitOn from 'wait-on';

async function withServer(handler, run) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		await run(`http-get://127.0.0.1:${server.address().port}`);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

const options = { timeout: 1500, httpTimeout: 100, interval: 30, window: 30, proxy: false };

test('real wait-on performs HTTP GET and polls until the endpoint becomes ready', async () => {
	const methods = [];
	await withServer(
		(request, response) => {
			methods.push(request.method);
			response.writeHead(methods.length < 3 ? 503 : 200);
			response.end('ready');
		},
		async (url) => {
			await waitOn({ ...options, resources: [url] });
		}
	);
	assert.ok(methods.length >= 3);
	assert.ok(methods.every((method) => method === 'GET'));
});

test('real wait-on preserves redirect following and explicit no-redirect rejection', async () => {
	let finalRequests = 0;
	await withServer(
		(request, response) => {
			if (request.url === '/ready') {
				finalRequests++;
				response.end('ready');
			} else {
				response.writeHead(302, { Location: '/ready' });
				response.end();
			}
		},
		async (url) => {
			await waitOn({ ...options, resources: [url] });
			assert.ok(finalRequests > 0);
			const followed = finalRequests;
			await assert.rejects(waitOn({ ...options, timeout: 250, followRedirect: false, resources: [url] }), /Timed out waiting/);
			assert.equal(finalRequests, followed);
		}
	);
});

test('real wait-on rejects HTTP errors instead of treating them as readiness', async () => {
	let requests = 0;
	await withServer(
		(_request, response) => {
			requests++;
			response.writeHead(500);
			response.end('error');
		},
		async (url) => {
			await assert.rejects(waitOn({ ...options, timeout: 250, resources: [url] }), /Timed out waiting/);
		}
	);
	assert.ok(requests > 1);
});

test('real wait-on bounds a hanging HTTP request with timeout and does not report success', async () => {
	let requests = 0;
	await withServer(
		() => {
			requests++;
		},
		async (url) => {
			const started = performance.now();
			await assert.rejects(waitOn({ ...options, timeout: 300, resources: [url] }), /Timed out waiting/);
			assert.ok(performance.now() - started < 3000);
		}
	);
	assert.ok(requests > 1);
});
