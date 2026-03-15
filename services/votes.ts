import AsyncStorage from '@react-native-async-storage/async-storage';

const VOTES_KEY = 'event_votes';

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
