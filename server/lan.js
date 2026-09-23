import os from 'node:os';

// IPv4 addresses a phone on the same Wi-Fi can reach. Loopback and link-local
// (169.254.x.x, self-assigned when DHCP failed) are left out.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      if (iface.internal || iface.address.startsWith('169.254.')) continue;
      out.push(iface.address);
    }
  }
  return out;
}
