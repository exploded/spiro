# Spiro

A browser-based Spirograph drawing app. Multi-arm rotating epicycles produce
intricate rosettes that close cleanly because every rotation rate is an
integer.

![spirograph rosette](static/screenshot.png)

## Features

- **Two input modes**: free integer ratios per arm (2–5 arms), or classic
  Spirograph teeth counts (outer ring + inner gear, hypo or epi).
- **Three visualisations**: rotating arms, real toothed gears, or just the
  pen trail.
- **Pan and zoom** the canvas while the pattern is being drawn.
- **Rainbow** colour mode tied to the rotation ratios, plus solid colour and
  bg picker.
- **Generated audio chord**: one oscillator per arm at frequencies derived
  from the lab-frame rotation rates.
- **Eccentricity**: arms 2+ can trace ellipses that tilt with their parent.
- **Save PNG** export.

## Running locally

Windows:

```bat
build.bat
```

Then open <http://localhost:8484>. `run.bat` skips the build step on
subsequent runs.

The main environment variable is `PORT` (defaults to 8484). It's read from
a `.env` file if present. `MONITOR_URL` and `MONITOR_API_KEY` optionally ship
warnings and errors to the monitor portal.

## Deployment

Live at <https://spiro.mchugh.au>. Pushing to `main` runs
`.github/workflows/deploy.yml`: tests, then a Linux build that's copied to the
Linode with `templates/` and `static/` and installed by
`scripts/deploy-spiro`. The app listens on `127.0.0.1:8993` behind Caddy.

One-time server setup is `scripts/server-setup.sh`, which creates
`/var/www/spiro`, the `.env`, the systemd unit and the sudoers entry, and
prints the Caddy site block. The Caddy block must set
`header_up X-Real-IP {client_ip}` or rate limiting treats every visitor as one.

## Architecture

Pure Go HTTP server (`spiro.go`) serving HTML templates and static assets;
all spirograph maths and rendering happens client-side in
[`static/spiro.js`](static/spiro.js) using Canvas2D. No JS framework, no
external API, no telemetry.

See `/about` in the running app for the maths.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
