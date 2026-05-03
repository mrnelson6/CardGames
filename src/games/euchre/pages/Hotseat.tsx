import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { Card, Suit } from '../../../lib/database.types';
import { RANK_LABEL, SUIT_LABEL, isRed, rankOf, suitOf } from '../../../lib/cards-base';
import {
  applyCallTrump,
  applyDealerDiscard,
  applyOrderUp,
  applyPass,
  applyPlayCard,
  dealHand,
  startNextHand,
  teamOf,
  type EuchreState,
  type Seat,
} from '../game-machine';
import { effectiveSuit, legalPlays } from '../cards';
import { BidPanel } from '../components/BidPanel';
import { ScorePanel } from '../components/ScorePanel';

// Same seat positioning as the online Game page. Hot-seat uses a fixed
// viewer = seat 0 (no rotation), so seat 0 sits south, partner seat 2
// north, opponents 1 and 3 west and east.
const SEAT_POSITION: Record<Seat, string> = {
  0: 'col-start-2 row-start-3 place-self-center',
  1: 'col-start-1 row-start-2 self-start justify-self-start sm:place-self-center',
  2: 'col-start-2 row-start-1 place-self-center',
  3: 'col-start-3 row-start-2 self-end justify-self-end sm:place-self-center',
};

const SEAT_LABEL: Record<Seat, string> = {
  0: 'South',
  1: 'West',
  2: 'North',
  3: 'East',
};

