"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const publicDirectory = path.join(__dirname, "public");
const port = Number.parseInt(process.env.PORT || "3000", 10);
const defaultIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const rooms = new Map();
const websocketKey = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const maxMessageBytes = 64 * 1024;
const roomPattern = /^[A-Za-z0-9_-]{6,32}$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const relayTypes = new Set([
  "sync-request",
  "sync-response",
  "start",
  "stop",
  "visibility",
  "clock-correction"
]);

function iceServers() {
  if (!process.env.ICE_SERVERS) return defaultIceServers;

  try {
    const servers = JSON.parse(process.env.ICE_SERVERS);
    if (!Array.isArray(servers)) throw new Error("must be an array");
    return servers;
  } catch (error) {
    console.error(`Invalid ICE_SERVERS JSON (${error.message}); using the default STUN server.`);
    return defaultIceServers;
  }
}

async function sendFile(response, fileName, contentType) {
  const body = await fs.readFile(path.join(publicDirectory, fileName));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const requestPath = new URL(request.url, "http://localhost").pathname;
  try {
    if (requestPath === "/" || requestPath === "/index.html") {
      if (request.method === "HEAD") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end();
      } else {
        await sendFile(response, "index.html", "text/html; charset=utf-8");
      }
      return;
    }

    if (requestPath === "/config.js") {
      const body = `window.SYNC_TIMER_CONFIG = ${JSON.stringify({ iceServers: iceServers() })};\n`;
      response.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

  } catch (error) {
    console.error(error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

function rejectUpgrade(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function websocketFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  return Buffer.concat([header, payload]);
}

function sendMessage(peer, message) {
  if (!peer.closed) peer.socket.write(websocketFrame(0x1, Buffer.from(JSON.stringify(message))));
}

function removePeer(peer) {
  if (peer.removed) return;
  peer.removed = true;

  if (!peer.room || !peer.role) return;
  const room = rooms.get(peer.room);
  if (!room || room.get(peer.role) !== peer) return;

  room.delete(peer.role);
  const remainingPeer = room.values().next().value;
  if (remainingPeer) sendMessage(remainingPeer, { type: "peer-left", role: peer.role });
  if (room.size === 0) rooms.delete(peer.room);
}

function closePeer(peer, code = 1000) {
  if (peer.closed) return;
  console.warn(`Closing WebSocket peer with code ${code}.`);
  peer.closed = true;
  removePeer(peer);
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  peer.socket.end(websocketFrame(0x8, payload));
}

function handleMessage(peer, payload) {
  let message;
  try {
    message = JSON.parse(utf8Decoder.decode(payload));
  } catch {
    closePeer(peer, 1007);
    return;
  }

  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
    closePeer(peer, 1008);
    return;
  }

  if (!peer.room) {
    if (
      message.type !== "join" ||
      !roomPattern.test(message.room) ||
      (message.role !== "controller" && message.role !== "viewer")
    ) {
      closePeer(peer, 1008);
      return;
    }

    let room = rooms.get(message.room);
    if (!room) {
      room = new Map();
      rooms.set(message.room, room);
    }
    if (room.size >= 2 || room.has(message.role)) {
      closePeer(peer, 1008);
      return;
    }

    peer.room = message.room;
    peer.role = message.role;
    room.set(peer.role, peer);
    sendMessage(peer, { type: "joined", role: peer.role });

    const oppositeRole = peer.role === "controller" ? "viewer" : "controller";
    const oppositePeer = room.get(oppositeRole);
    if (oppositePeer) sendMessage(oppositePeer, { type: "peer-ready", role: peer.role });
    return;
  }

  if (!relayTypes.has(message.type)) {
    closePeer(peer, 1008);
    return;
  }

  const room = rooms.get(peer.room);
  const oppositeRole = peer.role === "controller" ? "viewer" : "controller";
  const oppositePeer = room && room.get(oppositeRole);
  if (oppositePeer) sendMessage(oppositePeer, message);
}

function validCloseCode(code) {
  return (
    code === 1000 || code === 1001 || code === 1002 || code === 1003 ||
    (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
  );
}

function handleWebSocket(socket) {
  const peer = { socket, room: null, role: null, closed: false, removed: false, buffer: Buffer.alloc(0) };

  socket.on("data", (chunk) => {
    if (peer.closed) return;
    peer.buffer = Buffer.concat([peer.buffer, chunk]);

    while (peer.buffer.length >= 2 && !peer.closed) {
      const first = peer.buffer[0];
      const second = peer.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let headerLength = 2;

      if ((first & 0x70) !== 0 || !fin || !masked) return closePeer(peer, 1002);
      if (length === 126) {
        if (peer.buffer.length < 4) return;
        length = peer.buffer.readUInt16BE(2);
        if (length < 126) return closePeer(peer, 1002);
        headerLength = 4;
      } else if (length === 127) {
        if (peer.buffer.length < 10) return;
        if (peer.buffer.readUInt32BE(2) !== 0) return closePeer(peer, 1009);
        length = peer.buffer.readUInt32BE(6);
        if (length <= 0xffff) return closePeer(peer, 1002);
        headerLength = 10;
      }

      const isControl = opcode >= 0x8;
      if ((isControl && length > 125) || length > maxMessageBytes) return closePeer(peer, 1009);
      const frameLength = headerLength + 4 + length;
      if (peer.buffer.length < frameLength) return;

      const mask = peer.buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(peer.buffer.subarray(headerLength + 4, frameLength));
      peer.buffer = peer.buffer.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x1) handleMessage(peer, payload);
      else if (opcode === 0x8) {
        if (payload.length === 1 || (payload.length >= 2 && !validCloseCode(payload.readUInt16BE(0)))) {
          closePeer(peer, 1002);
          return;
        }
        try {
          if (payload.length > 2) utf8Decoder.decode(payload.subarray(2));
        } catch {
          closePeer(peer, 1007);
          return;
        }
        peer.closed = true;
        removePeer(peer);
        socket.end(websocketFrame(0x8, payload));
      } else if (opcode === 0x9) socket.write(websocketFrame(0xA, payload));
      else if (opcode !== 0xA) closePeer(peer, 1002);
    }
  });

  socket.on("error", () => {
    peer.closed = true;
    removePeer(peer);
  });
  socket.on("close", () => removePeer(peer));
}

server.on("upgrade", (request, socket) => {
  const requestPath = new URL(request.url, "http://localhost").pathname;
  if (request.method !== "GET") return rejectUpgrade(socket, 405, "Method Not Allowed");
  if (requestPath !== "/signal") return rejectUpgrade(socket, 404, "Not Found");

  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (
    typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket" ||
    typeof connection !== "string" || !connection.toLowerCase().split(/\s*,\s*/).includes("upgrade") ||
    typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    version !== "13"
  ) {
    return rejectUpgrade(socket, 400, "Bad Request");
  }

  const accept = crypto.createHash("sha1").update(key + websocketKey).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  handleWebSocket(socket);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Sync Timer listening on port ${port}`);
});
