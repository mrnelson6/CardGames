import type { ReactNode } from 'react';

interface SeatProps {
  position: 'south' | 'west' | 'north' | 'east';
  children?: ReactNode;
}

const POSITION_CLASS: Record<SeatProps['position'], string> = {
  south: 'absolute bottom-2 left-1/2 -translate-x-1/2',
  north: 'absolute top-2 left-1/2 -translate-x-1/2',
  west: 'absolute left-2 top-1/2 -translate-y-1/2',
  east: 'absolute right-2 top-1/2 -translate-y-1/2',
};

export function TableSeat({ position, children }: SeatProps) {
  return <div className={POSITION_CLASS[position]}>{children}</div>;
}

interface TableProps {
  children: ReactNode;
}

export function Table({ children }: TableProps) {
  return (
    <div className="relative h-[80vh] w-full rounded-3xl bg-felt-dark border-8 border-felt-dark/80 shadow-inner">
      {children}
    </div>
  );
}
