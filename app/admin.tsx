import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import MapView, { Marker, MapPressEvent } from 'react-native-maps';
import { useRouter } from 'expo-router';
import { addEvent } from '@/services/firebase';
import { EventCategory } from '@/types';
import { CATEGORIES, CATEGORY_LIST, NYC_REGION } from '@/constants/categories';
import { MAP_STYLE } from '@/constants/mapStyle';

export default function AdminScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('popup');
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [startTime, setStartTime] = useState(new Date());
  const [endTime, setEndTime] = useState(
    new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours from now
  );
  const [submitting, setSubmitting] = useState(false);
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ description: string; place_id: string }>>([]);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapRef = React.useRef<MapView>(null);

  const apiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

  const handleMapPress = (e: MapPressEvent) => {
    setLocation(e.nativeEvent.coordinate);
    setAddress('');
    setSuggestions([]);
  };

  const handleAddressChange = (text: string) => {
    setAddress(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text.trim())}&location=40.7128,-74.0060&radius=50000&key=${apiKey}`
        );
        const data = await res.json();
        if (data.predictions) {
          setSuggestions(data.predictions.slice(0, 5));
        }
      } catch {}
    }, 300);
  };

  const handleSuggestionSelect = async (placeId: string, description: string) => {
    setAddress(description);
    setSuggestions([]);
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry&key=${apiKey}`
      );
      const data = await res.json();
      if (data.result?.geometry?.location) {
        const { lat, lng } = data.result.geometry.location;
        const coord = { latitude: lat, longitude: lng };
        setLocation(coord);
        mapRef.current?.animateToRegion({
          ...coord,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }, 500);
      }
    } catch {
      Alert.alert('Error', 'Failed to get location for that address.');
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      Alert.alert('Error', 'Please enter a title.');
      return;
    }
    if (!location) {
      Alert.alert('Error', 'Please tap the map to set a location.');
      return;
    }
    if (endTime <= startTime) {
      Alert.alert('Error', 'End time must be after start time.');
      return;
    }

    setSubmitting(true);
    try {
      await addEvent({
        title: title.trim(),
        description: description.trim(),
        category,
        latitude: location.latitude,
        longitude: location.longitude,
        startTime,
        endTime,
      });
      Alert.alert('Success', 'Event created!', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to create event.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.label}>Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="e.g., Free Pizza in Washington Sq Park"
        />

        <Text style={styles.label}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Additional details..."
          multiline
          numberOfLines={3}
        />

        <Text style={styles.label}>Category</Text>
        <View style={styles.categoryRow}>
          {CATEGORY_LIST.map((cat) => {
            const config = CATEGORIES[cat];
            const selected = category === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.categoryButton,
                  {
                    backgroundColor: selected
                      ? config.color
                      : config.backgroundColor,
                  },
                ]}
                onPress={() => setCategory(cat)}
              >
                <Text style={styles.categoryEmoji}>{config.emoji}</Text>
                <Text
                  style={[
                    styles.categoryLabel,
                    { color: selected ? '#fff' : config.color },
                  ]}
                >
                  {config.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.label}>Location</Text>
        <View style={styles.autocompleteContainer}>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={handleAddressChange}
            placeholder="Search for a place"
            returnKeyType="search"
          />
          {suggestions.length > 0 && (
            <View style={styles.suggestionsContainer}>
              {suggestions.map((s) => (
                <TouchableOpacity
                  key={s.place_id}
                  style={styles.suggestionItem}
                  onPress={() => handleSuggestionSelect(s.place_id, s.description)}
                >
                  <Text style={styles.suggestionText} numberOfLines={1}>{s.description}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
        <Text style={styles.orText}>or tap the map</Text>
        <View style={styles.mapContainer}>
          <MapView
            ref={mapRef}
            style={styles.miniMap}
            initialRegion={NYC_REGION}
            customMapStyle={MAP_STYLE}
            onPress={handleMapPress}
          >
            {location && (
              <Marker
                coordinate={location}
                pinColor={CATEGORIES[category].color}
              />
            )}
          </MapView>
          {location && (
            <Text style={styles.coords}>
              {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
            </Text>
          )}
        </View>

        <Text style={styles.label}>Start Time</Text>
        <DateTimePicker
          value={startTime}
          mode="datetime"
          display="default"
          onChange={(_, date) => date && setStartTime(date)}
          style={styles.picker}
        />

        <Text style={styles.label}>End Time</Text>
        <DateTimePicker
          value={endTime}
          mode="datetime"
          display="default"
          onChange={(_, date) => date && setEndTime(date)}
          style={styles.picker}
        />

        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          <Text style={styles.submitButtonText}>
            {submitting ? 'Creating...' : 'Create Event'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    letterSpacing: -0.3,
    backgroundColor: '#fafafa',
  },
  multiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  categoryButton: {
    width: '30%',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  categoryEmoji: {
    fontSize: 24,
    marginBottom: 4,
  },
  categoryLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  autocompleteContainer: {
    zIndex: 1,
  },
  suggestionsContainer: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderTopWidth: 0,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    marginTop: -4,
  },
  suggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  suggestionText: {
    fontSize: 14,
    color: '#333',
  },
  orText: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
    marginVertical: 6,
  },
  mapContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  miniMap: {
    height: 200,
  },
  coords: {
    textAlign: 'center',
    paddingVertical: 6,
    fontSize: 12,
    color: '#888',
    backgroundColor: '#f5f5f5',
  },
  picker: {
    alignSelf: 'flex-start',
  },
  submitButton: {
    backgroundColor: '#333',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});