export function EuchreHotseatPage() {
  const [state, setState] = useState<EuchreState>(() => dealHand(0));
  const [error, setError] = useState<string | null>(null);

  const act = (fn: () => EuchreState) => {
    try {
      setState(fn());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onPass = () => act(() => applyPass(state));
  const onOrderUp = (alone: boolean) => act(() => applyOrderUp(state, alone));
  const onCall = (suit: Suit, alone: boolean) => act(() => applyCallTrump(state, suit, alone));
  const onDiscard = (card: Card) => act(() => applyDealerDiscard(state, card));
  const onPlay = (card: Card) => act(() => applyPlayCard(state, card));
  const onNextHand = () => act(() => startNextHand(state));
  const onNewGame = () => {
    setState(dealHand(0));
    setError(null);
  };

  const currentSeat = state.current;
  const trump = state.trump;
  const phase = state.phase;
  const finished = phase === 'game_complete';

  const legalForCurrent: Card[] = useMemo(() => {
    if (phase !== 'play' || trump === null) return [];
    return legalPlays(state.hands[currentSeat], state.ledCard, trump);
  }, [state, phase, currentSeat, trump]);

  const dealerDiscardChoices: Card[] = useMemo(() => {
    if (phase !== 'discard' || state.upcard === null) return [];
    return [...state.hands[state.dealer], state.upcard];
  }, [state, phase]);

  const tricksTeam0 = state.tricksWon[0];
  const tricksTeam1 = state.tricksWon[1];

  if (finished) {
    const winner: 0 | 1 = state.scores[0] >= 10 ? 0 : 1;
    return (
      <div className="min-h-full p-6 max-w-2xl mx-auto text-center">
        <h1 className="text-3xl font-bold mb-2">Game over</h1>
        <p className="text-xl text-emerald-300 mb-4">
          Team {winner} wins {state.scores[0]}–{state.scores[1]}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onNewGame}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2"
          >
            Play again
          </button>
          <Link to="/" className="rounded border border-slate-600 hover:bg-slate-700 px-4 py-2">
            Back to lobby
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex flex-col p-2 sm:p-3 max-w-5xl mx-auto overflow-hidden">
      <header className="flex-shrink-0 flex items-center justify-between mb-2">
        <div>
          <h1 className="text-base sm:text-xl font-bold leading-tight">Euchre — Hot-seat</h1>
          <p className="text-xs text-slate-400">
            Hand {state.handNumber} · {phase}
            {trump && <> · Trump <span className="text-slate-200">{SUIT_LABEL[trump]}</span></>}
            {state.alone !== null && <> · Alone</>}
            {' · '}
            <span className="text-slate-200">{SEAT_LABEL[currentSeat]}</span> to act
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onNewGame}
            className="text-sm rounded border border-slate-600 hover:bg-slate-700 px-3 py-1"
          >
            New game
          </button>
          <Link to="/" className="text-sm hover:underline">← Lobby</Link>
        </div>
      </header>

      {error && (
        <div className="flex-shrink-0 mb-2 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 relative grid grid-cols-3 grid-rows-[auto_minmax(0,1fr)_auto] gap-1.5 sm:gap-3 bg-felt-dark p-2 sm:p-4 rounded-2xl">
        {([0, 1, 2, 3] as Seat[]).map((seat) => {
          const isCurrent = seat === currentSeat;
          const isDealer = seat === state.dealer;
          const isMaker = seat === state.maker;
          const isAlone = seat === state.alone;
          const cards = state.hands[seat];
          const isPlayable = phase === 'play' && isCurrent;
          const isDiscarding = phase === 'discard' && seat === state.dealer;
          const isBidding =
            (phase === 'bid_round_1' || phase === 'bid_round_2') && isCurrent;
          return (
            <div
              key={seat}
              className={`${SEAT_POSITION[seat]} rounded-xl border-2 p-1 sm:p-2 bg-slate-900/60 ${
                isCurrent ? 'border-emerald-400' : 'border-slate-700'
              }`}
            >
              <div className="text-xs flex justify-between mb-1">
                <span className="font-semibold">
                  {SEAT_LABEL[seat]}
                  {isDealer && <span className="text-amber-300 ml-1">D</span>}
                  {isMaker && <span className="text-emerald-300 ml-1">M</span>}
                  {isAlone && <span className="text-violet-300 ml-1">alone</span>}
                </span>
                <span className="text-slate-500">
                  team {teamOf(seat)} · {state.tricksWon[teamOf(seat)]}t
                </span>
              </div>

              {isBidding && state.upcard && phase === 'bid_round_1' && (
                <div className="mb-2">
                  <BidPanel
                    round={1}
                    upcardSuit={suitOf(state.upcard)}
                    isDealer={currentSeat === state.dealer}
                    onPass={onPass}
                    onOrderUp={onOrderUp}
                  />
                </div>
              )}
              {isBidding && state.upcard && phase === 'bid_round_2' && (
                <div className="mb-2">
                  <BidPanel
                    round={2}
                    excludedSuit={suitOf(state.upcard)}
                    isDealer={currentSeat === state.dealer}
                    onPass={onPass}
                    onCall={onCall}
                  />
                </div>
              )}
              {isDiscarding && (
                <div className="mb-2 text-xs text-slate-300">
                  Click a card to discard.
                </div>
              )}

              <div className="flex flex-wrap gap-1">
                {cards.length === 0 ? (
                  <span className="text-xs text-slate-500 italic">empty</span>
                ) : (
                  <AnimatePresence>
                    {cards.map((c) => {
                      const playable = isPlayable && legalForCurrent.includes(c);
                      const discardable = isDiscarding;
                      return (
                        <motion.div
                          key={c}
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.85, y: -28 }}
                          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
                        >
                          <CardButton
                            card={c}
                            legal={phase === 'play' ? !isPlayable || playable : true}
                            onClick={
                              playable
                                ? () => onPlay(c)
                                : discardable
                                  ? () => onDiscard(c)
                                  : undefined
                            }
                          />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                )}
              </div>

              {isDiscarding && state.upcard && (
                <div className="mt-2">
                  <span className="text-[10px] text-slate-400 uppercase block mb-1">
                    upcard
                  </span>
                  <CardButton card={state.upcard} legal onClick={() => onDiscard(state.upcard!)} />
                </div>
              )}

              <TrickStack count={state.tricksWon[teamOf(seat)] === 0 ? 0 : tricksWonBySeat(state, seat)} />
            </div>
          );
        })}

        <div className="col-start-2 row-start-2 relative flex flex-col items-center justify-center gap-2">
          {trump && (
            <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none select-none">
              <span
                className={`leading-none ${
                  trump === 'D' || trump === 'H' ? 'text-rose-500/35' : 'text-slate-100/30'
                }`}
                style={{ fontSize: 'min(28vh, 22vw)' }}
              >
                {SUIT_LABEL[trump]}
              </span>
            </div>
          )}
          <div className="relative z-10 flex flex-col items-center gap-2">
            <TrickArea
              trick={state.trick}
              upcard={
                state.upcardStatus !== 'taken' && phase !== 'discard'
                  ? state.upcard
                  : null
              }
              upcardStatus={state.upcardStatus}
            />
            {phase === 'hand_complete' && (
              <button
                onClick={onNextHand}
                className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-sm font-semibold"
              >
                Next hand
              </button>
            )}
          </div>
        </div>

        <div className="absolute top-2 right-2 z-20 pointer-events-none">
          <ScorePanel
            team0={state.scores[0]}
            team1={state.scores[1]}
            trumpSuit={trump ? SUIT_LABEL[trump] : undefined}
            makerTeam={state.maker !== null ? teamOf(state.maker) : undefined}
            tricks={trump !== null ? { team0: tricksTeam0, team1: tricksTeam1 } : undefined}
          />
        </div>
      </div>

      <p className="flex-shrink-0 mt-2 text-[10px] text-slate-500 text-center">
        All hands shown face-up. Pass the device or play solo as a rule sandbox.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function tricksWonBySeat(state: EuchreState, seat: Seat): number {
  // We only track per-team in the local engine. Approximate per-seat by
  // splitting the team's tricks evenly between its two seats — the visual
  // is just a tiny stack indicator anyway.
  const team = teamOf(seat);
  const teamTricks = state.tricksWon[team];
  if (teamTricks === 0) return 0;
  // Lump the visual onto seat 0/1 (south or west) so it doesn't double.
  return seat === 0 || seat === 1 ? teamTricks : 0;
}

function TrickArea({
  trick,
  upcard,
  upcardStatus,
}: {
  trick: Array<{ seat: Seat; card: Card }>;
  upcard: Card | null;
  upcardStatus: 'face_up' | 'turned_down' | 'taken';
}) {
  const showing = trick;
  const showUpcard = showing.length === 0 && upcard !== null;
  const CELL_CLASS: Record<Seat, string> = {
    0: 'col-start-2 row-start-3 place-self-center',
    1: 'col-start-1 row-start-2 place-self-center',
    2: 'col-start-2 row-start-1 place-self-center',
    3: 'col-start-3 row-start-2 place-self-center',
  };
  const ROTATION: Record<Seat, number> = { 0: 0, 1: 90, 2: 0, 3: -90 };
  const ENTRY_OFFSET: Record<Seat, { x: number; y: number }> = {
    0: { x: 0, y: 80 },
    1: { x: -80, y: 0 },
    2: { x: 0, y: -80 },
    3: { x: 80, y: 0 },
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative grid grid-cols-3 grid-rows-3 w-40 h-40 sm:w-48 sm:h-48">
        {showUpcard && (
          <div className="col-start-2 row-start-2 place-self-center">
            <div className={upcardStatus === 'turned_down' ? 'opacity-50 grayscale' : ''}>
              <CardButton card={upcard!} legal={upcardStatus === 'face_up'} />
            </div>
          </div>
        )}
        <AnimatePresence>
          {showing.map((p) => {
            const rotation = ROTATION[p.seat];
            return (
              <motion.div
                key={p.seat}
                className={CELL_CLASS[p.seat]}
                initial={{ ...ENTRY_OFFSET[p.seat], opacity: 0, rotate: rotation }}
                animate={{ x: 0, y: 0, opacity: 1, rotate: rotation }}
                exit={{ opacity: 0, scale: 0.9, rotate: rotation }}
                transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              >
                <CardButton card={p.card} legal />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

function CardButton({ card, legal, onClick }: { card: Card; legal: boolean; onClick?: () => void }) {
  const suit = suitOf(card);
  const rank = rankOf(card);
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`flex h-14 w-10 sm:h-16 sm:w-12 flex-col items-center justify-between rounded border-2 bg-white px-1 py-0.5 ${
        isRed(suit) ? 'text-red-600' : 'text-black'
      } ${
        onClick
          ? 'border-emerald-400 hover:-translate-y-1 transition cursor-pointer'
          : legal
            ? 'border-slate-300'
            : 'border-slate-500 opacity-40'
      }`}
    >
      <span className="self-start text-[10px] sm:text-xs font-bold">{RANK_LABEL[rank]}</span>
      <span className="text-base sm:text-lg">{SUIT_LABEL[suit]}</span>
      <span className="self-end text-[10px] sm:text-xs font-bold rotate-180">{RANK_LABEL[rank]}</span>
    </button>
  );
}

function TrickStack({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="flex">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="h-3 w-5 rounded-sm border border-blue-950 bg-blue-700 -ml-2 first:ml-0"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, transparent 0 2px, rgba(255,255,255,0.15) 2px 4px)',
            }}
          />
        ))}
      </div>
      <span className="text-[10px] text-slate-400">{count} won</span>
    </div>
  );
}

void effectiveSuit;
