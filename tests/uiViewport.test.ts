import { test, expect } from "bun:test"
import { clamp, viewFor, clampCenter, anchoredZoom } from "../src/ui/public/viewport.js"

const base = { w: 1000, h: 500 }

test("clamp bounds a value", () => {
  expect(clamp(5, 0, 10)).toBe(5)
  expect(clamp(-1, 0, 10)).toBe(0)
  expect(clamp(99, 0, 10)).toBe(10)
})

test("viewFor: scale 1 is the whole chart; larger scale shrinks the window, keeping aspect", () => {
  expect(viewFor(1, 500, 250, base)).toEqual({ x: 0, y: 0, w: 1000, h: 500 })
  const v = viewFor(2, 500, 250, base)
  expect(v).toEqual({ x: 250, y: 125, w: 500, h: 250 })
  expect(v.w / v.h).toBeCloseTo(base.w / base.h) // aspect preserved at every zoom
})

test("clampCenter keeps the view center inside chart bounds", () => {
  expect(clampCenter(-50, 9999, base)).toEqual({ cx: 0, cy: 500 })
  expect(clampCenter(500, 250, base)).toEqual({ cx: 500, cy: 250 })
})

test("anchoredZoom keeps the cursor point fixed under the cursor", () => {
  // Start fully zoomed out; zoom in toward the point (800,400).
  const anchor = { x: 800, y: 400 }
  const r = anchoredZoom(1, 500, 250, base, 2, anchor, 1, 8)
  expect(r.scale).toBe(2)
  // The anchor's fractional position within the view must be unchanged (0.8, 0.8).
  const after = viewFor(r.scale, r.cx, r.cy, base)
  expect((anchor.x - after.x) / after.w).toBeCloseTo(0.8)
  expect((anchor.y - after.y) / after.h).toBeCloseTo(0.8)
})

test("anchoredZoom clamps scale and is a no-op at the floor", () => {
  // already at min scale, zooming out further does nothing
  const out = anchoredZoom(1, 500, 250, base, 0.5, { x: 500, y: 250 }, 1, 8)
  expect(out).toEqual({ scale: 1, cx: 500, cy: 250 })
  // cannot exceed max scale
  const inMax = anchoredZoom(8, 500, 250, base, 4, { x: 500, y: 250 }, 1, 8)
  expect(inMax.scale).toBe(8)
})
