import type { Suit } from '../../../lib/database.types';
import { SUIT_LABEL } from '../../../lib/cards-base';

interface BidPanelRound1Props {
  round: 1;
  upcardSuit: Suit;
  isDealer: boolean;
  onPass: () => void;
  onOrderUp: (alone: boolean) => void;
}

interface BidPanelRound2Props {
  round: 2;
  excludedSuit: Suit;
  isDealer: boolean;
  onPass: () => void;
  onCall: (suit: Suit, alone: boolean) => void;
}

type BidPanelProps = BidPanelRound1Props | BidPanelRound2Props;

const SUITS: Suit[] = ['C', 'D', 'H', 'S'];

export function BidPanel(props: BidPanelProps) {
  if (props.round === 1) {
    return (
      <div className="rounded bg-slate-800/90 p-3 text-sm">
        <p className="mb-2">
          Order up <span className="text-lg">{SUIT_LABEL[props.upcardSuit]}</span>?
        </p>
        <div className="flex gap-2">
          <button onClick={() => props.onOrderUp(false)} className="rounded bg-emerald-600 px-3 py-1">
            Order up
          </button>
          <button onClick={() => props.onOrderUp(true)} className="rounded bg-emerald-700 px-3 py-1">
            Alone
          </button>
          <button onClick={props.onPass} className="rounded border border-slate-600 px-3 py-1">
            Pass
          </button>
        </div>
      </div>
    );
  }

  const choices = SUITS.filter((s) => s !== props.excludedSuit);
  return (
    <div className="rounded bg-slate-800/90 p-3 text-sm">
      <p className="mb-2">{props.isDealer ? 'Stick the dealer — you must call.' : 'Call trump or pass.'}</p>
      <div className="flex flex-wrap gap-2">
        {choices.map((s) => (
          <span key={s} className="flex gap-1">
            <button onClick={() => props.onCall(s, false)} className="rounded bg-emerald-600 px-3 py-1">
              {SUIT_LABEL[s]}
            </button>
            <button onClick={() => props.onCall(s, true)} className="rounded bg-emerald-700 px-2 py-1 text-xs">
              alone
            </button>
          </span>
        ))}
        {!props.isDealer && (
          <button onClick={props.onPass} className="rounded border border-slate-600 px-3 py-1">
            Pass
          </button>
        )}
      </div>
    </div>
  );
}
