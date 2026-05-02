interface ScorePanelProps {
  team0: number;
  team1: number;
  trumpSuit?: string;
  makerTeam?: 0 | 1;
}

export function ScorePanel({ team0, team1, trumpSuit, makerTeam }: ScorePanelProps) {
  return (
    <div className="rounded bg-slate-800/90 p-3 text-sm space-y-1">
      <div className="flex justify-between gap-4">
        <span>Us (0/2)</span>
        <span className="font-bold">{team0}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span>Them (1/3)</span>
        <span className="font-bold">{team1}</span>
      </div>
      {trumpSuit && (
        <div className="text-xs text-slate-400 pt-1 border-t border-slate-700">
          Trump: {trumpSuit} {makerTeam !== undefined && `(maker: team ${makerTeam})`}
        </div>
      )}
    </div>
  );
}
