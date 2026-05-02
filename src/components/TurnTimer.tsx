import { useEffect, useRef, useState } from 'react';

interface TurnTimerProps {
  deadline: string | null;
  serverOffsetMs: number;
  onExpire?: (deadline: string) => void;
}

export function TurnTimer({ deadline, serverOffsetMs, onExpire }: TurnTimerProps) {
  const [now, setNow] = useState(Date.now());
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [deadline]);

  // Reset the fired marker when the deadline changes.
  useEffect(() => {
    firedFor.current = null;
  }, [deadline]);

  if (!deadline) return null;
  const deadlineMs = new Date(deadline).getTime();
  const serverNow = now + serverOffsetMs;
  const remainingMs = deadlineMs - serverNow;
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

  if (remainingMs <= 0 && onExpire && firedFor.current !== deadline) {
    firedFor.current = deadline;
    queueMicrotask(() => onExpire(deadline));
  }

  const danger = remaining <= 5;
  return (
    <span className={`tabular-nums ${danger ? 'text-red-400' : 'text-slate-200'}`}>
      {remaining}s
    </span>
  );
}
