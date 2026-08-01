"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");

const publicDirectory = path.join(__dirname, "public");
const port = Number.parseInt(process.env.PORT || "3000", 10);
const defaultIceServers = [{ urls: "stun:stun.l.google.com:19302" }];

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

server.listen(port, "0.0.0.0", () => {
  console.log(`Sync Timer listening on port ${port}`);
});
