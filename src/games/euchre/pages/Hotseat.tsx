import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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

type SeatLabel = 'You (S)' | 'West' | 'North' | 'East';
const SEAT_LABEL: Record<Seat, SeatLabel> = {
  0: 'You (S)',
  1: 'West',
  2: 'North',
  3: 'East',
};

const SEAT_POSITION: Record<Seat, string> = {
  0: 'col-start-2 row-start-3',
  1: 'col-start-1 row-start-2',
  2: 'col-start-2 row-start-1',
  3: 'col-start-3 row-start-2',
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
  const currentHand = state.hands[currentSeat];
  const ledCard = state.ledCard;
  const trump = state.trump;

  const legalForCurrent: Card[] = useMemo(() => {
    if (state.phase !== 'play' || trump === null) return [];
    return legalPlays(currentHand, ledCard, trump);
  }, [state, currentHand, ledCard, trump]);

  const dealerDiscardChoices: Card[] = useMemo(() => {
    if (state.phase !== 'discard' || state.upcard === null) return [];
    return [...state.hands[state.dealer], state.upcard];
  }, [state]);

  return (
    <div className="min-h-full p-4 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Euchre — Hot-seat</h1>
        <div className="flex gap-3 text-sm">
          <button onClick={onNewGame} className="rounded border border-slate-600 px-3 py-1 hover:bg-slate-700">
            New game
          </button>
          <Link to="/" className="hover:underline self-center">← Lobby</Link>
        </div>
      </header>

      <div className="mb-3 text-xs text-slate-400">
        Hand {state.handNumber} · Phase: <span className="text-slate-200">{state.phase}</span> · Current:{' '}
        <span className="text-slate-200">{SEAT_LABEL[currentSeat]}</span> · Dealer:{' '}
        <span className="text-slate-200">{SEAT_LABEL[state.dealer]}</span>
        {trump && (
          <>
            {' '}· Trump: <span className="text-slate-200">{SUIT_LABEL[trump]}</span>
          </>
        )}
        {state.alone !== null && (
          <>
            {' '}· Alone: <span className="text-amber-300">{SEAT_LABEL[state.alone]}</span>
          </>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded bg-red-900/50 border border-red-700 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 grid-rows-3 gap-3 bg-felt-dark p-4 rounded-2xl min-h-[60vh]">
        {([0, 1, 2, 3] as Seat[]).map((seat) => (
          <SeatPanel
            key={seat}
            seat={seat}
            state={state}
            isCurrent={seat === currentSeat}
            legalCards={seat === currentSeat ? legalForCurrent : []}
            onPlay={
              seat === currentSeat && state.phase === 'play'
                ? onPlay
                : undefined
            }
          />
        ))}

        <div className="col-start-2 row-start-2 flex flex-col items-center justify-center gap-2">
          <TrickArea state={state} />
          {state.upcard && state.upcardStatus !== 'taken' && (
            <UpcardDisplay card={state.upcard} status={state.upcardStatus} />
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <ActionArea
          state={state}
          dealerDiscardChoices={dealerDiscardChoices}
          onPass={onPass}
          onOrderUp={onOrderUp}
          onCall={onCall}
          onDiscard={onDiscard}
          onNextHand={onNextHand}
          onNewGame={onNewGame}
        />
        <ScorePanel
          team0={state.scores[0]}
          team1={state.scores[1]}
          trumpSuit={trump ? SUIT_LABEL[trump] : undefined}
          makerTeam={state.maker !== null ? teamOf(state.maker) : undefined}
        />
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Hot-seat shows all hands face-up — pass the device around or play it solo as a rule-engine sandbox.
      </p>
    </div>
  );
}

interface SeatPanelProps {
  seat: Seat;
  state: EuchreState;
  isCurrent: boolean;
  legalCards: Card[];
  onPlay?: (card: Card) => void;
}

function SeatPanel({ seat, state, isCurrent, legalCards, onPlay }: SeatPanelProps) {
  const cards = state.hands[seat];
  const tricks = state.tricksWon[teamOf(seat)];
  return (
    <div
      className={`${SEAT_POSITION[seat]} rounded-xl border-2 p-2 bg-slate-900/60 ${
        isCurrent ? 'border-emerald-400' : 'border-slate-700'
      }`}
    >
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="font-semibold">
          {SEAT_LABEL[seat]} {state.dealer === seat && <span className="text-amber-300">(D)</span>}
        </span>
        <span className="text-slate-400">team {teamOf(seat)} · {tricks}t</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {cards.length === 0 ? (
          <span className="text-xs text-slate-500 italic">empty</span>
        ) : (
          cards.map((c) => (
            <CardButton
              key={c}
              card={c}
              legal={legalCards.includes(c)}
              onClick={onPlay && legalCards.includes(c) ? () => onPlay(c) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TrickArea({ state }: { state: EuchreState }) {
  if (state.phase === 'game_complete') {
    const winner = state.scores[0] >= 10 ? 0 : 1;
    return (
      <div className="text-center">
        <div className="text-2xl font-bold text-emerald-300">Game over</div>
        <div className="text-sm text-slate-300">Team {winner} wins {state.scores[winner]}–{state.scores[1 - winner as 0 | 1]}</div>
      </div>
    );
  }
  if (state.phase === 'hand_complete') {
    return (
      <div className="text-center">
        <div className="text-lg font-semibold text-slate-200">Hand complete</div>
        <div className="text-sm text-slate-400">{state.scores[0]}–{state.scores[1]}</div>
      </div>
    );
  }
  if (state.trick.length === 0) {
    return <div className="text-xs text-slate-500 italic">— trick —</div>;
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      {state.trick.map((p) => (
        <div key={p.seat} className="flex flex-col items-center">
          <span className="text-[10px] text-slate-400">{SEAT_LABEL[p.seat]}</span>
          <CardButton card={p.card} legal />
        </div>
      ))}
    </div>
  );
}

function UpcardDisplay({ card, status }: { card: Card; status: 'face_up' | 'turned_down' | 'taken' }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] text-slate-400 uppercase">{status.replace('_', ' ')}</span>
      <CardButton card={card} legal={status === 'face_up'} />
    </div>
  );
}

interface ActionAreaProps {
  state: EuchreState;
  dealerDiscardChoices: Card[];
  onPass: () => void;
  onOrderUp: (alone: boolean) => void;
  onCall: (suit: Suit, alone: boolean) => void;
  onDiscard: (card: Card) => void;
  onNextHand: () => void;
  onNewGame: () => void;
}

function ActionArea({
  state,
  dealerDiscardChoices,
  onPass,
  onOrderUp,
  onCall,
  onDiscard,
  onNextHand,
  onNewGame,
}: ActionAreaProps) {
  if (state.phase === 'bid_round_1' && state.upcard) {
    return (
      <BidPanel
        round={1}
        upcardSuit={suitOf(state.upcard)}
        isDealer={state.current === state.dealer}
        onPass={onPass}
        onOrderUp={onOrderUp}
      />
    );
  }
  if (state.phase === 'bid_round_2' && state.upcard) {
    return (
      <BidPanel
        round={2}
        excludedSuit={suitOf(state.upcard)}
        isDealer={state.current === state.dealer}
        onPass={onPass}
        onCall={onCall}
      />
    );
  }
  if (state.phase === 'discard') {
    return (
      <div className="rounded bg-slate-800/90 p-3 text-sm">
        <p className="mb-2">
          {SEAT_LABEL[state.dealer]} (dealer) must discard one card.
        </p>
        <div className="flex flex-wrap gap-1">
          {dealerDiscardChoices.map((c) => (
            <CardButton key={c} card={c} legal onClick={() => onDiscard(c)} />
          ))}
        </div>
      </div>
    );
  }
  if (state.phase === 'play') {
    const trump = state.trump;
    return (
      <div className="rounded bg-slate-800/90 p-3 text-sm">
        <p>
          {SEAT_LABEL[state.current]} to play.
          {state.ledCard && trump !== null && (
            <>
              {' '}Led: <strong>{cardLabel(state.ledCard)}</strong> ({SUIT_LABEL[effectiveSuit(state.ledCard, trump)]}).
            </>
          )}
        </p>
        <p className="text-xs text-slate-400 mt-1">Click a highlighted card in their hand.</p>
      </div>
    );
  }
  if (state.phase === 'hand_complete') {
    return (
      <div className="rounded bg-slate-800/90 p-3 text-sm flex items-center gap-3">
        <span>Hand complete.</span>
        <button onClick={onNextHand} className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1">
          Next hand
        </button>
      </div>
    );
  }
  if (state.phase === 'game_complete') {
    return (
      <div className="rounded bg-slate-800/90 p-3 text-sm flex items-center gap-3">
        <span>Game over.</span>
        <button onClick={onNewGame} className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1">
          Play again
        </button>
      </div>
    );
  }
  return null;
}

function CardButton({
  card,
  legal,
  onClick,
}: {
  card: Card;
  legal: boolean;
  onClick?: () => void;
}) {
  const suit = suitOf(card);
  const rank = rankOf(card);
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`flex h-16 w-12 flex-col items-center justify-between rounded border-2 bg-white px-1 py-0.5 ${
        isRed(suit) ? 'text-red-600' : 'text-black'
      } ${
        onClick
          ? 'border-emerald-400 hover:-translate-y-1 transition cursor-pointer'
          : legal
          ? 'border-slate-300'
          : 'border-slate-500 opacity-40'
      }`}
    >
      <span className="self-start text-xs font-bold">{RANK_LABEL[rank]}</span>
      <span className="text-lg">{SUIT_LABEL[suit]}</span>
      <span className="self-end text-xs font-bold rotate-180">{RANK_LABEL[rank]}</span>
    </button>
  );
}

function cardLabel(card: Card): string {
  return `${RANK_LABEL[rankOf(card)]}${SUIT_LABEL[suitOf(card)]}`;
}
