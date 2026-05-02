import { useEffect, useState } from 'react';

interface TurnTimerProps {
  deadline: string | null;
  serverOffsetMs: number;
  onExpire?: () => void;
}

export function TurnTimer({ deadline, serverOffsetMs, onExpire }: TurnTimerProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [deadline]);

  if (!deadline) return null;
  const deadlineMs = new Date(deadline).getTime();
  const serverNow = now + serverOffsetMs;
  const remainingMs = deadlineMs - serverNow;
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

  if (remainingMs <= 0 && onExpire) {
    queueMicrotask(onExpire);
  }

  const danger = remaining <= 5;
  return (
    <span className={`tabular-nums ${danger ? 'text-red-400' : 'text-slate-200'}`}>
      {remaining}s
    </span>
  );
}
