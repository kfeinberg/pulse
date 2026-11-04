import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PrivacyPolicy } from './PrivacyPolicy';
import { SignIn } from './SignIn';
import { EventDetail } from './EventDetail';
import { Admin } from './Admin';
import { AuthProvider } from './contexts/AuthContext';

function Root() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  let Screen = App;
  if (path === '/privacy') Screen = PrivacyPolicy;
  else if (path === '/sign-in') Screen = SignIn;
  else if (path === '/admin') Screen = Admin;
  else if (/^\/event\/[^/]+$/.test(path)) Screen = EventDetail;

  return (
    <AuthProvider>
      <Screen key={path + window.location.search} />
    </AuthProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
