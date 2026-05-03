export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank = '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

export type GameType = 'euchre';
export type EuchreMode = 'solo' | 'duo';
export type GameStatus = 'lobby' | 'playing' | 'finished' | 'abandoned';
export type UpcardStatus = 'face_up' | 'turned_down' | 'taken';

export interface GameRow {
  id: string;
  status: GameStatus;
  game: string;
  mode: string | null;
  current_seat: number | null;
  team0_score: number;
  team1_score: number;
  turn_deadline: string | null;
  invite_code: string | null;
  leader_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EuchreGameRow {
  game_id: string;
  dealer_seat: number;
  hand_number: number;
  current_trick_id: string | null;
  trump_suit: Suit | null;
  maker_seat: number | null;
  alone_seat: number | null;
  upcard: Card | null;
  upcard_status: UpcardStatus | null;
}

export interface GamePlayerRow {
  game_id: string;
  seat: number;
  user_id: string | null;
  is_bot: boolean;
  missed_turns: number;
}

export interface GameHandRow {
  game_id: string;
  seat: number;
  user_id: string;
  cards: Card[];
  discarded_card: Card | null;
}

export interface TrickRow {
  id: string;
  game_id: string;
  hand_number: number;
  trick_number: number;
  lead_seat: number;
  winner_seat: number | null;
  led_suit: string | null;
  created_at: string;
}

export interface TrickPlayRow {
  trick_id: string;
  seat: number;
  card: Card;
  played_at: string;
}

export interface ProfileRow {
  user_id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
}

export interface RatingRow {
  user_id: string;
  game: string;
  mode: string;
  elo: number;
  games_played: number;
  updated_at: string;
}

export interface FriendRequestRow {
  from_user: string;
  to_user: string;
  created_at: string;
}

export interface FriendshipRow {
  user_a: string;
  user_b: string;
  created_at: string;
}

export interface EloHistoryRow {
  id: string;
  user_id: string;
  game: string;
  mode: string;
  game_id: string;
  rating_before: number;
  rating_after: number;
  delta: number;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Pick<ProfileRow, 'user_id' | 'username'> & Partial<Pick<ProfileRow, 'avatar_url'>>;
        Update: Partial<ProfileRow>;
      };
      ratings: {
        Row: RatingRow;
        Insert: Pick<RatingRow, 'user_id' | 'game' | 'mode'> & Partial<Pick<RatingRow, 'elo' | 'games_played'>>;
        Update: Partial<RatingRow>;
      };
      games: {
        Row: GameRow;
        Insert: Partial<GameRow> & Pick<GameRow, 'game'>;
        Update: Partial<GameRow>;
      };
      euchre_games: {
        Row: EuchreGameRow;
        Insert: Partial<EuchreGameRow> & Pick<EuchreGameRow, 'game_id' | 'dealer_seat'>;
        Update: Partial<EuchreGameRow>;
      };
      game_players: {
        Row: GamePlayerRow;
        Insert: Pick<GamePlayerRow, 'game_id' | 'seat'> & Partial<GamePlayerRow>;
        Update: Partial<GamePlayerRow>;
      };
      game_hands: {
        Row: GameHandRow;
        Insert: GameHandRow;
        Update: Partial<GameHandRow>;
      };
      tricks: {
        Row: TrickRow;
        Insert: Partial<TrickRow>;
        Update: Partial<TrickRow>;
      };
      trick_plays: {
        Row: TrickPlayRow;
        Insert: Partial<TrickPlayRow>;
        Update: Partial<TrickPlayRow>;
      };
      friend_requests: {
        Row: FriendRequestRow;
        Insert: Pick<FriendRequestRow, 'from_user' | 'to_user'>;
        Update: Partial<FriendRequestRow>;
      };
      friendships: {
        Row: FriendshipRow;
        Insert: Pick<FriendshipRow, 'user_a' | 'user_b'>;
        Update: Partial<FriendshipRow>;
      };
      elo_history: {
        Row: EloHistoryRow;
        Insert: Partial<EloHistoryRow>;
        Update: Partial<EloHistoryRow>;
      };
      game_invites: {
        Row: GameInviteRow;
        Insert: Pick<GameInviteRow, 'from_user' | 'to_user' | 'game_id' | 'invite_code'>;
        Update: Partial<GameInviteRow>;
      };
      party_invites: {
        Row: PartyInviteRow;
        Insert: Pick<PartyInviteRow, 'from_user' | 'to_user' | 'party_id' | 'invite_code'>;
        Update: Partial<PartyInviteRow>;
      };
    };
  };
}

export interface GameInviteRow {
  id: string;
  from_user: string;
  to_user: string;
  game_id: string;
  invite_code: string;
  created_at: string;
}

export interface PartyInviteRow {
  id: string;
  from_user: string;
  to_user: string;
  party_id: string;
  invite_code: string;
  created_at: string;
}
