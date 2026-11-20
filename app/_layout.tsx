import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import 'react-native-reanimated';
import { AuthProvider } from '@/contexts/AuthContext';

// Event reminders carry { eventId }: tapping one opens that event, whether it
// launched the app or arrived while it was running.
function useEventNotificationRedirect() {
  const router = useRouter();
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const eventId = response?.notification.request.content.data?.eventId;
      if (typeof eventId !== 'string' || !eventId) return;
      Notifications.clearLastNotificationResponse();
      router.push({ pathname: '/event/[id]', params: { id: eventId } });
    };
    // A reminder that launched the app: open it once the navigator is mounted.
    const launch = setTimeout(() => open(Notifications.getLastNotificationResponse()), 0);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      clearTimeout(launch);
      subscription.remove();
    };
  }, [router]);
}

export default function RootLayout() {
  useEventNotificationRedirect();
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
