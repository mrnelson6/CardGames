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
    <div className="rounded bg-slate-800/90 px-2 py-1 sm:p-3 text-xs sm:text-sm sm:space-y-1">
      <div className="flex items-baseline justify-between gap-2 sm:gap-4">
        <span className="hidden sm:inline">{team0Label}</span>
        <span className="sm:hidden text-slate-400">Us</span>
        <span className="font-bold tabular-nums">
          {team0}
          {tricks && (
            <span className="ml-1 text-[10px] sm:text-xs text-slate-400 font-normal">{tricks.team0}t</span>
          )}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2 sm:gap-4">
        <span className="hidden sm:inline">{team1Label}</span>
        <span className="sm:hidden text-slate-400">Them</span>
        <span className="font-bold tabular-nums">
          {team1}
          {tricks && (
            <span className="ml-1 text-[10px] sm:text-xs text-slate-400 font-normal">{tricks.team1}t</span>
          )}
        </span>
      </div>
      {trumpSuit && (
        <div className="hidden sm:block text-xs text-slate-400 pt-1 border-t border-slate-700">
          Trump: {trumpSuit} {makerTeam !== undefined && `(maker: team ${makerTeam})`}
        </div>
      )}
    </div>
  );
}
