import { useEffect, useRef, useState } from 'react';
import { PHRASES, REACTIONS, type ChatKind } from './useChat';

interface Props {
  onSend: (kind: ChatKind, content: string) => void;
  disabled?: boolean;
}

export function ChatLauncher({ onSend, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'phrases' | 'reactions'>('phrases');
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const send = (kind: ChatKind, content: string) => {
    onSend(kind, content);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="absolute bottom-2 left-2 z-30">
      <button
        type="button"
        aria-label="Open chat"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="rounded-full w-10 h-10 sm:w-11 sm:h-11 bg-slate-700/90 hover:bg-slate-600 active:bg-slate-500 border border-slate-500 text-white shadow-lg flex items-center justify-center transition disabled:opacity-50"
      >
        <span className="font-bold text-lg leading-none -mt-1">…</span>
      </button>

      {open && (
        <div className="absolute bottom-12 left-0 w-64 rounded-xl bg-slate-800 border border-slate-600 shadow-2xl overflow-hidden">
          <div className="flex border-b border-slate-700 text-sm">
            <button
              onClick={() => setTab('phrases')}
              className={`flex-1 px-3 py-2 ${
                tab === 'phrases' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-700/50'
              }`}
            >
              Phrases
            </button>
            <button
              onClick={() => setTab('reactions')}
              className={`flex-1 px-3 py-2 ${
                tab === 'reactions' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-700/50'
              }`}
            >
              Reactions
            </button>
          </div>

          <div className="p-2">
            {tab === 'phrases' ? (
              <div className="grid grid-cols-2 gap-1">
                {PHRASES.map((p) => (
                  <button
                    key={p}
                    onClick={() => send('text', p)}
                    className="rounded bg-slate-700 hover:bg-slate-600 active:bg-slate-500 px-2 py-1.5 text-xs text-left"
                  >
                    {p}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-1">
                {REACTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => send('emoji', r)}
                    className="rounded bg-slate-700 hover:bg-slate-600 active:bg-slate-500 aspect-square text-xl flex items-center justify-center"
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
