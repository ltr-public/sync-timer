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

1. Open the page on the controlling device and select **Create offer**.
2. Copy the generated token into the display device and select **Accept offer**.
3. Copy that generated answer back into the controller and select **Accept answer**.
4. When connected, select **Calibrate and start** on the controller.

The controller takes 12 timing samples, retains the three lowest-latency samples, and schedules a start three seconds in the future. This reduces the effect of jitter but cannot eliminate it.

## TURN configuration

The bundled public STUN server is only for testing. It cannot connect every pair of Internet networks. Set `ICE_SERVERS` to include your TURN server in production:

```sh
docker run --rm -p 3000:3000 \
  -e 'ICE_SERVERS=[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"password"}]' \
  sync-timer
```

TURN credentials are delivered to browsers in `config.js`; use short-lived, per-session credentials rather than a long-lived secret. TLS is required for production hosting, as WebRTC and secure contexts have browser-specific restrictions.
