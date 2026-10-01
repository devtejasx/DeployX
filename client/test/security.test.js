// Frontend security rules that must hold for the whole dashboard source and
// its production configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SECURITY_HEADERS } from '../vite.config.js';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir = path.join(CLIENT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.(js|jsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('dashboard source', () => {
  // Code only: comments may explain what the code avoids.
  const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = sources().map((file) => ({ file: path.relative(CLIENT, file), text: withoutComments(fs.readFileSync(file, 'utf8')) }));

  test('never renders raw HTML or evaluates strings', () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|document\.write|\beval\(|new Function\(/);
    }
  });

  test('never stores anything in browser storage or touches cookies', () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  test('reads no build-time variables (VITE_* values are public in the bundle)', () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/import\.meta\.env/);
    }
  });

  test('never puts a token or password in a URL', () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/[?&](token|password|session|access_token)=/i);
    }
  });
});

describe('production headers', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy'];

  test('the CSP allows only the dashboard\'s own origin, no inline code, no framing', () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });

  test('nginx sends the same policy as vite preview', () => {
    const nginx = fs.readFileSync(path.join(CLIENT, 'security-headers.conf'), 'utf8');
    expect(nginx).toContain(`add_header Content-Security-Policy "${csp}" always;`);
  });

  test('index.html has no inline script or style the CSP would have to allow', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) {
      expect(tag).toMatch(/<script\b[^>]*\bsrc=/);
      expect(tag).toMatch(/><\/script>$/);
    }
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
  });
});
