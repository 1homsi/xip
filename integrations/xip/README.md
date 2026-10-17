# xip

**Build browser games with React.**

```tsx
<Game width={800} height={500} gravity={980}>
  <World background="#1a1a2e">
    <Camera2D followEntity="player" smoothing={0.85} />
    <Entity id="player" tags={['player']}>
      <Transform x={100} y={300} />
      <Sprite width={32} height={48} color="#4fc3f7" />
      <RigidBody />
      <BoxCollider width={32} height={48} />
      <Script update={playerUpdate} />
    </Entity>
    <Entity tags={['ground']}>
      <Transform x={400} y={480} />
      <Sprite width={800} height={32} color="#37474f" />
      <RigidBody isStatic />
      <BoxCollider width={800} height={32} />
    </Entity>
  </World>
</Game>
```

## Install

```bash
npm install xipjs react react-dom
```

## What's included

- **ECS** — archetype-based entity-component-system with query caching
- **Physics** — two-pass AABB, kinematic bodies, one-way platforms, 60 Hz fixed timestep
- **Renderer** — WebGL2 instanced renderer, with an automatic Canvas2D fallback (`<Game renderer>`)
- **Input** — keyboard, mouse, gamepad, per-player input maps, input contexts, recording/playback
- **Audio** — Web Audio API with volume groups, fade, crossfade, ducking (`useSound`, `useMusic`, `getAudioManager()`)
- **Gameplay hooks** — `usePlatformerController`, `useTopDownMovement`, `useHealth`, `useSave`, `useGameStateMachine`, `useLevelTransition`, `usePathfinding`, `useAISteering`, and more
- **DevTools** — time-travel frame scrubber and entity inspector (`<Game devtools>`)
- **Deterministic mode** — seeded RNG for reproducible simulations (`<Game deterministic seed={n}>`)

## Quick example

```tsx
import {
  Game, World, Entity, Transform, Sprite,
  RigidBody, BoxCollider, Script,
  usePlatformerController, useHealth, useSound,
} from 'xipjs'

function Player() {
  const id = useEntity()
  usePlatformerController(id, { speed: 220, jumpForce: -520, maxJumps: 2 })
  const { hp, takeDamage } = useHealth(5, { onDeath: () => console.log('dead') })
  const jump = useSound('/jump.wav', { group: 'sfx' })
  return null
}

export default function MyGame() {
  return (
    <Game width={800} height={500} gravity={980}>
      <World background="#1a1a2e">
        <Camera2D followEntity="player" smoothing={0.87} />
        <Entity id="player" tags={['player']}>
          <Transform x={100} y={300} />
          <Sprite src="/player.png" width={32} height={48} />
          <RigidBody />
          <BoxCollider width={30} height={48} />
          <Player />
        </Entity>
      </World>
    </Game>
  )
}
```

## Audio lifecycle and app-level soundtracks

All audio goes through one shared `AudioContext` and one mixer (`sfx` / `music` / any group → master). That
state lives on the page, not in `<Game>`: mounting, unmounting or remounting a `<Game>` (new save, scene
change, StrictMode, HMR) never closes the context, stops a soundtrack, or resets volume and mute.

- The context is created lazily, once. If the browser starts it suspended, the first `pointerdown`, `keydown`
  or `touchend` resumes it (and again after the browser suspends or interrupts it later).
- Master volume, group volumes and mutes persist across `<Game>` remounts. `saveAudioSettings()` /
  `loadAudioSettings()` persist them across page loads.
- Hooks (`useSound`, `useMusic`) stop what *they* started when their component unmounts, so one inside
  `<Game>` stops with the Game. Pass `persistent: true` to keep it playing.
- Nothing in the engine closes the shared context. `getAudioManager().dispose()` does, and keeps your volumes.
- `useMusic` only stops the track its own component started; an unrelated component unmounting no longer
  stops the app's soundtrack.

For a soundtrack that must outlive any `<Game>`, start it from outside React or from an app-level component:

```tsx
import { getAudioManager, useMusic } from 'xipjs'

// Option 1: no React at all (module scope, a store, an event handler)
const audio = getAudioManager()
audio.setVolume(0.6)
void audio.playMusic('/music/theme.ogg', { volume: 0.5, fade: 2 }) // audible after the first gesture
audio.setMuted(true) // survives every Game remount; setMuted(false) restores the volume

// Option 2: a component that lives above <Game> in the tree
function Soundtrack() {
  const music = useMusic('/music/theme.ogg', { volume: 0.5 })
  useEffect(() => music.play(2), [])
  return null
}

export default function App() {
  const [run, setRun] = useState(1)
  return (
    <>
      <Soundtrack />
      <Game key={run}>{/* remounting this keeps the music playing */}</Game>
    </>
  )
}
```

