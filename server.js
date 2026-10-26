const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Port 80 allows TV users to just type IP without ':3000', with fallback to 3000
const PREFERRED_PORT = 80;
const FALLBACK_PORT = 3000;
let CURRENT_PORT = PREFERRED_PORT;

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ iface: name, ip: net.address });
      }
    }
  }
  return addresses;
}

// In-memory Room & Pairing code management
const pairingRooms = new Map(); // code -> { presenter: client, viewers: Set<client> }

function generatePairingCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

// Lightweight WebSocket server implementation without third-party dependencies
class SimpleWebSocketServer {
  constructor(server) {
    this.clients = new Set();
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ];

    socket.write(headers.join('\r\n'));

    const client = {
      socket,
      id: Math.random().toString(36).substring(2, 9),
      role: 'unknown',
      roomCode: null
    };

    this.clients.add(client);

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) break;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) break;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskKeyLen = isMasked ? 4 : 0;
        if (buffer.length < offset + maskKeyLen + payloadLen) {
          break;
        }

        let mask = null;
        if (isMasked) {
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        const payload = buffer.subarray(offset, offset + payloadLen);
        buffer = buffer.subarray(offset + payloadLen);

        if (isMasked && mask) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }

        if (opcode === 0x8) {
          // Close frame
          socket.end();
          this.removeClient(client);
          return;
        } else if (opcode === 0x9) {
          // Ping -> Pong
          this.sendFrame(socket, 0xa, payload);
        } else if (opcode === 0x1) {
          // Text frame
          const str = payload.toString('utf8');
          this.handleMessage(client, str);
        }
      }
    });

    socket.on('close', () => {
      this.removeClient(client);
    });

    socket.on('error', (err) => {
      console.warn('Socket error on client', client.id, err.message);
      this.removeClient(client);
    });

    this.send(client, { type: 'welcome', id: client.id });
  }

  removeClient(client) {
    this.clients.delete(client);
    if (client.roomCode && pairingRooms.has(client.roomCode)) {
      const room = pairingRooms.get(client.roomCode);
      if (room.presenter === client) {
        console.log(`[-] Presenter left room [ ${client.roomCode} ]`);
        for (const viewer of room.viewers) {
          this.send(viewer, { type: 'presenter-left' });
        }
        pairingRooms.delete(client.roomCode);
      } else {
        room.viewers.delete(client);
        console.log(`[-] TV viewer left room [ ${client.roomCode} ]`);
        if (room.presenter) {
          this.send(room.presenter, { type: 'viewer-left', id: client.id, viewersCount: room.viewers.size });
        }
      }
    }
  }

  handleMessage(sender, rawStr) {
    try {
      const data = JSON.parse(rawStr);

      // Presenter registers
      if (data.type === 'register-presenter') {
        sender.role = 'presenter';
        let code = data.code || generatePairingCode();
        while (pairingRooms.has(code) && pairingRooms.get(code).presenter !== sender) {
          code = generatePairingCode();
        }
        sender.roomCode = code;

        // Check if there was an existing room with viewers or create fresh
        const existingRoom = pairingRooms.get(code);
        const viewers = existingRoom ? existingRoom.viewers : new Set();
        pairingRooms.set(code, { presenter: sender, viewers });

        console.log(`[+] Presenter created / restored Room: [ ${code} ]`);
        this.send(sender, { type: 'room-created', code: code });

        // If viewers are already in the room, notify presenter and viewers to link
        for (const viewer of viewers) {
          this.send(viewer, { type: 'join-success', code: code, presenterId: sender.id });
          this.send(sender, { type: 'viewer-joined', id: viewer.id, viewersCount: viewers.size });
        }
        return;
      }

      // Viewer registers
      if (data.type === 'register-viewer') {
        sender.role = 'viewer';
        let targetCode = data.code;

        // Auto-join if there is only 1 room active, or if code isn't passed
        if (!targetCode && pairingRooms.size > 0) {
          targetCode = pairingRooms.keys().next().value;
        }

        if (targetCode && pairingRooms.has(targetCode)) {
          const room = pairingRooms.get(targetCode);
          sender.roomCode = targetCode;
          room.viewers.add(sender);

          this.send(sender, { type: 'join-success', code: targetCode, presenterId: room.presenter ? room.presenter.id : null });
          if (room.presenter) {
            this.send(room.presenter, { type: 'viewer-joined', id: sender.id, viewersCount: room.viewers.size });
          }
          console.log(`[+] TV viewer connected to room [ ${targetCode} ]`);
        } else {
          // Put viewer into a default pending room or wait for presenter
          let defaultRoomCode = pairingRooms.keys().next().value;
          if (defaultRoomCode) {
            const room = pairingRooms.get(defaultRoomCode);
            sender.roomCode = defaultRoomCode;
            room.viewers.add(sender);
            this.send(sender, { type: 'join-success', code: defaultRoomCode, presenterId: room.presenter ? room.presenter.id : null });
            if (room.presenter) {
              this.send(room.presenter, { type: 'viewer-joined', id: sender.id, viewersCount: room.viewers.size });
            }
          } else {
            this.send(sender, { type: 'waiting-for-stream', availableRooms: Array.from(pairingRooms.keys()) });
          }
        }
        return;
      }

      // Direct WebRTC signaling forwarding between PC and TV
      if (data.target) {
        for (const client of this.clients) {
          if (client.id === data.target) {
            this.send(client, { ...data, from: sender.id });
            break;
          }
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  }

  send(client, obj) {
    if (client && client.socket && client.socket.writable) {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      this.sendFrame(client.socket, 0x1, payload);
    }
  }

  sendFrame(socket, opcode, payload) {
    let header;
    const len = payload.length;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    socket.write(Buffer.concat([header, payload]));
  }
}

// HTTP Static File Server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];

  // API endpoint
  if (reqPath === '/api/info') {
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] ? ips[0].ip : 'localhost';
    const activeCode = pairingRooms.keys().next().value || null;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      ip: primaryIp,
      port: CURRENT_PORT,
      code: activeCode,
      tvUrl: CURRENT_PORT === 80 ? `http://${primaryIp}/tv` : `http://${primaryIp}:${CURRENT_PORT}/tv`
    }));
    return;
  }

  // Friendly TV endpoints
  if (reqPath === '/tv' || reqPath === '/t' || reqPath === '/tv.html') {
    reqPath = '/tv.html';
  } else if (reqPath === '/' || reqPath === '') {
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const isTV = userAgent.includes('smart-tv') ||
                 userAgent.includes('smarttv') ||
                 userAgent.includes('tizen') ||
                 userAgent.includes('webos') ||
                 userAgent.includes('hbbtv') ||
                 userAgent.includes('crkey') ||
                 userAgent.includes('googletv') ||
                 userAgent.includes('appletv') ||
                 userAgent.includes('firetv') ||
                 userAgent.includes('aft');

    reqPath = isTV ? '/tv.html' : '/index.html';
  }

  const filePath = path.join(__dirname, 'public', reqPath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error');
      }
    } else {
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    }
  });
});

const wsServer = new SimpleWebSocketServer(server);

function startServer(port) {
  server.listen(port, '0.0.0.0', () => {
    CURRENT_PORT = port;
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] ? ips[0].ip : '127.0.0.1';
    const portStr = port === 80 ? '' : `:${port}`;

    console.log('\n========================================================');
    console.log('   🚀 AIRCAST - SUPER EASY PC TO TV BROADCAST');
    console.log('========================================================\n');
    console.log(`  1. PC Presenter (Share Screen):`);
    console.log(`     👉 http://localhost${portStr}`);
    console.log(`\n  2. TV Browser (Smart TV / FireStick):`);
    console.log(`     👉 http://${primaryIp}${portStr}/tv`);
    console.log(`     (Or http://${primaryIp}${portStr} - Auto TV detection)`);
    console.log('\n========================================================\n');
  }).on('error', (err) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      if (port !== FALLBACK_PORT) {
        console.log(`Port ${port} not available/requires admin. Switching to port ${FALLBACK_PORT}...`);
        startServer(FALLBACK_PORT);
      } else {
        console.error('Failed to start server:', err);
      }
    }
  });
}

startServer(PREFERRED_PORT);
