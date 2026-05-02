interface ScorePanelProps {
  team0: number;
  team1: number;
  trumpSuit?: string;
  makerTeam?: 0 | 1;
  myTeam?: 0 | 1;
  tricks?: { team0: number; team1: number };
}

export function ScorePanel({ team0, team1, trumpSuit, makerTeam, myTeam, tricks }: ScorePanelProps) {
  const team0Label = myTeam === 0 ? 'Your team' : myTeam === 1 ? 'Other team' : 'Team 0';
  const team1Label = myTeam === 1 ? 'Your team' : myTeam === 0 ? 'Other team' : 'Team 1';
  return (
    <div className="rounded bg-slate-800/90 p-3 text-sm space-y-1">
      <div className="flex justify-between gap-4">
        <span>{team0Label}</span>
        <span className="font-bold">
          {team0}
          {tricks && (
            <span className="ml-2 text-xs text-slate-400 font-normal">{tricks.team0}t</span>
          )}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span>{team1Label}</span>
        <span className="font-bold">
          {team1}
          {tricks && (
            <span className="ml-2 text-xs text-slate-400 font-normal">{tricks.team1}t</span>
          )}
        </span>
      </div>
      {trumpSuit && (
        <div className="text-xs text-slate-400 pt-1 border-t border-slate-700">
          Trump: {trumpSuit} {makerTeam !== undefined && `(maker: team ${makerTeam})`}
        </div>
      )}
    </div>
  );
}
