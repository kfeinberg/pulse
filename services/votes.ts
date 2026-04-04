import AsyncStorage from '@react-native-async-storage/async-storage';

const VOTES_KEY = 'event_votes';
const INTERESTED_KEY = 'event_interested';

export type VoteType = 'up' | 'down' | null;

export async function getAllVotes(): Promise<Record<string, VoteType>> {
  const raw = await AsyncStorage.getItem(VOTES_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function getVote(eventId: string): Promise<VoteType> {
  const votes = await getAllVotes();
  return votes[eventId] ?? null;
}

export async function setVote(eventId: string, vote: VoteType): Promise<void> {
  const votes = await getAllVotes();
  if (vote === null) {
    delete votes[eventId];
  } else {
    votes[eventId] = vote;
  }
  await AsyncStorage.setItem(VOTES_KEY, JSON.stringify(votes));
}

export async function getInterestedEvents(): Promise<Record<string, boolean>> {
  const raw = await AsyncStorage.getItem(INTERESTED_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function setInterested(eventId: string, interested: boolean): Promise<void> {
  const all = await getInterestedEvents();
  if (interested) {
    all[eventId] = true;
  } else {
    delete all[eventId];
  }
  await AsyncStorage.setItem(INTERESTED_KEY, JSON.stringify(all));
}

const CONFIRMED_KEY = 'report_confirmed';

export async function getConfirmedReports(): Promise<Record<string, boolean>> {
  const raw = await AsyncStorage.getItem(CONFIRMED_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function setConfirmed(reportId: string, confirmed: boolean): Promise<void> {
  const all = await getConfirmedReports();
  if (confirmed) {
    all[reportId] = true;
  } else {
    delete all[reportId];
  }
  await AsyncStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
}
