/**
 * CAS Remote Control Server
 * Built-in zero-dependency HTTP & SSE server for mobile phone web control.
 * Runs in Electron Main Process.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { QRCode } = require('./qr-generator.js');

class CASRemoteServer {
    constructor(options = {}) {
        this.port = options.port ?? 8765;
        this.clientDir = options.clientDir || path.join(__dirname, 'remote-client');
        this.server = null;
        this.isRunning = false;
        this.token = this._generateToken();
        this.pin = this._generatePin();
        this.sseClients = new Set();
        this.cachedState = null;
        this.onCommandCallback = null;
        this.onClientCountChangeCallback = null;
        this.heartbeatTimer = null;
        this.failedAttempts = new Map();
    }

    _generateToken() {
        return crypto.randomBytes(16).toString('hex');
    }

    _generatePin() {
        return String(crypto.randomInt(1000, 10000));
    }

    getLocalIpAddresses() {
        const interfaces = os.networkInterfaces();
        const addresses = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    addresses.push({ name, address: iface.address });
                }
            }
        }
        return addresses;
    }

    getPrimaryIp() {
        const list = this.getLocalIpAddresses();
        if (list.length === 0) return '127.0.0.1';
        // Prefer Wi-Fi or Ethernet addresses (192.168.x.x, 10.x.x.x, 172.x.x.x)
        const preferred = list.find(item =>
            item.address.startsWith('192.168.') ||
            item.address.startsWith('10.') ||
            item.name.toLowerCase().includes('wi-fi') ||
            item.name.toLowerCase().includes('wlan') ||
            item.name.toLowerCase().includes('eth')
        );
        return (preferred || list[0]).address;
    }

    getPrimaryUrl() {
        const ip = this.getPrimaryIp();
        return `http://${ip}:${this.port}/?token=${this.token}`;
    }

    getStatus() {
        const primaryUrl = this.getPrimaryUrl();
        const svgQrCode = QRCode.generateSVG(primaryUrl, { size: 200, margin: 2 });
        return {
            running: this.isRunning,
            port: this.port,
            addresses: this.getLocalIpAddresses(),
            primaryIp: this.getPrimaryIp(),
            primaryUrl,
            token: this.token,
            pin: this.pin,
            clientCount: this.sseClients.size,
            svgQrCode
        };
    }

    onCommand(fn) {
        this.onCommandCallback = fn;
    }

    onClientCountChange(fn) {
        this.onClientCountChangeCallback = fn;
    }

    start(desiredPort = this.port) {
        return new Promise((resolve, reject) => {
            if (this.isRunning) {
                return resolve(this.getStatus());
            }

            this.port = desiredPort;
            this.token = this._generateToken();
            this.pin = this._generatePin();
            this.failedAttempts.clear();
            this.server = http.createServer((req, res) => this._handleRequest(req, res));

            let retries = 0;
            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE' && retries++ < 10 && this.port < 65535) {
                    // Try next port
                    this.port++;
                    this.server.listen(this.port, '0.0.0.0');
                } else {
                    reject(err);
                }
            });

            this.server.listen(this.port, '0.0.0.0', () => {
                this.port = this.server.address().port;
                this.isRunning = true;
                this._startHeartbeat();
                resolve(this.getStatus());
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            this._stopHeartbeat();
            for (const client of this.sseClients) {
                try { client.end(); } catch {}
            }
            this.sseClients.clear();

            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    this.server = null;
                    resolve();
                });
            } else {
                this.isRunning = false;
                resolve();
            }
        });
    }

    broadcastState(state) {
        this.cachedState = state;
        if (this.sseClients.size === 0) return;

        const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
        for (const res of this.sseClients) {
            try {
                res.write(payload);
            } catch {
                this.sseClients.delete(res);
            }
        }
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.sseClients.size > 0) {
                const ping = ': ping\n\n';
                for (const res of this.sseClients) {
                    try { res.write(ping); }
                    catch { this.sseClients.delete(res); }
                }
            }
        }, 10000);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    _handleRequest(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // The phone client is served by this server. Other websites cannot send commands.
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
            res.writeHead(403);
            return res.end('Access denied');
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(req.url, 'http://localhost');
        } catch {
            res.writeHead(400);
            return res.end('Invalid URL');
        }
        const pathname = parsedUrl.pathname;
        const queryToken = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('t');

        if (pathname.startsWith('/api/')) {
            const key = req.socket.remoteAddress;
            const attempt = this.failedAttempts.get(key);
            const blocked = attempt && attempt.expires > Date.now() && attempt.count >= 10;
            // QR tokens remain usable even after failed PIN guesses from the same address.
            if (blocked && queryToken !== this.token) {
                res.writeHead(429, { 'Retry-After': '60' });
                return res.end('Too many attempts');
            }
            if (!this._validateToken(queryToken)) {
                if (!attempt || attempt.expires <= Date.now()) {
                    if (this.failedAttempts.size >= 512) this.failedAttempts.delete(this.failedAttempts.keys().next().value);
                    this.failedAttempts.set(key, { count: 1, expires: Date.now() + 60000 });
                } else {
                    attempt.count++;
                }
            }
        }

        // 1. API: Server-Sent Events (SSE) Stream
        if (pathname === '/api/stream') {
            if (!this._validateToken(queryToken)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Неверный или отсутствующий токен доступа' }));
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.write(': connected\n\n');

            this.sseClients.add(res);
            this._notifyClientCount();

            // Send current cached state immediately
            if (this.cachedState) {
                res.write(`event: state\ndata: ${JSON.stringify(this.cachedState)}\n\n`);
            }

            req.on('close', () => {
                this.sseClients.delete(res);
                this._notifyClientCount();
            });
            return;
        }

        // 2. API: Current Status Snapshot
        if (pathname === '/api/status') {
            if (!this._validateToken(queryToken)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Неверный токен' }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                success: true,
                state: this.cachedState
            }));
        }

        // 3. API: Commands
        if (pathname === '/api/command') {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Method not allowed' }));
            }

            if (!this._validateToken(queryToken)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Неверный токен' }));
            }

            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 64 * 1024) req.destroy(); // Guard against oversized payload
            });

            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.action !== 'string') {
                        throw new Error('Invalid command');
                    }
                    if (this.onCommandCallback) {
                        this.onCommandCallback(data);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, action: data.action }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }

        // 4. Static Files for Mobile Web Client
        this._serveStatic(pathname, res);
    }

    _validateToken(token) {
        if (!token) return false;
        return token === this.token || token === this.pin;
    }

    _notifyClientCount() {
        if (this.onClientCountChangeCallback) {
            try { this.onClientCountChangeCallback(this.sseClients.size); } catch {}
        }
    }

    _serveStatic(pathname, res) {
        // Explicit aliases share packaged fonts without exposing the app's asset directory.
        const fontFiles = {
            '/remote-font.ttf': 'manrope-regular.ttf',
            '/remote-font-bold.ttf': 'manrope-bold.ttf'
        };
        if (Object.hasOwn(fontFiles, pathname)) {
            fs.readFile(path.join(__dirname, 'assets', 'fonts', fontFiles[pathname]), (err, content) => {
                if (err) {
                    res.writeHead(404);
                    return res.end('Not Found');
                }
                res.writeHead(200, { 'Content-Type': 'font/ttf' });
                res.end(content);
            });
            return;
        }
        let filePath = pathname === '/' || pathname === '/index.html'
            ? path.join(this.clientDir, 'index.html')
            : path.join(this.clientDir, pathname);

        // Security check: keep inside clientDir
        const resolved = path.resolve(filePath);
        const relative = path.relative(path.resolve(this.clientDir), resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            res.writeHead(403);
            return res.end('Access denied');
        }

        fs.readFile(resolved, (err, content) => {
            if (err) {
                // If not found, fallback to index.html for SPA
                const indexPath = path.join(this.clientDir, 'index.html');
                fs.readFile(indexPath, (err2, indexContent) => {
                    if (err2) {
                        res.writeHead(404);
                        return res.end('Not Found');
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(indexContent);
                });
                return;
            }

            const ext = path.extname(resolved).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.json': 'application/json',
                '.png': 'image/png',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon'
            };

            const contentType = mimeTypes[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        });
    }
}

module.exports = { CASRemoteServer };
