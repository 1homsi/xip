// Vertex shader — instanced quad renderer
// Each instance represents one sprite or particle.
//
// Layout (per-vertex, location 0–1):
//   a_quadPos  vec2  (-0.5..0.5, -0.5..0.5) unit quad corners
//   a_uv       vec2  (0..1, 0..1) corresponding UVs
//
// Layout (per-instance, location 2–10):
//   i_pos      vec2  world-space position
//   i_size     vec2  draw width / height (already includes scaleX/Y and squash)
//   i_rot      float rotation in radians
//   i_anchor   vec2  (anchorX, anchorY) 0=left/top .. 1=right/bottom
//   i_offset   vec2  draw offset in local space
//   i_flipX    float 1.0 = flip horizontally, 0.0 = normal
//   i_flipY    float 1.0 = flip vertically, 0.0 = normal
//   i_color    vec4  RGBA (0..1 each)
//   i_uvRect   vec4  (u, v, uw, vh) normalised UV sub-rect for sprite sheets
export const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 a_quadPos;
layout(location = 1) in vec2 a_uv;

layout(location = 2) in vec2  i_pos;
layout(location = 3) in vec2  i_size;
layout(location = 4) in float i_rot;
layout(location = 5) in vec2  i_anchor;
layout(location = 6) in vec2  i_offset;
layout(location = 7) in float i_flipX;
layout(location = 8) in float i_flipY;
layout(location = 9) in vec4  i_color;
layout(location = 10) in vec4  i_uvRect;

uniform vec2  u_camPos;
uniform float u_zoom;
uniform vec2  u_canvasSize;
uniform vec2  u_shake;

out vec2 v_uv;
out vec4 v_color;

void main() {
  // Local position: map quad corner (-0.5..0.5) to draw rect, applying anchor
  vec2 local = (a_quadPos - vec2(i_anchor.x - 0.5, i_anchor.y - 0.5)) * i_size + i_offset;

  // Horizontal flip
  if (i_flipX > 0.5) local.x = -local.x;
  // Vertical flip
  if (i_flipY > 0.5) local.y = -local.y;

  // Rotate around local origin
  float c = cos(i_rot);
  float s = sin(i_rot);
  local = vec2(c * local.x - s * local.y, s * local.x + c * local.y);

  // World position
  vec2 world = i_pos + local;

  // Camera → NDC clip space (Y is flipped: canvas Y down, WebGL Y up)
  // Equivalent to Canvas2D: translate(W/2 - camX*zoom + shakeX, H/2 - camY*zoom + shakeY); scale(zoom,zoom)
  float cx = 2.0 * u_zoom / u_canvasSize.x * (world.x - u_camPos.x) + 2.0 * u_shake.x / u_canvasSize.x;
  float cy = -2.0 * u_zoom / u_canvasSize.y * (world.y - u_camPos.y) - 2.0 * u_shake.y / u_canvasSize.y;

  gl_Position = vec4(cx, cy, 0.0, 1.0);

  // Remap UV [0,1] to the sub-rect defined by i_uvRect
  v_uv    = i_uvRect.xy + a_uv * i_uvRect.zw;
  v_color = i_color;
}
`

export const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;

uniform sampler2D u_texture;
uniform int       u_useTexture;
// 1 while drawing with the 'multiply' blend: colour is premultiplied by alpha so
// DST_COLOR x ONE_MINUS_SRC_ALPHA gives dst * (1 - a + a * rgb).
uniform float     u_premul;

out vec4 fragColor;

void main() {
  if (u_useTexture == 1) {
    fragColor = texture(u_texture, v_uv) * v_color;
  } else {
    fragColor = v_color;
  }
  fragColor.rgb *= mix(1.0, fragColor.a, u_premul);
}
`

// ── Parallax layer shaders ────────────────────────────────────────────────────
// Draws a fullscreen NDC quad and tiles the texture using UV offsets.

export const PARALLAX_VERT_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;

out vec2 v_fragCoord;

void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  // Convert NDC (-1..1) to canvas pixel coords (0..canvasSize) in the frag shader
  v_fragCoord = a_pos * 0.5 + 0.5; // 0..1 normalized screen coord
}
`

export const PARALLAX_FRAG_SRC = `#version 300 es
precision mediump float;

in vec2 v_fragCoord;

uniform sampler2D u_texture;
uniform vec2      u_uvOffset;
uniform vec2      u_texSize;   // texture size in pixels
uniform vec2      u_canvasSize; // canvas size in pixels

out vec4 fragColor;

