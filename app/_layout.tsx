import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

export default function RootLayout() {
  return (
    <>
      <Stack>
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
    </>
  );
}
