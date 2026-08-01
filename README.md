# Sync Timer

Small Node.js container that serves a browser-based, best-effort synchronized timer. It uses a WebRTC data channel and manual offer/answer exchange, so it does not need a signaling service for basic use.

## Important limitation

This project cannot guarantee a 1 ms start across independent Internet connections. Browser timer scheduling, WebRTC jitter, packet-route asymmetry, display refresh, and display scan-out all add uncertainty. The page estimates the network portion of that uncertainty after calibration.

For a 1 ms requirement, use a common hardware time source such as PTP on a controlled LAN or GPS/PPS-equipped devices. Do not use this application where an exact start time is safety-critical.

## Run with Docker

```sh
docker build -t sync-timer .
docker run --rm -p 3000:3000 sync-timer
```

Open `http://localhost:3000` on both devices. The container must be reachable from both devices; `localhost` only works on the host running Docker.

## Connect devices

1. On the controlling device, select **I am the controller**, then **Create invitation**.
2. Copy the invitation to the viewer device.
3. On the viewer, select **I am the viewer**, paste the invitation, and select **Create response**.
4. Copy the viewer response into the controller and select **Connect viewer**.
5. When the status says **Devices connected**, select **Schedule and start** on the controller.

Use **Stop timer** or **Restart timer** on the controller without reconnecting either device. Select **New connection** to discard the link and connect another device.

The controller takes 12 timing samples, retains the three lowest-latency samples, and schedules a start three seconds in the future. This reduces the effect of jitter but cannot eliminate it.

## TURN configuration

The bundled public STUN server is only for testing. It cannot connect every pair of Internet networks. Set `ICE_SERVERS` to include your TURN server in production:

```sh
docker run --rm -p 3000:3000 \
  -e 'ICE_SERVERS=[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"password"}]' \
  sync-timer
```

TURN credentials are delivered to browsers in `config.js`; use short-lived, per-session credentials rather than a long-lived secret. TLS is required for production hosting, as WebRTC and secure contexts have browser-specific restrictions.
