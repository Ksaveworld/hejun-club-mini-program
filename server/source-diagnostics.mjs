import {createHmac, randomBytes} from 'node:crypto';
import {isIP} from 'node:net';

// Ephemeral salt: fingerprints are comparable only within this server process.
const secret = randomBytes(32);
const epoch = randomBytes(8).toString('hex');
const maxWindowMs = 24 * 60 * 60 * 1000;
const maxEvents = 120;

function normalizeIp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ip = value.trim();
  // Reject zone identifiers and any free-form text, even if a parser accepts it.
  if (ip.includes('%')) return null;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6) return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  return null;
}

function fingerprint(value) {
  const ip = normalizeIp(value);
  return ip ? createHmac('sha256', secret).update(ip).digest('hex').slice(0, 24) : null;
}

function forwardedFingerprints(value) {
  if (typeof value !== 'string' || value.length > 1024) return [];
  const addresses = value.split(',');
  if (addresses.length > 16) return [];
  const fingerprints = addresses.map(fingerprint);
  return fingerprints.every(Boolean) ? fingerprints : [];
}

/** Observe only public article-list requests. This never changes authentication
 * or rate-limit identity; all forwarded fields remain explicitly untrusted. */
export function createSourceDiagnostics({
  until = process.env.SOURCE_DIAGNOSTICS_UNTIL,
  now = () => Date.now(),
  sink = record => console.log(JSON.stringify(record)),
} = {}) {
  const started = now();
  const requested = typeof until === 'string' ? Date.parse(until) : NaN;
  const deadline = Number.isFinite(requested) && requested > started
    ? Math.min(requested, started + maxWindowMs) : 0;
  let emitted = 0;
  const attached = new WeakSet();

  function observe(req, res) {
    if (!deadline || now() >= deadline || emitted >= maxEvents) return;
    // Match the literal canonical route only; never parse or retain query data.
    if (req.method !== 'GET' || typeof req.url !== 'string' || req.url.split('?', 1)[0] !== '/api/articles') return;
    if (attached.has(res)) return;
    attached.add(res);
    const directFingerprint = fingerprint(req.socket?.remoteAddress);
    const untrustedForwardedFingerprints = forwardedFingerprints(req.headers?.['x-forwarded-for']);
    const untrustedRealIpFingerprint = fingerprint(req.headers?.['x-real-ip']);
    res.once('finish', () => {
      const time = now();
      if (time >= deadline || emitted >= maxEvents) return;
      emitted++;
      try {
        sink({
          timestamp: new Date(time).toISOString(),
          event: 'source.diagnostic',
          epoch,
          method: 'GET',
          route: '/api/articles',
          status: res.statusCode,
          directFingerprint,
          untrustedForwardedFingerprints,
          untrustedForwardedCount: untrustedForwardedFingerprints.length,
          untrustedRealIpFingerprint,
        });
      } catch {
        // Diagnostic failure must never affect the response or business flow.
      }
    });
  }
  observe.ready = Object.freeze({enabled: Boolean(deadline), until: deadline ? new Date(deadline).toISOString() : null, epoch, maxEvents});
  try {
    sink({event: 'source.diagnostic.ready', timestamp: new Date(started).toISOString(), ...observe.ready});
  } catch {
    // Readiness logging is best effort, like the request diagnostics.
  }
  return observe;
}
