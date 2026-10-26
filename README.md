# AirCast (SachCast) 🚀
Wireless screen broadcasting like Google Meet to share your PC screen to any Smart TV with ultra-low latency.

## Features
- **Zero App Installation on TV**: Works directly on any Smart TV browser (Samsung Tizen, LG webOS, Android TV, Fire TV, Apple TV).
- **WebRTC P2P Ultra-Low Latency**: Near zero latency 60fps streaming (~50ms) built with native WebRTC.
- **Audio Streaming**: Stream PC system audio or tab audio alongside screen capture.
- **Easy Pairing Code**: 4-digit code and QR code for instant pairing.
- **Short URL**: Access via clean `/tv` URL with automatic TV user-agent detection.
- **Zero External Dependencies**: Pure Node.js built-in modules (`http`, `crypto`, `os`, `fs`).

## Quick Start

### 1. Run the Server
Double-click `start_broadcast.bat` or run:
```bash
node server.js
```

### 2. On Your PC (Presenter)
Open Chrome, Edge, or Brave:
```
http://localhost
```
Click **"Share Screen"** and pick Entire Screen or Application Window.

### 3. On Your Smart TV (Viewer)
Open your TV browser and type:
```
http://<YOUR-PC-IP>/tv
```
Or scan the QR code shown on your PC with your mobile/tablet camera!
