import { useParams, Link } from 'react-router-dom';

export function EuchreQueuePage() {
  const { mode } = useParams();
  return (
    <div className="min-h-full p-6 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Euchre — {mode} queue</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>
      <p className="text-slate-400">Matchmaking UI lands in Phase 4.</p>
    </div>
  );
}
