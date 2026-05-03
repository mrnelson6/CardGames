import { useCallback, useState } from 'react';

const KEY = 'euchre-chat-mutes-v1';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function useMutes() {
  const [mutes, setMutes] = useState<Set<string>>(load);

  const toggle = useCallback((userId: string) => {
    setMutes((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      try { localStorage.setItem(KEY, JSON.stringify(Array.from(next))); } catch { /* ignore quota */ }
      return next;
    });
  }, []);

  return { mutes, toggle };
}
