import { AnimatePresence, motion } from 'framer-motion';
import type { ChatMessage } from './useChat';

// Bubble side relative to the seat panel (positions edge of bubble against
// edge of panel + a small overlap toward the centre of the table).
//   south  → above the panel, tail down
//   north  → below the panel, tail up
//   west   → to the right of the panel, tail left
//   east   → to the left of the panel, tail right
type ViewerOffset = 0 | 1 | 2 | 3;

const BUBBLE_POS: Record<ViewerOffset, string> = {
  0: 'left-1/2 -translate-x-1/2 bottom-full mb-2',          // south: above
  1: 'top-1/2 -translate-y-1/2 left-full ml-2',             // west:  right
  2: 'left-1/2 -translate-x-1/2 top-full mt-2',             // north: below
  3: 'top-1/2 -translate-y-1/2 right-full mr-2',            // east:  left
};

const TAIL_POS: Record<ViewerOffset, string> = {
  0: 'left-1/2 -translate-x-1/2 -bottom-1',
  1: 'top-1/2 -translate-y-1/2 -left-1',
  2: 'left-1/2 -translate-x-1/2 -top-1',
  3: 'top-1/2 -translate-y-1/2 -right-1',
};

interface Props {
  message: ChatMessage | null;
  /** 0=south 1=west 2=north 3=east, viewer-relative */
  viewerOffset: ViewerOffset;
}

export function SeatChatBubble({ message, viewerOffset }: Props) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key={message.id}
          initial={{ opacity: 0, scale: 0.6, y: viewerOffset === 0 ? 10 : viewerOffset === 2 ? -10 : 0 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.7 }}
          transition={{ type: 'spring', stiffness: 380, damping: 26 }}
          className={`absolute z-30 pointer-events-none ${BUBBLE_POS[viewerOffset]}`}
        >
          <div className="relative bg-white text-slate-900 rounded-2xl shadow-xl px-3 py-1.5 max-w-[180px] whitespace-nowrap text-sm font-medium">
            {message.kind === 'emoji' ? (
              <motion.span
                key={`${message.id}-emoji`}
                animate={{
                  scale: [1, 1.25, 1, 1.15, 1],
                  rotate: [0, -6, 6, -3, 0],
                }}
                transition={{ duration: 1.2, repeat: Infinity, repeatDelay: 0.4 }}
                className="text-2xl leading-none inline-block"
              >
                {message.content}
              </motion.span>
            ) : (
              <span>{message.content}</span>
            )}
            <span
              aria-hidden
              className={`absolute w-2.5 h-2.5 bg-white rotate-45 ${TAIL_POS[viewerOffset]}`}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
