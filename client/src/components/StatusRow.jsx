const LABELS = {
  connected: { icon: '✓', text: 'Connected' },
  disconnected: { icon: '✗', text: 'Disconnected' },
  unknown: { icon: '?', text: 'Unknown' },
};

export default function StatusRow({ name, state, detail }) {
  const label = LABELS[state] ?? LABELS.unknown;

  return (
    <li className={`status-row status-row--${state}`}>
      <span className="status-row__name">{name}</span>
      <span className="status-row__value" title={detail || undefined}>
        <span aria-hidden="true">{label.icon}</span> {label.text}
      </span>
    </li>
  );
}
