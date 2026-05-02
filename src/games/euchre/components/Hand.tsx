import type { Card } from '../../../lib/database.types';
import { RANK_LABEL, SUIT_LABEL, isRed, suitOf, rankOf } from '../../../lib/cards-base';

interface HandProps {
  cards: Card[];
  legalCards?: Card[];
  onPlay?: (card: Card) => void;
}

export function Hand({ cards, legalCards, onPlay }: HandProps) {
  return (
    <div className="flex gap-1">
      {cards.map((c) => {
        const suit = suitOf(c);
        const rank = rankOf(c);
        const isLegal = legalCards ? legalCards.includes(c) : true;
        return (
          <button
            key={c}
            disabled={!isLegal || !onPlay}
            onClick={() => onPlay?.(c)}
            className={`flex h-24 w-16 flex-col items-center justify-between rounded-md border-2 bg-white px-1 py-1 shadow ${
              isRed(suit) ? 'text-red-600' : 'text-black'
            } ${isLegal ? 'border-slate-300 hover:-translate-y-1 transition' : 'border-slate-500 opacity-40 cursor-not-allowed'}`}
          >
            <span className="self-start text-sm font-bold">{RANK_LABEL[rank]}</span>
            <span className="text-2xl">{SUIT_LABEL[suit]}</span>
            <span className="self-end text-sm font-bold rotate-180">{RANK_LABEL[rank]}</span>
          </button>
        );
      })}
    </div>
  );
}
