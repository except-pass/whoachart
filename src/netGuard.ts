// Source-IP gate for the control plane.
//
// The daemon binds 0.0.0.0 so a tailnet box is reachable as
// http://<host>.ts.net:<port> without port-forwarding (see main.ts and
// WHOACHART_PUBLIC_URL). But this control plane executes shell scripts and
// spawns agent sessions, so it must NOT answer arbitrary LAN/internet hosts.
// We gate by peer address: only loopback and the Tailscale ranges are trusted.
//   - loopback:        127.0.0.0/8, ::1 (and IPv4-mapped ::ffff:127.x)
//   - Tailscale CGNAT: 100.64.0.0/10  (e.g. infrapoc = 100.108.201.76)
//   - Tailscale ULA:   fd7a:115c:a1e0::/48
// Set WHOACHART_TRUST_ALL=1 to restore the old open behavior on a network you
// already trust (e.g. behind a separate firewall).

function normalize(addr: string): string {
  // Strip the IPv4-mapped IPv6 prefix: ::ffff:127.0.0.1 -> 127.0.0.1
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  return (mapped ? mapped[1] : addr).toLowerCase()
}

export function isTrustedAddr(addr: string | undefined | null): boolean {
  if (!addr) return false
  const ip = normalize(addr)

  if (ip === "::1") return true // IPv6 loopback

  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o1 = Number(v4[1])
    const o2 = Number(v4[2])
    if (o1 === 127) return true // 127.0.0.0/8 loopback
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true // 100.64.0.0/10 Tailscale CGNAT
    return false
  }

  // Tailscale IPv6 ULA fd7a:115c:a1e0::/48
  if (ip.startsWith("fd7a:115c:a1e0:")) return true

  return false
}
