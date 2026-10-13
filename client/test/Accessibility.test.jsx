// Accessibility rules that are easy to break without noticing: text contrast
// of the theme colours, and live regions that screen readers read aloud.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import LogViewer from '../src/components/LogViewer.jsx';

afterEach(cleanup);

const CSS = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.css'), 'utf8');

// WCAG 2 contrast ratio of two #rrggbb colours.
function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The custom properties of the first `:root {` block after `start`.
function themeAt(start) {
  const block = CSS.slice(CSS.indexOf(':root {', start), CSS.indexOf('}', CSS.indexOf(':root {', start)));
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
}

describe('contrast (WCAG AA, 4.5:1 for text)', () => {
  const light = themeAt(0);
  const dark = { ...light, ...themeAt(CSS.indexOf('prefers-color-scheme: dark')) };

  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    test(`muted and normal text on the page and on cards, ${name} theme`, () => {
      for (const fg of ['text', 'muted']) {
        for (const bg of ['bg', 'surface']) {
          expect(contrast(theme[fg], theme[bg]), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test(`log timestamps and lines on the log background, ${name} theme`, () => {
      const time = /\.log-line__time \{[^}]*color: (#[0-9a-f]{6})/.exec(CSS)[1];
      expect(contrast(time, theme['log-bg'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme['log-text'], theme['log-bg'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('log viewer', () => {
  const logs = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    level: 'INFO',
    message: `line ${i + 1}`,
    created_at: '2026-10-13T10:00:00Z',
  }));

  test('the log list is not a live region, but can be scrolled with the keyboard', () => {
    render(<LogViewer logs={logs} connection="live" status="BUILDING" ended={false} />);
    const list = screen.getByRole('list', { name: 'Deployment logs' });
    expect(list.getAttribute('aria-live')).toBeNull();
    expect(list.closest('[aria-live]')).toBeNull();
    expect(list.tabIndex).toBe(0);
    expect(screen.getByRole('status').textContent).toBe('Live');
  });

  test('the final outcome is announced once, as a status', () => {
    render(<LogViewer logs={logs} connection="closed" status="FAILED" rollbackStatus="COMPLETED" ended />);
    const statuses = screen.getAllByRole('status').map((element) => element.textContent);
    expect(statuses).toContain('Deployment failed its health check. The previous stable version was restored.');
  });
});

describe('keyboard and form help', () => {
  test('the skip link moves the focus to the applications without changing the route', async () => {
    const { default: App } = await import('../src/App.jsx');
    const { fakeApi, ok, overview, SYSTEM_STATUS } = await import('./fakeApi.js');
    fakeApi({
      'GET /api/auth/me': ok({ user: { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'USER' } }),
      'GET /api/system/status': SYSTEM_STATUS,
      'GET /api/monitoring/overview': ok(overview()),
      'GET /api/projects': ok([]),
    });
    window.location.hash = '#/projects/0f8fad5b-d9cb-469f-a165-70867728950e';
    render(<App />);
    const skip = await screen.findByRole('button', { name: 'Skip to applications' });
    skip.click();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Applications' }));
    expect(window.location.hash).toBe('#/projects/0f8fad5b-d9cb-469f-a165-70867728950e');
    window.location.hash = '';
  });

  test('form hints are read out with the fields they explain', async () => {
    const { default: NewProject } = await import('../src/components/NewProject.jsx');
    render(<NewProject onCreated={() => {}} onClose={() => {}} />);
    const describedBy = (label) => {
      const ids = screen.getByLabelText(label).getAttribute('aria-describedby');
      return document.getElementById(ids).textContent;
    };
    expect(describedBy('Dockerfile path')).toContain('Relative to the repository root');
    expect(describedBy('Container port')).toContain('The port the app listens on');
    expect(describedBy('Health-check path')).toContain('2xx status');
  });
});
