import { lookup } from 'dns/promises';
import { isIP } from 'net';

function extractMappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  const dottedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    return dottedMatch[1];
  }

  const hexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexMatch) {
    return null;
  }

  const upper = Number.parseInt(hexMatch[1], 16);
  const lower = Number.parseInt(hexMatch[2], 16);
  if (
    Number.isNaN(upper) ||
    Number.isNaN(lower) ||
    upper < 0 ||
    upper > 0xffff ||
    lower < 0 ||
    lower > 0xffff
  ) {
    return null;
  }

  return [
    (upper >> 8) & 0xff,
    upper & 0xff,
    (lower >> 8) & 0xff,
    lower & 0xff,
  ].join('.');
}

function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = extractMappedIpv4(normalized);
    if (mappedIpv4) {
      return isBlockedIpAddress(mappedIpv4);
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }

  return true;
}

function normalizeHostname(url: URL): string {
  const rawHostname = url.hostname.toLowerCase();
  return rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
}

export async function resolveSafeHttpDestination(
  url: URL,
  allowPrivate: boolean,
): Promise<{
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
}> {
  const hostname = normalizeHostname(url);
  const literalIpVersion = isIP(hostname);
  if (literalIpVersion) {
    if (!allowPrivate && isBlockedIpAddress(hostname)) {
      throw new Error(`Blocked private HTTP destination: ${hostname}`);
    }
    return {
      hostname,
      addresses: [{ address: hostname, family: literalIpVersion }],
    };
  }

  if (
    !allowPrivate &&
    (hostname === 'localhost' ||
      hostname === 'host.docker.internal' ||
      hostname.endsWith('.local') ||
      !hostname.includes('.'))
  ) {
    throw new Error(`Blocked private HTTP destination: ${hostname}`);
  }

  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve HTTP destination: ${hostname}`);
  }
  if (!allowPrivate) {
    for (const entry of addresses) {
      if (isBlockedIpAddress(entry.address)) {
        throw new Error(`Blocked private HTTP destination: ${hostname}`);
      }
    }
  }

  return {
    hostname,
    addresses: addresses.map((entry) => ({
      address: entry.address,
      family: entry.family,
    })),
  };
}

export async function assertSafeHttpDestination(
  url: URL,
  allowPrivate: boolean,
): Promise<void> {
  await resolveSafeHttpDestination(url, allowPrivate);
}