`getAudioManager()` also has `playSound(src, { group })`, `setGroupVolume` / `setGroupMuted`, `playMusic`
(crossfades; one track at a time), `stopMusic(fade)`, `stopAll()`, `resume()` and `context`. Audio lives in
`@xip/audio` and is not part of the `xipjs/render` entry, so apps that do not use it do not pay for it.

## Large tile worlds: `<TileLayer>`

`<Tilemap>` loads Tiled maps and creates one entity + sprite per tile, which is fine for small levels.
For big, mostly static grids (hundreds of thousands of tiles) use `<TileLayer>`: the tiles live in one
typed array and are drawn by the GPU, never as entities.

```tsx
import { TileLayer, useTileLayer, Camera2D } from 'xipjs'

function Ground({ sim }) {
  const ground = useTileLayer({
    width: 600,
    height: 300, // 180k tiles, Uint16Array; 0 = empty, id n = atlas tile n - 1
    tileset: { src: '/tiles.png', tileWidth: 16, tileHeight: 16, columns: 32, spacing: 0, margin: 0 },
    animations: { 12: { frames: [12, 13, 14, 13], duration: 0.2 } }, // water shimmer
  })
  useEffect(() => {
    sim.onTileChanged = (x, y, id) => ground.setTile(x, y, id) // no React re-render
    sim.onSeason = (tiles) => ground.setTiles(tiles)
  }, [ground])
  return <TileLayer layer={ground} zIndex={0} />
}
// <Camera2D pixelSnap /> keeps pixel art crisp while panning at any zoom / devicePixelRatio.
```

Cost model:

| Operation | Cost |
|---|---|
| Draw (WebGL2) | One quad per visible 4096x4096-tile page (one draw for a 600x300 map); per-pixel cost only for on-screen pixels. Off-screen tiles cost nothing. |
| `setTile(x, y, id)` | O(1). Next frame uploads the dirty rect of each touched 32x32 chunk (`texSubImage2D`, one texel for a single edit). |
| `markDirtyRect(x, y, w, h)` | After writing `layer.tiles` in place: clipped to the layer, queues each overlapped chunk with its part of the rect, like `setTile` for an area. |
| `touch()` | After writing `layer.tiles` in place when the area is unknown: marks everything dirty (same cost as `setTiles`, without the copy). |
| `setTiles(array)` / `fill(id)` | O(tiles) copy + one full index upload (360 KB for 600x300 Uint16). |
| Animated tiles | O(animations) per frame on the CPU and a tiny lookup-table upload when a frame flips; zero per-tile work. |
| Idle frame | No uploads, no allocation. |
| `setTint(x, y, 0xRRGGBBAA)` | O(1), shares the tile dirty rects. `setTints(bytes)` re-uploads the tint layer once. |

Variation and colour, all evaluated per pixel in the shader:

```ts
useTileLayer({
  ...,
  variants: { 5: [5, 21, 22, 23] }, // grass: per-cell pick by tileHash(x, y)
  jitter: 0.12,                      // hashed per-tile brightness variation
  tinted: true,                      // RGBA per tile, multiplied with the tile colour
})
water.setTints(colourFromDepthAndBiome) // width * height * 4 bytes
heat.setBias(x, y, 0x300800)             // ADDED to the tile colour (brighten); tint can only darken
heat.setBiases(bytes)                    // width * height * 4 bytes (rgb used); `biased: true` allocates up front
ground.visualTile(x, y)                 // the id actually drawn (variant + animation)
```

Variants share the tile id space with the atlas (`0` is empty, id `n` is atlas tile `n - 1`). A cell
holding `id` draws `variants[id][tileHash(x, y) % min(255, list.length)]`, then its animation frame.
The pick depends only on the cell coordinates, so it is stable across edits, and lists are capped at
255 entries. `tileHash` is exported, and `layer.variantAt(x, y)` returns the id picked at a cell
(before animation) so CPU models need not replicate the hash.

Writing `layer.tiles` directly is allowed; tell the layer afterwards:

```ts
ground.tiles[y * ground.width + x] = id
ground.markDirtyRect(x, y, 1, 1)  // or markDirtyRect(x0, y0, w, h) for a block
ground.touch()                     // unknown extent: re-upload everything
```

`visible`, `x`, `y`, `zIndex`, `opacity`, `tileset`, `tileWorldWidth` and `tileWorldHeight` are
setters that wake an on-demand loop (they call `layer.onChange`). `<TileLayer>` wires `onChange` to
`engine.loop.markDirty()`; for a layer added to the world imperatively use
`createTileLayerComponent(layer, () => engine.loop.markDirty())`.

