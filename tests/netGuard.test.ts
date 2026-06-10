import { test, expect } from "bun:test"
import { isTrustedAddr } from "../src/netGuard"

test("loopback is trusted", () => {
  expect(isTrustedAddr("127.0.0.1")).toBe(true)
  expect(isTrustedAddr("127.5.6.7")).toBe(true)
  expect(isTrustedAddr("::1")).toBe(true)
  expect(isTrustedAddr("::ffff:127.0.0.1")).toBe(true)
})

test("tailscale CGNAT range (100.64.0.0/10) is trusted", () => {
  expect(isTrustedAddr("100.108.201.76")).toBe(true) // infrapoc
  expect(isTrustedAddr("100.64.0.0")).toBe(true)
  expect(isTrustedAddr("100.127.255.255")).toBe(true)
})

test("tailscale ULA range is trusted", () => {
  expect(isTrustedAddr("fd7a:115c:a1e0:ab12:3456:7890:abcd:ef01")).toBe(true)
})

test("public and LAN addresses are rejected", () => {
  expect(isTrustedAddr("8.8.8.8")).toBe(false)
  expect(isTrustedAddr("192.168.1.50")).toBe(false)
  expect(isTrustedAddr("10.0.0.5")).toBe(false)
  expect(isTrustedAddr("172.16.0.1")).toBe(false)
  expect(isTrustedAddr("100.63.255.255")).toBe(false) // just below CGNAT
  expect(isTrustedAddr("100.128.0.1")).toBe(false) // just above CGNAT
  expect(isTrustedAddr("fd7a:dead:beef::1")).toBe(false) // other ULA
})

test("missing or malformed address is rejected", () => {
  expect(isTrustedAddr(undefined)).toBe(false)
  expect(isTrustedAddr(null)).toBe(false)
  expect(isTrustedAddr("")).toBe(false)
})
