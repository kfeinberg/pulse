const VOTES_KEY = 'event_votes';

export type VoteType = 'up' | 'down' | null;

export function getAllVotes(): Record<string, VoteType> {
  try {
    const raw = localStorage.getItem(VOTES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setVote(eventId: string, vote: VoteType): void {
  const votes = getAllVotes();
  if (vote === null) {
    delete votes[eventId];
  } else {
    votes[eventId] = vote;
  }
  localStorage.setItem(VOTES_KEY, JSON.stringify(votes));
}