Below about 2 device pixels per tile (e.g. zoom 0.05 with 16 px tiles) each tile is drawn with its
atlas tile's average colour, so far zoom doesn't shimmer. The threshold is `farZoomPx` (default 2, `0`
turns the average off).

Between 1:1 and that point, point-sampling shimmers when panning. `minFilter: 'mipmap'` filters the
minified atlas instead: a per-tile mip pyramid (built once per atlas image on the first zoomed-out draw,
about +33% atlas memory) blended trilinearly in the shader. Tiles never bleed into each other, and
magnified or 1:1 drawing stays exact texels:

```ts
useTileLayer({ ..., minFilter: 'mipmap', farZoomPx: 1 }) // 'nearest' (default) keeps exact point sampling
```

By default tile layers draw after parallax backgrounds and before all sprites, ordered by `zIndex`
among themselves. Give a layer a `renderLayer` to opt in to the shared draw order instead: it is then
sorted with sprites and `SpriteLayer`s by (render layer order, `zIndex`), so decor or heat overlays can
sit above a world sprite or between two sprite layers:

```tsx
<TileLayer layer={ground} />                                    // beneath everything (unchanged)
<TileLayer layer={heat} renderLayer="default" zIndex={5} />      // above sprites with zIndex < 5
```

`renderLayer` names are the ones `<Sprite layer>` and `useSpriteLayer({ layer })` use; at equal order
and `zIndex` a tile layer draws before sprites. Sampling uses `texelFetch` on exact atlas texels, so there is no bleeding or seams at
fractional zoom. GPU textures are freed the frame after the layer unmounts and rebuilt after a GL
context restore. Without WebGL, `<Game>` falls back to the Canvas2D renderer (see
[Rendering backends](#rendering-backends)). `TileLayerCanvasRenderer` is the plain-tiles building
block of that path and also works on its own: it draws a layer onto any 2D context with cached chunk
canvases.

## Thousands of sprites: `useSpriteLayer`

For crowds driven by simulation data (people, animals, buildings) use a sprite layer instead of one
`<Entity>` per object: typed arrays, no React node or entity per sprite.

```tsx
const crowd = useSpriteLayer({
  atlases: [
    { src: '/people.png', frameWidth: 16, frameHeight: 16 },
    { src: '/buildings.png', frameWidth: 32, frameHeight: 32 },
  ],
  sortByKey: true, // draw by sortKey (e.g. y) so people and buildings interleave by depth
  zIndex: 5,
})

// per simulation tick
crowd.resize(sim.count)
for (let i = 0; i < sim.count; i++) {
  crowd.x[i] = sim.x[i]
  crowd.y[i] = sim.y[i] + Math.sin(t + i) * 2 // e.g. fish bobbing
  crowd.w[i] = crowd.h[i] = 16 * sim.scale[i]
  crowd.atlas[i] = sim.isBuilding[i] ? 1 : 0
  crowd.frame[i] = sim.frame[i]
  crowd.color[i] = 0xffffff00 | Math.round(255 * sim.alpha[i]) // tint + alpha (fade on death)
  crowd.sortKey[i] = sim.y[i]
  crowd.ids[i] = sim.organismId[i]
}
crowd.touch()

const id = crowd.pick(worldX, worldY) // your id of the topmost sprite, -1 if none
```

Up to 256 atlases per layer. Atlases bind in groups of 8 (`atlas >> 3`); consecutive sprites (in draw
order) whose atlases share a group draw in one instanced call, a change of group starts a new call,
so keep frequently interleaved sprite types in the same group of 8.

Frames: a uniform grid (`frameWidth`, `frameHeight`, optional `frameSpacing`, `frameMargin`,
`frameColumns`) or an explicit frame table for irregular atlases, with an optional `inset` (texture
pixels shaved off every side of each frame's UVs so linear filtering and mipmaps cannot bleed
neighbours in):

```ts
useSpriteLayer({
  atlases: [
    { src: '/buildings.png', frames: [{ x: 0, y: 0, w: 96, h: 80 }, { x: 96, y: 0, w: 64, h: 64 }], inset: 0.5 },
    { src: '/people.png', frameWidth: 16, frameHeight: 16, sampling: 'nearest' }, // per-atlas sampling
    { src: '/decals.png', frameWidth: 64, frameHeight: 64, sampling: 'linear' },
  ],
})
layer.frame[i] = 1 // index into that atlas's frame table (sprites with an unknown frame are not drawn)
```

Each atlas can set its own `sampling` (overrides the layer's `sampling`), so pixel art and soft decals
share one layer.

Depth sort (`sortByKey`): `sortKey` is a Float64Array (depths 0.0001 apart at y = 4000 stay
distinct); sprites with equal keys break ties on an optional second key (`layer.enableSortKey2()`,
then `sortKey2[i]`), then on slot order. Hidden sprites (`SPRITE_HIDDEN`) take no part in the sort.
The order is updated incrementally from the previous frame whatever changed in between (keys
drifting, `clear()` + `add()` rebuilds in a similar order, swap-removes, show/hide): near-linear when
mostly kept, with an automatic fallback to a full sort when it is not. About 0.13 ms CPU per frame for
3,000 moving, re-sorted sprites.

Picking (`pick` walks the draw order from the top, rotation is ignored, flips are honoured):

```ts
// hit region: a building's footprint instead of its whole padded cell
useSpriteLayer({ atlases: [{ src: '/b.png', frames: [{ x: 0, y: 0, w: 96, h: 96, hit: { x: 0, y: 60, w: 96, h: 36 } }] }] })
// or 'opaque' (bounds of the non-transparent pixels) on a frame or on a whole grid atlas: { hit: 'opaque' }
layer.setHitRect(i, 0, 0.5, 1, 1)         // per-sprite override, fractions of the quad

layer.pickId(x, y)                         // id | undefined (-1 is also a valid Int32 id; pick() keeps returning -1)
layer.pickIndex(x, y)                      // slot | -1
layer.pickIndex(x, y, { alpha: 20 })       // also require a texel with alpha > 20 (pickAlpha sets a default)
layer.pickAll(x, y)                        // ids, topmost first
layer.pickNearest(x, y, radius)            // id of the nearest hit rect within radius (inside wins), or undefined
layer.add(x, y, w, h, frame, 'person:42')  // string ids are interned to int32; layer.pickKey(x, y) maps back
```

Brighten and glow: `color` only multiplies, so it can only darken. `layer.enableColorAdd()[i] = 0xRRGGBB`
(then `touch()`) ADDS a colour after the tint, scaled by the sprite's alpha (hit flash, heat). `flags[i] |= SPRITE_ADDITIVE`
draws one sprite additively inside a normally blended layer (fire, lamps); it keeps its place in the
depth order and costs one extra draw call per run of additive sprites, so group them by `sortKey` when
you can. (A whole layer blends with `blend: 'additive'`.)

Retained instances: the renderer keeps each sprite's packed instance between frames and uploads only
what changed (a static layer costs almost nothing per frame; 5% of 3,000 sprites moving is about 7x
cheaper than repacking all). Write the typed arrays, then tell the layer what you wrote:
`layer.touchRange(i0, i1)` re-checks and uploads just those slots (`set`, `add`, `removeAt` and `setAnchor`
do it for you); `layer.touch()` means "anything may have changed": every sprite is compared with its
packed copy and only differing ones are rewritten. Arrays written without either call are not picked up
until the next touch. When nearly every sprite changes every frame the layer drops back to a plain
repack automatically. In-place edits to a frame table need `layer.markAtlasDirty(i)`.

Pivots (what sits at the sprite's x, y and what it rotates around), most specific first:
`layer.setAnchor(i, ax, ay)` / `layer.enableAnchors()` (per sprite, fractions of the quad), a frame's
`pivot: { x, y }` in frame pixels (frame tables), an atlas-wide `pivot` for a grid, then the layer's
`anchorX`/`anchorY`. Draw and pick use the same resolution.

Alpha and opaque-bounds picking read the atlas pixels once (cached); call `layer.invalidateHitMasks()`
after repainting a dynamic-canvas atlas.

## Dynamic canvases at runtime (texture atlases that grow)

`useDynamicCanvas(w, h)` fixes the count and size at mount. To create, resize and free canvases by id
at runtime, use `engine.createDynamicCanvas` (also on `RenderSystem`):

```tsx
const engine = useGame()
const atlas = engine.createDynamicCanvas!({ id: 'bld-atlas', width: 1024, height: 1024 })
atlas.ctx.drawImage(sprite, 0, 0)
atlas.markDirty(0, 0, 64, 64)       // upload only that rect
atlas.resize(1024, 2048)             // grow; pixels are kept top-left, the GPU texture is re-created
const layer = useSpriteLayer({ dynamicSrc: atlas.id, frameWidth: 64, frameHeight: 64 })
atlas.dispose()                      // free the texture and the id
```

The handle is the hook's handle (`id`, `canvas`, `ctx`, `markDirty`) plus `width`, `height`, `resize`,
`dispose`. Every call wakes an on-demand loop. `createDynamicCanvas` throws on a duplicate `id`.

## Thousands of labels: `useTextLayer`

One `<Text>` entity costs one texture and one draw call. For name tags, damage numbers and map labels
use a text layer: every label is a row in typed arrays and all glyphs come from one shared atlas
(rasterised on demand), so 1,000 labels are **one instanced draw** (about 0.2 ms CPU headless, against
roughly 27 ms GPU / 50 ms CPU for 1,000 `<Text>` entities).

```tsx
const names = useTextLayer({
  fontFamily: 'Helvetica, sans-serif',
  fontSize: 12, // nominal size, also the default run size
  outlineColor: '#000',
  outlineWidth: 3, // baked into the glyphs (as are shadowColor / shadowBlur / weight / italic)
  zIndex: 20, // sorts with sprites and sprite layers by layer + zIndex
})
const title = names.addStyle({ fontSize: 28, weight: 'bold', outlineWidth: 0 }) // more styles, same atlas

// per tick
names.clear()
for (const p of people) names.add(p.name, p.x, p.y - 12, { color: 0xffd84aff, alpha: p.alpha })
names.add('Village of Oak', 400, 50, { style: title })
names.add('Long text wraps at maxWidth\nand honours newlines', 150, 180, {
  wordWrap: true,
  maxWidth: 140,
  align: 'center', // 'left' | 'center' | 'right'
  anchorX: 0.5, // 0..1 anchor of the text block
  anchorY: 0,
  rotation: -0.5,
})
names.setText(i, 'Renamed') // re-lays out only that run
const hit = names.pick(worldX, worldY) // id of the topmost label under the point, -1 if none
```

Per run you can set `size`, `color` (0xRRGGBBAA or a CSS colour; multiplies the baked colour), `alpha`,
`anchorX/anchorY`, `align`, `maxWidth`/`wordWrap`, `lineHeight`, `rotation` and `style`. The arrays
(`x`, `y`, `size`, `color`, `alpha`, `flags`...) can be written directly, then call `touch()`.

Zoom: by default a text layer re-rasterises its glyphs at 2x or 4x the atlas `resolution` when the camera zoom x device pixel ratio exceeds it (hysteresis on the way down, earlier sizes stay cached, no work while the zoom is stable), so labels stay crisp when zoomed in. `zoomAware: false` keeps one fixed density. Measured edge width at 4x zoom: 1.2 px aware vs 2.4 px fixed.

Limits: glyphs are laid out one code point at a time (no kerning, no shaping), so right-to-left and
complex scripts (Arabic, Devanagari) belong in `<Text>`. Pass the same `atlas: new GlyphAtlas(...)` to
several layers to share glyphs, or tune `pageSize` / `maxPages` / `resolution` (raster pixels per
nominal font pixel, default 2). When all pages fill, the atlas clears itself and re-rasterises what is
visible.

### `<Text>` on WebGL

`<Text>` now batches through the same glyph atlas: 1,000 labels are one draw call (0.3 ms CPU headless)
instead of one texture and draw each. On the WebGL path it honours `align`, `baseline`, `wordWrap` /
`maxWidth` / `lineHeight` (newlines too), `strokeColor` / `strokeWidth`, `shadowColor` / `shadowOffsetX` /
`shadowOffsetY` / `shadowBlur` and `opacity`, and takes `fontWeight` and `fontStyle="italic"`. Set
`layer="name"` to sort a text with sprites by `layer` + `zIndex` (unset keeps the old behaviour: above all
sprites, ordered by `zIndex`). Right-to-left / complex scripts and a `maxWidth` squeeze without `wordWrap`
use a per-entity canvas texture instead (cache keyed on every style input, 4,096 entries, re-rasterised
at 1x/2x/4x as you zoom).

## Rendering backends

`<Game renderer>` picks how the world is drawn:

```tsx
<Game />                      // 'auto' (default): WebGL2, else Canvas2D with one console warning
<Game renderer="webgl" />     // WebGL2 only: shows an error panel if it is unavailable
<Game renderer="canvas2d" />  // Canvas2D only: no WebGL context is ever created
```

Apps need no separate fallback: with the default `'auto'`, a browser, VM or headless environment
without WebGL2 renders through the Canvas2D system. When WebGL2 works nothing changes. The Canvas2D
renderer is loaded with a dynamic `import()`, so it adds nothing to the initial bundle (the
`xipjs/render` budget still holds). The prop is read once at mount. `useGame().renderBackend` is
`'webgl'` or `'canvas2d'`, and `Canvas2DRenderSystem` is exported from `xipjs/advanced`.

Same scene, same hooks (`useSpriteLayer`, `useScreenTint`, `useDynamicCanvas`, `<TileLayer>`):

| Feature | Canvas2D |
| --- | --- |
| Sprites: colour, image, frames, flip, rotation, anchor, offset, opacity, blend modes, sampling, tint, `tileX`/`tileY`, shapes | yes. `tint` multiplies the texture, as on WebGL. A shape's stroke uses `strokeColor` (WebGL draws it in the fill colour) |
| Render layers, `zIndex` order, frustum culling | yes (ties draw in entity order, not grouped by texture) |
| `SpriteLayer`: atlases, frames, rotation, flip/hidden/untextured flags, `sortByKey`, per-sprite RGBA colour | yes. Coloured textured sprites draw through a cached tinted copy (up to ~16 MB, then least recently used goes) |
| `TileLayer`: chunks, animation, opacity, variants, per-tile tints, jitter, `renderLayer` sorting with sprites | yes. Jitter brightening is approximate for semi-transparent tile edges; no far-zoom average colour (it smooths below ~0.5 px per texel instead) |
| `TextLayer` / `useTextLayer`: glyph atlas, align, wrap, anchor, rotation, colour, alpha, z-order with sprites | yes, glyph cells drawn from the shared atlas pages (coloured runs go through the tinted-copy cache) |
| Camera2D: follow (entity, point, SpriteLayer sprite), dead zone, smoothing, bounds, shake, zoom, `pixelSnap`, HiDPI | yes |
| `useScreenTint`: multiply / normal / additive | yes |
| Parallax layers | yes, honouring `repeatX`/`repeatY` |
| `<Text>`: align, baseline, word wrap, line height, stroke, shadow, opacity, weight, italic, `layer` sorting with sprites | yes, all honoured |
| Particles, trails, squash/stretch, animator and clip playback | yes |
| `useDynamicCanvas`, `engine.createDynamicCanvas` (create, resize, dispose by id) | yes, drawn live (`markDirty` is a no-op) |
| Sprite `customDraw` | yes |
| `usePostProcess` effect stack (2D effects run on the finished frame) | yes |
| `useWebGLPostProcess` (bloom, vignette, CA, scanlines), idle frame skip | **no**, WebGL only (enabling an effect logs one warning) |
| Context loss handling | n/a |

Canvas2D is a fallback, not a performance peer. A moving, y-sorted `SpriteLayer` measured in headless
Chrome (software canvas, 1280x720): about 8 ms per frame for 3,000 sprites, 11 ms with a different
colour per sprite, 23 ms for 10,000. The backends differ by sub-pixel rounding at fractional
positions. `<Text>` always uses the browser's own text engine here, so right-to-left and complex
scripts work without the per-entity fallback WebGL needs.

## Tint and blend: stacked, z-limited and per layer

```tsx
// Dim only what is drawn up to zIndex 50 (ground, buildings, people); labels/UI above stay bright.
const night = useScreenTint({ name: 'night', zIndex: 50 })
night.set(0.25, 0.3, 0.6, strength) // strength 0..1, modes: 'multiply' | 'normal' | 'additive' | 'screen'
const fog = useScreenTint({ name: 'fog' }) // a second, independent tint (whole world, after all sprites)
fog.set(0.8, 0.85, 0.9, 0.2, 'normal')

// Per layer: multiply colour (0xRRGGBBAA), opacity and blend on SpriteLayer, TileLayer and TextLayer.
const glow = useSpriteLayer({ src: '/glow.png', blend: 'additive', opacity: 0.8, zIndex: 40 })
glow.tintColor = 0xffd080ff
<TileLayer layer={heat} renderLayer="default" zIndex={3} blend="multiply" tintColor={0xff8080ff} opacity={0.6} />
```

A tint with `zIndex` (and optionally `layer`) joins the sprite sort and only covers items sorted before
it; at equal layer and zIndex it draws after them. Without them it behaves as before (after all sprites,
before text). `useScreenTint()` with no options is the unchanged single slot. Blend modes: `normal`,
`multiply` (darkens), `additive` (glow), `screen` (soft lighten); the engine restores `normal` after each
layer, so the cost is one `blendFunc` pair per non-normal layer.

## GPU wind: trees sway without CPU writes

```tsx
const trees = useSpriteLayer({
  src: '/trees.png', frameWidth: 32, frameHeight: 48,
  wind: { amplitude: 0.05, speed: 0.4, frequency: 0.01 }, // fraction of sprite height, Hz, radians per world px
})
trees.flags[i] |= SPRITE_SWAY        // opt a sprite in
trees.ensureSwayScale()[i] = 0.3     // optional per-sprite multiplier (stiff oak 0.3, tall grass 1.5)
trees.wind = null                    // calm
// Pixel art: whole-pixel steps, trunk fixed, only the canopy shifts (no separate canopy layer needed)
trees.wind = { amplitude: 0.06, speed: 0.4, snap: 1, fromY: 0.55 }
```

The vertex shader moves the top of each flagged quad sideways from a time uniform (the base stays put),
so a forest costs no per-frame CPU rewrite. The sway is time driven: a layer with a `wind` makes the idle
frame skip render every frame, and `useSpriteLayer` keeps an `onDemand` loop ticking while a wind is set.

## Overlays and camera

- `useScreenTint().set(r, g, b, strength, mode)`: full-view tint drawn after sprites and layers and
  before text. Use `'multiply'` for day/night, `'normal'` for fog or weather, `'additive'` for a flash.
- Emotes and bubbles: a second sprite layer with a higher `zIndex`, positioned above each person.
  Text labels are `<Text>` entities (one cached texture per unique string).
- Hazard overlays: a second `TileLayer` with semi-transparent tiles or a tint layer.
- `useCameraPanZoom({ minZoom, maxZoom, wheelSpeed, inertia, friction, onTap })`: drag to pan with
  mouse or touch, inertia, wheel and pinch zoom around the cursor, and `onTap` (with world
  coordinates) for click-to-select. Combine with `<Camera2D pixelSnap />`.
- `<Camera2D followPoint={() => ({ x, y })} />` follows any point (return null to hold) and
  `<Camera2D followSprite={{ layer, index }} />` (or `{ layer, id }`) follows a sprite layer sprite;
  a hidden or removed sprite holds the camera. Both share the smoothing, dead zone, offset and
  bounds of `followEntity`. Priority: `followPoint` > `followSprite` > `followEntity`.
- `useCamera().zoomAt(screenX, screenY, zoom)` and `useCoordinates()` work in canvas CSS pixels at
  any devicePixelRatio.

## Saving a picture of the world: `captureFrame`

A WebGL canvas that is not preserving its drawing buffer reads back black unless the
copy happens in the same task as the render. `engine.captureFrame()` renders the world
now and copies it right away, so the image is the frame on screen:

```tsx
const capture = useCaptureFrame() // or: const engine = useGame(); engine.captureFrame!()

const blob = await capture() // PNG Blob at the canvas' pixel size
const thumb = await capture({ width: 256 }) // downscaled, aspect ratio kept
const card = await capture({ width: 1200, height: 630, mimeType: 'image/jpeg', quality: 0.9 })
const sharp = await capture({ width: 2048, renderAtSize: true }) // re-rendered, not stretched
const bitmap = await capture({ type: 'bitmap' }) // ImageBitmap, e.g. for drawImage
const copy = await capture({ type: 'canvas' }) // a detached HTMLCanvasElement
```

| Option         | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `type`         | `'blob'` (default), `'bitmap'` or `'canvas'`; the result type follows it                   |
| `mimeType`     | `'image/png'` (default), `'image/jpeg'` or `'image/webp'`, for `type: 'blob'`             |
| `quality`      | 0-1 for jpeg and webp (default 0.92)                                                      |
| `width/height` | Output size in pixels. One keeps the aspect ratio, both stretch                           |
| `renderAtSize` | With a size, render again at that resolution so upscales stay sharp (needs a laid-out canvas) |
| `smoothing`    | Smooth the scaling (default: smooth when shrinking, nearest when growing)                 |
| `render`       | Render a fresh frame first (default `true`)                                               |

It captures the game canvas only, not the debug overlay or HTML on top, and rejects if the
WebGL context is lost. `captureFrame` is loaded on first use and does not count toward the
initial bundle. `exportToBlob(engine.canvas)` still works for a canvas you just rendered.

## Stats and profiling

`<StatsOverlay />` (inside `<Game>`) shows frame timings, draw calls, textures, tile layer uploads,
GPU time and a row per drawn layer. The same numbers are available in code:

```ts
const engine = useGame()
const s = engine.getStats() // live object, mutated in place; copyEngineStats(s) to keep a sample

s.gpuMs, s.gpuMsAvg       // GPU frame time in ms (EXT_disjoint_timer_query_webgl2), null if unsupported/off
s.render.gpuTimerSupported // null = not requested, false = unsupported, true = measuring
s.render.softwareRenderer // true = CPU WebGL (SwiftShader, llvmpipe, WARP), false = hardware, null = unknown or Canvas2D
s.layers                  // [{ kind: 'tile' | 'sprite', name, zIndex, instances, drawCalls, uploadBytes }]
s.tileLayerStats          // indexUploads, uploadedTexels, lutUploads, drawCalls, textureCount, textureBytes, ...
s.render.textureCount     // live textures, TileLayer atlas / index / tint / LUT textures included
s.render.textureUploads   // per frame, TileLayer uploads included (also textureUploadBytes)
```

- GPU timing is off by default and costs nothing while off. It turns on while `<StatsOverlay>` or
  `useEngineStats()` is mounted, with `<Game gpuTiming />`, or through
  `engine.requestGpuTiming()` (returns a release function; reference counted). Results are read a
  few frames late through a ring of timer queries, never block, and are dropped after a GPU disjoint
  event or context loss. The timer code is a lazy chunk loaded only when requested.
- `layers` lists tile layers first, then sprite layers in draw order. For sprite layers `instances`
  is the quad count and `uploadBytes` the instance data sent; for tile layers `instances` is the
  number of visible tile cells shaded and `uploadBytes` the index, tint, LUT and atlas texture
  uploads. Label layers with the `name` option of `useTileLayer` / `useSpriteLayer` (default: the
  sprite layer's render layer, or `tiles0`, `tiles1`, ... in draw order).
- `engine.stats` and `engine.getStats()` are always present.

## Testing your game headlessly: `xipjs/test`

`xipjs/test` mounts a real `<Game>` without a GPU. WebGL2 is a recording stand-in, so tests
can count draw calls and read back what was drawn. Frames run only when you call `frame()`, on a
virtual clock, so a test is deterministic. It needs a DOM (vitest `environment: 'happy-dom'` or
`'jsdom'`) and React 18.3+. Import it from test files only; it is a separate entry and never part
of the `xipjs` bundle.

```tsx
// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { World, Entity, Transform, Sprite, Camera2D } from 'xipjs'
import { mountGame, cleanup } from 'xipjs/test'

afterEach(cleanup) // unmounts every game and removes the global patches

it('draws every person in one call', async () => {
  const game = await mountGame(
    <World>
      <Camera2D x={0} y={0} />
      <Entity id="a">
        <Transform x={10} y={20} />
        <Sprite width={8} height={8} color="#ff0000" />
      </Entity>
    </World>,
    { width: 320, height: 200 },
  )
  game.frame(3) // three frames of 1/60 s through the real loop (scripts, physics, render)
  expect(game.drawCalls).toBe(1)
  expect(game.frameInstances()[0]).toMatchObject({ x: 10, y: 20, r: 1 })
  expect(game.engine.ecs.entityCount).toBe(1)
})
```

`mountGame(children, { width, height, game })` returns:

| Member                 | What it is                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `engine`, `canvas`     | the `EngineState` `<Game>` created and its canvas                                  |
| `frame(count, dt)`     | run frames synchronously (default one frame of 1/60 s), inside `act()`             |
| `drawCalls`, `instances` | draw calls and instances drawn by the last frame                                 |
| `draws`, `frameInstances()` | the raw draws, and decoded position/size/color/uv of each instance            |
| `renderStats`          | the renderer's counters for the last frame (batches, culled sprites, ...)          |
| `liveTextures`         | WebGL textures created and not deleted                                             |
| `gl`                   | the `RecordingGL` itself (`totalDraws`, `textures`, `contextLost = true` to simulate loss) |
| `rerender(children)`, `unmount()` | change the scene, tear down                                             |

`game` takes extra `<Game>` props (`mode`, `deterministic`, `plugins`, ...); `asyncAssets` is on so
the loop starts at once. All games mounted at the same time share one virtual clock.

To test a hook or component without mounting a game, `createTestEngine()` returns a real,
unstarted `EngineState` (ECS world, events, assets, input, recording canvas; pass overrides for
any field) to provide through `EngineContext`:

```tsx
import { EngineContext } from 'xipjs' // also exported from xipjs/render and xipjs/test
const engine = createTestEngine()
render(
  <EngineContext.Provider value={engine}>
    <MyHudThing />
  </EngineContext.Provider>,
)
```

The entry also re-exports the lower-level `RecordingGL`, `createRecordingCanvas`,
`decodeInstances` and `installHeadlessCanvasDOM` for driving `RenderSystem` directly (as the
benchmarks do). `installHeadlessCanvasDOM({ force: true })` replaces a stub `getContext`, e.g. in
jsdom.

## Bundle size

The package ships one ESM file per module and declares `"sideEffects": false`,
so bundlers keep only what you import. Importing `Game`, `World`, `Entity`,
`Camera2D`, `Sprite` and a few hooks costs about 33 kB gzip. Physics is attached
automatically the first time a physics component (`RigidBody`, any collider,
`Joint`) is created, so it is only bundled when you use it. The debug overlay and
devtools load on demand when the `debug` or `devtools` prop is set.

`xipjs/render` is a smaller barrel with just the rendering, camera, layer and
core hooks; its `Game` does not support the `debug` or `devtools` props.

## Links

- [Documentation](https://xipjs.dev)
- [Examples](https://github.com/1homsi/xip-examples) — 10 runnable games
- [GitHub](https://github.com/1homsi/xip)

## License

MIT
