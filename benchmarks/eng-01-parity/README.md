# ENG-01 pixel parity harness

This deterministic WebGL2 scene harness drives `captureFrame()` for crowd,
overview, and text-heavy scenes. Run it from an app worktree that has Vite,
React, and Playwright installed.

From the app's `apps/web` directory, start the harness against either XIP
checkout:

```sh
XIP_PARITY_RENDER=/absolute/path/to/xip/integrations/xip/dist/render.js \
  pnpm exec vite --config /absolute/path/to/xip/benchmarks/eng-01-parity/vite.config.mjs --host 127.0.0.1
```

Open `http://127.0.0.1:5173/?scene=crowd`, `?scene=overview`, and
`?scene=text-heavy`. In a browser page context, await
`window.__parityCapture()` to get a PNG data URL. Compare each base PNG with its
PR-build PNG using ImageMagick's absolute-error metric:

```sh
magick compare -metric AE base.png strip.png null:
```

The tested base is commit `2e1809f20c1b2c0a51e96a9cb690ebe4a1c8e228` and the
strip build is the ENG-01 PR head. Both use the same browser, viewport, scenes,
and deterministic inputs.