void main() {
  // Screen pixel position
  vec2 screenPx = v_fragCoord * u_canvasSize;
  // Tile: offset by uvOffset and wrap
  vec2 uv = mod((screenPx / u_texSize + u_uvOffset), 1.0);
  // Y must be flipped because WebGL origin is bottom-left but canvas is top-left
  uv.y = 1.0 - uv.y;
  fragColor = texture(u_texture, uv);
}
`

// ── Post-process shaders ──────────────────────────────────────────────────────
// These share PARALLAX_VERT_SRC as their vertex shader (fullscreen NDC quad).

/** Bloom extract: outputs pixels above the luminance threshold, scaled by brightness. */
export const BLOOM_EXTRACT_FRAG_SRC = `#version 300 es
precision mediump float;

in vec2 v_fragCoord;

uniform sampler2D u_scene;
uniform float     u_threshold;

out vec4 fragColor;

void main() {
  vec4 c = texture(u_scene, v_fragCoord);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float factor = max(0.0, lum - u_threshold) / max(0.001, 1.0 - u_threshold);
  fragColor = vec4(c.rgb * factor, 1.0);
}
`

/** Separable Gaussian blur (5-tap). Use u_direction=(1,0) for H, (0,1) for V. */
export const BLUR_FRAG_SRC = `#version 300 es
precision mediump float;

in vec2 v_fragCoord;

uniform sampler2D u_tex;
uniform vec2      u_direction;  // (1,0) = horizontal, (0,1) = vertical
uniform vec2      u_texelSize;  // (1/width, 1/height)

out vec4 fragColor;

void main() {
  const float w0 = 0.227027;
  const float w1 = 0.194595;
  const float w2 = 0.121622;
  const float w3 = 0.054054;
  const float w4 = 0.016216;

  vec2 off = u_direction * u_texelSize;
  vec3 result = texture(u_tex, v_fragCoord).rgb * w0;
  result += texture(u_tex, v_fragCoord + off * 1.0).rgb * w1;
  result += texture(u_tex, v_fragCoord - off * 1.0).rgb * w1;
  result += texture(u_tex, v_fragCoord + off * 2.0).rgb * w2;
  result += texture(u_tex, v_fragCoord - off * 2.0).rgb * w2;
  result += texture(u_tex, v_fragCoord + off * 3.0).rgb * w3;
  result += texture(u_tex, v_fragCoord - off * 3.0).rgb * w3;
  result += texture(u_tex, v_fragCoord + off * 4.0).rgb * w4;
  result += texture(u_tex, v_fragCoord - off * 4.0).rgb * w4;
  fragColor = vec4(result, 1.0);
}
`

/**
 * Final composite: combines scene + blurred bloom, then applies vignette,
 * chromatic aberration, and scanlines as uniform-controlled shader effects.
 */
export const COMPOSITE_FRAG_SRC = `#version 300 es
precision mediump float;

in vec2 v_fragCoord;

uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float     u_bloomIntensity;
uniform float     u_vignetteIntensity;
uniform float     u_caOffset;        // pixels to shift R/B channels
uniform float     u_caEnabled;       // 0.0 = off, 1.0 = on
uniform vec2      u_texelSize;       // (1/width, 1/height)
uniform float     u_scanlineGap;     // rows between scanlines (0 = disabled)
uniform float     u_scanlineOpacity; // darkness of each scanline
uniform vec2      u_canvasSize;

out vec4 fragColor;

void main() {
  vec2 uv = v_fragCoord;

  // Chromatic aberration: shift R right, B left
  vec3 col;
  if (u_caEnabled > 0.5) {
    float ox = u_caOffset * u_texelSize.x;
    col.r = texture(u_scene, vec2(uv.x + ox, uv.y)).r;
    col.g = texture(u_scene, uv).g;
    col.b = texture(u_scene, vec2(uv.x - ox, uv.y)).b;
  } else {
    col = texture(u_scene, uv).rgb;
  }

  // Additive bloom
  col += texture(u_bloom, uv).rgb * u_bloomIntensity;

  // Scanlines: darken every nth row
  if (u_scanlineGap > 0.5) {
    float row = floor(uv.y * u_canvasSize.y);
    if (mod(row, u_scanlineGap) < 1.0) col *= (1.0 - u_scanlineOpacity);
  }

  // Vignette: radial darkening toward edges
  if (u_vignetteIntensity > 0.0) {
    vec2 vig = uv * 2.0 - 1.0;
    float dist = length(vig);
    float factor = smoothstep(0.3, 1.0, dist);
    col = mix(col, vec3(0.0), factor * u_vignetteIntensity);
  }

  fragColor = vec4(col, 1.0);
}
`
