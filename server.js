const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PRIMARY_PORT = 80;
const SECONDARY_PORT = 3000;

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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Rooms state: code -> { presenter: wsClient, viewers: Set<wsClient> }
const rooms = new Map();
let defaultRoomCode = '7777';

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function parseDeviceName(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (ua.includes('tizen')) return 'Samsung Smart TV';
  if (ua.includes('webos')) return 'LG webOS Smart TV';
  if (ua.includes('googletv') || ua.includes('crkey')) return 'Google TV / Chromecast';
  if (ua.includes('firetv') || ua.includes('aft')) return 'Amazon Fire TV';
  if (ua.includes('apple') && ua.includes('appletv')) return 'Apple TV';
  if (ua.includes('android')) return 'Android TV / Mobile';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'iPhone / iPad';
  if (ua.includes('windows')) return 'Windows PC / TV';
  if (ua.includes('macintosh')) return 'Mac';
  if (ua.includes('smart-tv') || ua.includes('smarttv') || ua.includes('tv')) return 'Smart TV Device';
  return 'Web Browser TV';
}

function handleHttpRequest(req, res) {
  let reqPath = req.url.split('?')[0];
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const clientIp = req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^.*:/, '') : 'Unknown';

  // API endpoint for dynamic configuration
  if (reqPath === '/api/info') {
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] ? ips[0].ip : '127.0.0.1';
    const activeCode = rooms.keys().next().value || defaultRoomCode;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      ip: primaryIp,
      ips: ips.map(i => i.ip),
      portPrimary: PRIMARY_PORT,
      portSecondary: SECONDARY_PORT,
      activeCode,
      clientIp,
      urls: {
        short: `http://${primaryIp}`,
        short3000: `http://${primaryIp}:${SECONDARY_PORT}`,
        tv: `http://${primaryIp}/tv`,
        tv3000: `http://${primaryIp}:${SECONDARY_PORT}/tv`
      }
    }));
    return;
  }

  // Health check
  if (reqPath === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  // TV clean routing
  if (reqPath === '/tv' || reqPath === '/t' || reqPath === '/tv.html' || reqPath === '/viewer') {
    reqPath = '/tv.html';
  } else if (reqPath === '/' || reqPath === '') {
    // If request comes from a TV browser user agent, automatically route to TV view!
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
}

// Global WebSocket setup
const allClients = new Set();

function setupWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^.*:/, '') : 'Unknown';
    const userAgent = req.headers['user-agent'] || '';
    const deviceName = parseDeviceName(userAgent);

    ws.id = Math.random().toString(36).substring(2, 9);
    ws.ip = clientIp;
    ws.deviceName = deviceName;
    ws.role = 'unknown';
    ws.roomCode = null;
    ws.isAlive = true;

    allClients.add(ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (message, isBinary) => {
      // Handle binary stream frames (Universal Canvas Fallback Mode)
      if (isBinary) {
        if (ws.roomCode && rooms.has(ws.roomCode)) {
          const room = rooms.get(ws.roomCode);
          if (ws === room.presenter) {
            // Forward binary video/audio frame directly to all viewers in room
            for (const viewer of room.viewers) {
              if (viewer.readyState === WebSocket.OPEN) {
                viewer.send(message, { binary: true });
              }
            }
          }
        }
        return;
      }

      // Handle JSON text messages
      try {
        const data = JSON.parse(message.toString('utf8'));

        // Presenter registers
        if (data.type === 'register-presenter') {
          ws.role = 'presenter';
          let code = data.code || defaultRoomCode;
          ws.roomCode = code;

          const existingRoom = rooms.get(code);
          const viewers = existingRoom ? existingRoom.viewers : new Set();
          rooms.set(code, { presenter: ws, viewers });

          console.log(`[+] Presenter connected. Room: [ ${code} ] from ${clientIp}`);

          safeSend(ws, {
            type: 'room-created',
            code,
            viewers: Array.from(viewers).map(v => ({ id: v.id, ip: v.ip, deviceName: v.deviceName }))
          });

          // Notify any waiting viewers that presenter is now ready
          for (const viewer of viewers) {
            safeSend(viewer, {
              type: 'presenter-connected',
              presenterId: ws.id,
              code
            });
            safeSend(ws, {
              type: 'viewer-joined',
              id: viewer.id,
              ip: viewer.ip,
              deviceName: viewer.deviceName,
              viewersCount: viewers.size
            });
          }
          return;
        }

        // Viewer (Smart TV) registers
        if (data.type === 'register-viewer') {
          ws.role = 'viewer';
          let targetCode = data.code;

          // Auto-join existing room if no code specified
          if (!targetCode) {
            targetCode = rooms.keys().next().value || defaultRoomCode;
          }

          ws.roomCode = targetCode;

          if (!rooms.has(targetCode)) {
            rooms.set(targetCode, { presenter: null, viewers: new Set([ws]) });
          } else {
            rooms.get(targetCode).viewers.add(ws);
          }

          const room = rooms.get(targetCode);
          console.log(`[+] TV Receiver connected [ ${deviceName} (${clientIp}) ] to room: [ ${targetCode} ]`);

          safeSend(ws, {
            type: 'join-success',
            code: targetCode,
            hasPresenter: !!room.presenter,
            presenterId: room.presenter ? room.presenter.id : null,
            deviceName
          });

          if (room.presenter) {
            safeSend(room.presenter, {
              type: 'viewer-joined',
              id: ws.id,
              ip: clientIp,
              deviceName,
              viewersCount: room.viewers.size
            });
          }
          return;
        }

        // WebRTC Signaling forwarding (offer, answer, candidate)
        if (data.target) {
          for (const client of allClients) {
            if (client.id === data.target && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ ...data, from: ws.id }));
              break;
            }
          }
          return;
        }

        // Broadcast to partner in room
        if (ws.roomCode && rooms.has(ws.roomCode)) {
          const room = rooms.get(ws.roomCode);
          if (ws === room.presenter) {
            for (const viewer of room.viewers) {
              safeSend(viewer, { ...data, from: ws.id });
            }
          } else if (room.presenter) {
            safeSend(room.presenter, { ...data, from: ws.id });
          }
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      if (ws.roomCode && rooms.has(ws.roomCode)) {
        const room = rooms.get(ws.roomCode);
        if (room.presenter === ws) {
          console.log(`[-] Presenter disconnected from room [ ${ws.roomCode} ]`);
          room.presenter = null;
          for (const viewer of room.viewers) {
            safeSend(viewer, { type: 'presenter-disconnected' });
          }
        } else {
          room.viewers.delete(ws);
          console.log(`[-] TV viewer disconnected: [ ${ws.deviceName} ]`);
          if (room.presenter) {
            safeSend(room.presenter, {
              type: 'viewer-left',
              id: ws.id,
              viewersCount: room.viewers.size
            });
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.warn('WS error on client', ws.id, err.message);
    });

    safeSend(ws, { type: 'welcome', id: ws.id, clientIp, deviceName });
  });
}

