export function PrivacyPolicy() {
  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <div style={styles.header}>
          <a href="/" style={styles.backLink}>&larr; Back to Pulse</a>
          <h1 style={styles.title}>Privacy Policy</h1>
          <p style={styles.lastUpdated}>Last updated: October 6, 2026</p>
        </div>

        <section style={styles.section}>
          <h2 style={styles.heading}>1. Information We Collect</h2>
          <p style={styles.text}>
            <strong>Account Information:</strong> When you sign in with Apple or Google, we receive your name, email address, and profile photo. You also choose a display name that is visible to other users.
          </p>
          <p style={styles.text}>
            <strong>Location Data:</strong> With your permission, we access your device's location to show nearby events on the map and calculate distances. We do not store your location on our servers.
          </p>
          <p style={styles.text}>
            <strong>User-Generated Content:</strong> Comments you post on events, reports you drop on the map, and votes or interest markers you submit are stored to provide the service.
          </p>
          <p style={styles.text}>
            <strong>Push Notification Tokens:</strong> If you opt in to notifications, we store your device's push token to send event reminders.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>2. How We Use Your Information</h2>
          <p style={styles.text}>We use your information to:</p>
          <ul style={styles.list}>
            <li>Display your display name and profile photo alongside your comments and reports</li>
            <li>Show events and reports near your current location</li>
            <li>Send push notification reminders for events you mark as interested</li>
            <li>Aggregate anonymous vote counts on events and reports</li>
          </ul>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>3. Data Sharing</h2>
          <p style={styles.text}>
            We do not sell your personal information. Your data is shared only as follows:
          </p>
          <ul style={styles.list}>
            <li><strong>Public content:</strong> Your display name, comments, and reports are visible to all users of the app</li>
            <li><strong>Service providers:</strong> We use Firebase (Google) for authentication, data storage, and hosting, and Expo for push notifications. These providers process data on our behalf</li>
          </ul>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>4. Data Retention</h2>
          <p style={styles.text}>
            User reports automatically expire and are deleted after 4 hours. Events are removed after they end. Your account information and comments are retained until you request deletion.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>5. Your Rights</h2>
          <p style={styles.text}>You can:</p>
          <ul style={styles.list}>
            <li>Sign out at any time to stop providing data</li>
            <li>Deny location permissions to use the app without location features</li>
            <li>Delete your account and associated data directly from the profile menu in the app</li>
          </ul>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>6. Children's Privacy</h2>
          <p style={styles.text}>
            Pulse is not directed at children under 13. We do not knowingly collect personal information from children under 13.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>7. Changes to This Policy</h2>
          <p style={styles.text}>
            We may update this policy from time to time. We will notify users of material changes through the app.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.heading}>8. Contact Us</h2>
          <p style={styles.text}>
            If you have questions about this privacy policy or want to request data deletion, contact us at{' '}
            <a href="mailto:kalli.feinberg@gmail.com" style={styles.link}>kalli.feinberg@gmail.com</a>.
          </p>
        </section>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100%',
    backgroundColor: '#111',
    color: '#fff',
    padding: '40px 20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  content: {
    maxWidth: 640,
    margin: '0 auto',
  },
  header: {
    marginBottom: 32,
  },
  backLink: {
    color: '#2a7cff',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 500,
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    marginTop: 16,
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  lastUpdated: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 14,
  },
  section: {
    marginBottom: 28,
  },
  heading: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 10,
  },
  text: {
    fontSize: 15,
    lineHeight: '24px',
    color: 'rgba(255,255,255,0.8)',
    marginBottom: 8,
  },
  list: {
    paddingLeft: 20,
    fontSize: 15,
    lineHeight: '26px',
    color: 'rgba(255,255,255,0.8)',
  },
  link: {
    color: '#2a7cff',
    textDecoration: 'none',
  },
};
