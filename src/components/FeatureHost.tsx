import { Menu } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { openView, useFeatureRegistry } from "../features/registry";
import { detectEnv, type Platform } from "../lib/transport";

/** Full-screen host for a feature view (projects, computers, rooms…). */
export function FeatureHost({ viewId, onOpenSidebar }: { viewId: string; onOpenSidebar: () => void }) {
  const view = useFeatureRegistry((s) => s.views.find((v) => v.id === viewId));
  const [platform, setPlatform] = useState<Platform | null>(null);
  useEffect(() => {
    void detectEnv().then((env) => setPlatform(env.platform));
  }, []);
  useEffect(() => {
    if (!view) openView(null);
  }, [view]);
  if (!view) return null;
  const Icon = view.icon;
  const unavailable = platform && view.platforms && !view.platforms.includes(platform);
  return (
    <main className="main feature-host">
      <header className="topbar">
        <button type="button" className="icon-btn mobile-only" aria-label="Open sidebar" onClick={onOpenSidebar}>
          <Menu size={19} />
        </button>
        <div className="title">
          <Icon size={18} />
          <strong>{view.label}</strong>
        </div>
      </header>
      <div className="feature-body">
        {unavailable ? (
          <div className="empty">
            <h1>{view.label}</h1>
            <p className="muted">This feature needs the ADT Bot desktop app.</p>
          </div>
        ) : (
          <Suspense fallback={<div className="muted small" style={{ padding: 20 }}>Loading…</div>}>
            <view.Component />
          </Suspense>
        )}
      </div>
    </main>
  );
}