function safeSend(client, obj) {
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(obj));
  }
}

// Keep-alive ping interval
setInterval(() => {
  for (const client of allClients) {
    if (!client.isAlive) {
      client.terminate();
      allClients.delete(client);
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 15000);

// Initialize dual servers: Port 80 AND Port 3000
const serverPrimary = http.createServer(handleHttpRequest);
const serverSecondary = http.createServer(handleHttpRequest);

const wssPrimary = new WebSocket.Server({ server: serverPrimary });
const wssSecondary = new WebSocket.Server({ server: serverSecondary });

setupWebSocket(wssPrimary);
setupWebSocket(wssSecondary);

function startServers() {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] ? ips[0].ip : '127.0.0.1';

  serverPrimary.listen(PRIMARY_PORT, '0.0.0.0', () => {
    console.log(`[✓] Primary Server running on Port ${PRIMARY_PORT}`);
  }).on('error', (err) => {
    console.log(`[!] Port ${PRIMARY_PORT} note: ${err.message}. Port ${SECONDARY_PORT} is active.`);
  });

  serverSecondary.listen(SECONDARY_PORT, '0.0.0.0', () => {
    console.log(`[✓] Secondary Server running on Port ${SECONDARY_PORT}`);
    printBanner(primaryIp);
  }).on('error', (err) => {
    console.error(`[!] Failed to start on secondary port ${SECONDARY_PORT}:`, err);
  });
}

function printBanner(ip) {
  console.log('\n================================================================');
  console.log('   🚀 SACHCAST WIRELESS PC TO TV BROADCASTER (ALL FIXES APPLIED)');
  console.log('================================================================\n');
  console.log('  1. ON YOUR PC (Presenter):');
  console.log(`     👉 Open Chrome or Edge: http://localhost  (or http://localhost:${SECONDARY_PORT})`);
  console.log('\n  2. ON YOUR SMART TV (Viewer):');
  console.log(`     👉 Open TV Browser:     http://${ip}/tv`);
  console.log(`     (Or directly:           http://${ip}:${SECONDARY_PORT}/tv)`);
  console.log('\n  ✨ WebRTC 60fps Ultra-Low Latency + Universal Canvas Fallback Active');
  console.log('================================================================\n');
}

startServers();
