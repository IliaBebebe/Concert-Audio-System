const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { QRCode } = require('../qr-generator.js');
const { CASRemoteServer } = require('../remote-server.js');

test('QRCode: generates valid SVG markup', () => {
    const url = 'http://192.168.1.50:8765/?token=test1234';
    const svg = QRCode.generateSVG(url, { size: 180, margin: 2 });
    assert.ok(typeof svg === 'string', 'SVG should be a string');
    assert.ok(svg.includes('<svg'), 'Should contain svg open tag');
    assert.ok(svg.includes('</svg>'), 'Should contain svg close tag');
    assert.ok(svg.includes('viewBox="0 0 180 180"'), 'Should contain correct viewBox');
    assert.ok(svg.includes('<rect'), 'Should contain rect elements');
});

test('CASRemoteServer: status and credentials initialization', () => {
    const server = new CASRemoteServer({ port: 9876 });
    const status = server.getStatus();

    assert.equal(status.running, false);
    assert.equal(status.port, 9876);
    assert.ok(typeof status.token === 'string' && status.token.length >= 8, 'Token should be at least 8 chars');
    assert.ok(/^\d{4}$/.test(status.pin), 'PIN must be 4 digits');
    assert.ok(typeof status.primaryIp === 'string', 'Primary IP should be a string');
    assert.ok(status.primaryUrl.includes(status.token), 'Primary URL should embed the token');
    assert.ok(status.svgQrCode.includes('<svg'), 'Status should include SVG QR code');
});

test('CASRemoteServer: lifecycle start, command dispatch, sse streaming, and stop', async () => {
    const server = new CASRemoteServer({ port: 9870 });
    const receivedCommands = [];
    server.onCommand((cmd) => {
        receivedCommands.push(cmd);
    });

    const status = await server.start();
    assert.equal(status.running, true);
    assert.equal(server.isRunning, true);

    const baseUrl = `http://127.0.0.1:${server.port}`;

    // 1. Unauthorized access without token
    const unauthorizedStatus = await new Promise((resolve, reject) => {
        http.get(`${baseUrl}/api/status`, (res) => {
            resolve(res.statusCode);
        }).on('error', reject);
    });
    assert.equal(unauthorizedStatus, 401, 'Request without token must be rejected with 401');

    // 2. Authorized status snapshot
    const authorizedState = await new Promise((resolve, reject) => {
        http.get(`${baseUrl}/api/status?token=${server.token}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
    assert.equal(authorizedState.success, true);

    // 3. Command dispatch via HTTP POST
    const commandPayload = JSON.stringify({ action: 'playTrack', deck: 'A', index: 3 });
    const commandRes = await new Promise((resolve, reject) => {
        const req = http.request(`${baseUrl}/api/command?token=${server.token}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(commandPayload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.write(commandPayload);
        req.end();
    });

    assert.equal(commandRes.code, 200);
    assert.equal(commandRes.body.success, true);
    assert.equal(receivedCommands.length, 1);
    assert.equal(receivedCommands[0].action, 'playTrack');
    assert.equal(receivedCommands[0].deck, 'A');
    assert.equal(receivedCommands[0].index, 3);

    // 4. SSE Stream connection and state broadcast
    const sseMessages = [];
    const sseClient = await new Promise((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/stream?token=${server.token}`, (res) => {
            res.on('data', (chunk) => {
                const text = chunk.toString();
                sseMessages.push(text);
                if (text.includes(': connected')) {
                    resolve({ req, res });
                }
            });
        });
        req.on('error', reject);
    });

    // Broadcast state from server
    server.broadcastState({
        activeDeck: 'A',
        isPlaying: true,
        currentTrack: { title: 'Test Track', duration: 180 }
    });

    // Wait a brief tick for network transmission
    await new Promise(r => setTimeout(r, 50));
    const fullSseOutput = sseMessages.join('');
    assert.ok(fullSseOutput.includes('Test Track'), 'SSE client should receive broadcast state');

    // 5. Static client files
    const clientHtml = await new Promise((resolve, reject) => {
        http.get(`${baseUrl}/?token=${server.token}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ code: res.statusCode, data }));
        }).on('error', reject);
    });
    assert.equal(clientHtml.code, 200);
    assert.ok(clientHtml.data.includes('CAS Remote'), 'Should serve mobile web app');

    // Clean up SSE client and stop server
    sseClient.req.destroy();
    await server.stop();
    assert.equal(server.isRunning, false);
});
