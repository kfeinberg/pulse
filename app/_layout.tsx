import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { AuthProvider } from '@/contexts/AuthContext';

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack>
        <Stack.Screen name="sign-in" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="event/[id]"
          options={{
            title: '',
            headerTransparent: true,
            headerBackTitle: 'Map',
          }}
        />
        <Stack.Screen
          name="admin"
          options={{
            title: 'Admin - Add Event',
            presentation: 'modal',
          }}
        />
      </Stack>
      <StatusBar style="auto" />
    </AuthProvider>
  );
}
