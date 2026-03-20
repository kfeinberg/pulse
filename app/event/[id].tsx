import React from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CATEGORIES } from '@/constants/categories';
import { EventCategory } from '@/types';

export default function EventDetailScreen() {
  const { title, category, description, startTime, endTime, sourceUrl } = useLocalSearchParams<{
    id: string;
    title: string;
    category: EventCategory;
    description: string;
    startTime: string;
    endTime: string;
    sourceUrl: string;
  }>();

  const categoryConfig = CATEGORIES[category as EventCategory];
  const start = new Date(Number(startTime));
  const end = new Date(Number(endTime));

  const formatTime = (date: Date) => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const h = date.getHours();
    const hour = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    const min = date.getMinutes().toString().padStart(2, '0');
    return `${months[date.getMonth()]} ${date.getDate()}, ${hour}:${min} ${ampm}`;
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.emoji}>{categoryConfig?.emoji}</Text>
        <Text style={styles.title}>{title}</Text>
        <View
          style={[
            styles.categoryBadge,
            { backgroundColor: categoryConfig?.backgroundColor },
          ]}
        >
          <Text style={[styles.categoryText, { color: categoryConfig?.color }]}>
            {categoryConfig?.label}
          </Text>
        </View>
        <Text style={styles.timeRange}>
          {formatTime(start)} — {formatTime(end)}
        </Text>
      </View>
      {description ? (
        <View style={styles.descriptionContainer}>
          <Text style={styles.description}>{description}</Text>
        </View>
      ) : null}
      {sourceUrl ? (
        <TouchableOpacity
          style={styles.sourceLink}
          onPress={() => Linking.openURL(sourceUrl)}
          activeOpacity={0.7}
        >
          <Text style={styles.sourceLinkText}>
            {(() => {
              try { return new URL(sourceUrl).hostname.replace('www.', ''); }
              catch { return sourceUrl; }
            })()}{' '}→
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  contentContainer: {
    paddingBottom: 40,
  },
  header: {
    paddingTop: 100,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  emoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    color: '#1a1a1a',
  },
  categoryBadge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    marginBottom: 12,
  },
  categoryText: {
    fontSize: 14,
    fontWeight: '600',
  },
  timeRange: {
    fontSize: 15,
    color: '#666',
  },
  descriptionContainer: {
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  description: {
    fontSize: 16,
    lineHeight: 24,
    color: '#444',
  },
  sourceLink: {
    marginHorizontal: 24,
    marginTop: 20,
    alignItems: 'center',
  },
  sourceLinkText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2a7cff',
  },
});
