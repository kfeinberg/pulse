const VOTES_KEY = 'event_votes';
const INTERESTED_KEY = 'event_interested';

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

export function getInterestedEvents(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(INTERESTED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setInterested(eventId: string, interested: boolean): void {
  const all = getInterestedEvents();
  if (interested) {
    all[eventId] = true;
  } else {
    delete all[eventId];
  }
  localStorage.setItem(INTERESTED_KEY, JSON.stringify(all));
}

const CONFIRMED_KEY = 'report_confirmed';

export function getConfirmedReports(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CONFIRMED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setConfirmed(reportId: string, confirmed: boolean): void {
  const all = getConfirmedReports();
  if (confirmed) {
    all[reportId] = true;
  } else {
    delete all[reportId];
  }
  localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
}
