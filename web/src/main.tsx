import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PrivacyPolicy } from './PrivacyPolicy';

const path = window.location.pathname;
const Root = path === '/privacy' ? PrivacyPolicy : App;

createRoot(document.getElementById('root')!).render(<Root />);
