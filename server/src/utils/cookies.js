// Reads one cookie from a Cookie header ("a=1; b=2"), or null. Values are
// returned as sent (DeployX's own cookies are base64url, never encoded).
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
