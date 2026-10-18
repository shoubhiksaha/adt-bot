import { useId } from "react";

export function Toggle({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{title}</strong>
        <br />
        <span className="small muted">{hint}</span>
      </span>
    </label>
  );
}

export function ModelInput({
  value,
  onChange,
  suggestions,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder: string;
  id?: string;
}) {
  const listId = useId();
  return (
    <>
      <input id={id} className="input" list={listId} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {[...new Set(suggestions)].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

export function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="small muted">{hint}</p>}
      {children}
    </section>
  );
}
