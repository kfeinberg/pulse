import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, TouchableOpacity, TextInput } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { signInWithApple, signInWithGoogle } from '@/services/auth';
import { isDisplayNameTaken, setUserProfile } from '@/services/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { router } from 'expo-router';

export default function SignInScreen() {
  const { user, needsProfile, loading: authLoading, setDisplayName, setNeedsProfile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameChecking, setNameChecking] = useState(false);

  useEffect(() => {
    if (user && !needsProfile && !authLoading) {
      router.back();
    }
  }, [user, needsProfile, authLoading]);

  const handleSignIn = async (method: 'apple' | 'google') => {
    setLoading(true);
    setError(null);
    try {
      if (method === 'apple') {
        await signInWithApple();
      } else {
        await signInWithGoogle();
      }
    } catch (e: any) {
      if (e.code === 'ERR_REQUEST_CANCELED' || e.code === 'SIGN_IN_CANCELLED') {
        // User cancelled
      } else {
        setError(e.message || 'Sign in failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSetName = async () => {
    const name = nameInput.trim();
    if (!name || name.length < 2) {
      setNameError('Name must be at least 2 characters');
      return;
    }
    if (name.length > 20) {
      setNameError('Name must be 20 characters or less');
      return;
    }
    setNameChecking(true);
    setNameError(null);
    try {
      const taken = await isDisplayNameTaken(name);
      if (taken) {
        setNameError('That name is already taken');
        setNameChecking(false);
        return;
      }
      await setUserProfile(user!.uid, name, user!.photoURL || undefined);
      setDisplayName(name);
      setNeedsProfile(false);
      router.back();
    } catch (err: any) {
      setNameError(err.message || 'Something went wrong');
    } finally {
      setNameChecking(false);
    }
  };

  // Show display name step if signed in but no profile
  if (user && needsProfile) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>Pulse</Text>
          <Text style={styles.subtitle}>Choose a display name</Text>
        </View>
        <View style={styles.bottom}>
          <TextInput
            style={styles.nameInput}
            placeholder="Display name"
            placeholderTextColor="rgba(255,255,255,0.4)"
            value={nameInput}
            onChangeText={setNameInput}
            maxLength={20}
            autoFocus
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={handleSetName}
          />
          {nameError && <Text style={styles.error}>{nameError}</Text>}
          <TouchableOpacity
            style={[styles.continueButton, nameChecking && { opacity: 0.6 }]}
            onPress={handleSetName}
            disabled={nameChecking}
            activeOpacity={0.8}
          >
            <Text style={styles.continueText}>
              {nameChecking ? 'Checking...' : 'Continue'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Pulse</Text>
        <Text style={styles.subtitle}>{"See what's happening in NYC right now"}</Text>
      </View>

      <View style={styles.bottom}>
        {error && <Text style={styles.error}>{error}</Text>}

        {loading ? (
          <ActivityIndicator color="#fff" size="large" />
        ) : (
          <View style={styles.buttons}>
            {Platform.OS === 'ios' && (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={() => handleSignIn('apple')}
              />
            )}
            <TouchableOpacity
              style={styles.googleButton}
              onPress={() => handleSignIn('google')}
              activeOpacity={0.8}
            >
              <Text style={styles.googleText}>Sign in with Google</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.skipButton}
              onPress={() => router.back()}
              activeOpacity={0.8}
            >
              <Text style={styles.skipText}>Skip for now</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingTop: 120,
    paddingBottom: 80,
  },
  content: {
    alignItems: 'center',
  },
  title: {
    fontSize: 48,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 18,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 12,
    textAlign: 'center',
  },
  bottom: {
    alignItems: 'center',
  },
  buttons: {
    width: '100%',
    gap: 12,
  },
  appleButton: {
    width: '100%',
    height: 52,
  },
  googleButton: {
    width: '100%',
    height: 52,
    backgroundColor: '#fff',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  googleText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#333',
  },
  skipButton: {
    width: '100%',
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  skipText: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.5)',
  },
  nameInput: {
    width: '100%',
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 12,
    padding: 14,
    fontSize: 18,
    color: '#fff',
    textAlign: 'center',
    marginBottom: 12,
  },
  continueButton: {
    width: '100%',
    height: 52,
    backgroundColor: '#fff',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  continueText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
  },
});
